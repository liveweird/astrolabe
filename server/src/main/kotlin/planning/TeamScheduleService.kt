package ch.nokillswit.planning

import ch.nokillswit.authz.ConflictException
import ch.nokillswit.infra.db.active
import ch.nokillswit.infra.time.WorkingCalendar
import ch.nokillswit.teams.TeamGuard
import io.ktor.util.AttributeKey
import kotlinx.coroutines.flow.toList
import org.jetbrains.exposed.v1.core.*
import org.jetbrains.exposed.v1.r2dbc.R2dbcDatabase
import org.jetbrains.exposed.v1.r2dbc.select

val TeamScheduleServiceKey = AttributeKey<TeamScheduleService>("TeamScheduleService")

/** The milestone columns the batch decides on (and audits a cleared pin from), as stored at the lock. */
private class StoredSchedule(val teamId: UInt, val span: MilestoneSpan?, val scheduleRevision: Long, val pinned: Boolean)

/**
 * The team-scoped schedule write (v0.8.0): the batch accept of an auto-proposal, "N schedule PUTs in ONE plan write under the TEAM's
 * guard". It is the second writer of `milestones.start_date/end_date/schedule_revision` beside [MilestoneService.schedule] and keeps its
 * per-milestone optimistic concurrency, but a stale item is SKIPPED (the rest are written) instead of failing the call.
 */
class TeamScheduleService(private val database: R2dbcDatabase) {
    /**
     * Applies [request] under the plan lock, in this order: the whole-batch shape is validated (400, before the lock) -> the team is
     * re-read and its row locked `FOR SHARE` (gone = 404) -> [guard] (the manager as of the lock: 403, nothing written, no bump) ->
     * `expectedRevision` above the current plan revision (a view from the future) is a 409 `stale-revision` for the WHOLE batch -> only
     * when the request carries a `scopeHash`, [requireScopeUnchanged] (a 409 `stale-scope` for the whole batch: the team's plan changed
     * beyond the batch's own milestones) -> the working calendar is read once -> per item, in body order, the first of: no active
     * milestone [SkippedScheduleReason.GONE], not on
     * this team ([SkippedScheduleReason.NOT_ON_TEAM] - a team change keeps `schedule_revision`, so the revision alone would not catch
     * it), a span without a working day of the CURRENT calendar ([SkippedScheduleReason.NO_WORKING_DAY], D2), the milestone's
     * `schedule_revision` above `expectedRevision` ([SkippedScheduleReason.STALE]) skips the item; otherwise the dates are written and
     * `schedule_revision` stamped with the new plan revision. A skipped item never rolls the others back. ONE bump for the batch,
     * whatever was skipped (an all-skipped batch included: the lock was taken and the write ran), so the answered revision is
     * `revision + 1`. No cycle check, no order change.
     */
    suspend fun batch(teamId: UInt, request: TeamScheduleBatchRequest, guard: TeamGuard): TeamBatchOutcome {
        val items = validateBatchRequest(request)
        val write = database.withPlanWrite { revision ->
            lockActiveTeam(teamId)
            guard(teamId)
            if (request.expectedRevision > revision) {
                throw ConflictException(
                    "The view revision ${request.expectedRevision} is ahead of the plan; reload the team",
                    problemType = STALE_REVISION_PROBLEM,
                )
            }
            val snapshot = request.scopeHash?.let { requireScopeUnchanged(teamId, request.expectedRevision, items, it) }
            val calendar = snapshot?.calendar ?: loadWorkingCalendar()
            val stored = storedSchedules(items.map { it.milestoneId })
            val accepted = mutableListOf<AcceptedSchedule>()
            val skipped = mutableListOf<SkippedSchedule>()
            val toWrite = mutableListOf<ValidatedBatchItem>()
            for (item in items) {
                val row = stored[item.milestoneId]
                val reason = skipReason(row, item.span, teamId, request.expectedRevision, calendar)
                when {
                    reason != null -> skipped += SkippedSchedule(item.milestoneId, reason)
                    // A null reason means a stored row (the GONE verdict is the only one without it).
                    row != null -> {
                        // An unscheduling item clears a pin in the same statement (`writeSchedules`); the route audits it.
                        accepted += AcceptedSchedule(item.milestoneId, row.span, item.span, pinCleared = row.pinned && item.span == null)
                        toWrite += item
                    }
                }
            }
            // The decisions above read only; the writes are multi-row statements, not a round trip per item under the global lock.
            writeSchedules(toWrite, revision + 1)
            accepted to skipped
        }
        return TeamBatchOutcome(write.revision, write.value.first, write.value.second)
    }

    /**
     * The scope check of a batch that carries the proposal's [hash] (under the plan lock, nothing written yet): the same
     * [loadScheduleSnapshot] and [ScheduleSnapshot.scopeHash] the proposal used must still give [hash], and no OTHER milestone of the
     * team (one the batch does not name) may carry a `schedule_revision` above [expectedRevision] - the team's own spans are not in the
     * hash, so that sweep is what notices a colleague's drag of an unticked or in-progress milestone, while a dragged BATCH item stays
     * the per-item STALE. Either failure is a 409 `stale-scope` and the transaction rolls back. Returns the snapshot (its calendar is
     * the batch's).
     */
    private suspend fun requireScopeUnchanged(
        teamId: UInt,
        expectedRevision: Long,
        items: List<ValidatedBatchItem>,
        hash: String,
    ): ScheduleSnapshot {
        // The fingerprint reads no team name, so the rows are loaded with an empty one (the proposal's wire rows are the only readers).
        val snapshot = loadScheduleSnapshot(teamId, "")
        val changed = snapshot.scopeHash(teamId) != hash || reschedulesOutsideBatch(teamId, expectedRevision, items.map { it.milestoneId })
        if (changed) {
            throw ConflictException(
                "The team's plan changed since the proposal (another milestone, a pin, a capacity period, a link or a holiday): " +
                    "propose again",
                problemType = STALE_SCOPE_PROBLEM,
            )
        }
        return snapshot
    }

    /** Whether an ACTIVE milestone of the team that is not among [batchIds] was scheduled after [expectedRevision]. */
    private suspend fun reschedulesOutsideBatch(teamId: UInt, expectedRevision: Long, batchIds: List<UInt>): Boolean {
        val milestones = MilestoneService.Milestones
        val projects = ProjectService.Projects
        val programs = ProgramService.Programs
        val streams = WorkStreamService.WorkStreams
        return milestones.innerJoin(projects, { milestones.projectId }, { projects.id })
            .innerJoin(programs, { projects.programId }, { programs.id })
            .innerJoin(streams, { programs.workStreamId }, { streams.id })
            .select(milestones.id)
            .where {
                (milestones.teamId eq teamId) and (milestones.scheduleRevision greater expectedRevision) and
                    (milestones.id notInList batchIds) and milestones.active() and projects.active() and programs.active() and
                    streams.active()
            }
            .limit(1)
            .toList()
            .isNotEmpty()
    }

    private fun skipReason(
        row: StoredSchedule?,
        span: MilestoneSpan?,
        teamId: UInt,
        expectedRevision: Long,
        calendar: WorkingCalendar,
    ): SkippedScheduleReason? = when {
        row == null -> SkippedScheduleReason.GONE
        row.teamId != teamId -> SkippedScheduleReason.NOT_ON_TEAM
        span != null && !calendar.containsWorkingDay(span.start, span.end) -> SkippedScheduleReason.NO_WORKING_DAY
        row.scheduleRevision > expectedRevision -> SkippedScheduleReason.STALE
        else -> null
    }

    /**
     * The milestones among [ids] with their stored team, span and `schedule_revision`; a missing id is absent. "Active" is
     * [milestoneChain]'s: the milestone AND its project, program and work stream, so GONE does not depend on how deletes cascade.
     */
    private suspend fun storedSchedules(ids: List<UInt>): Map<UInt, StoredSchedule> {
        val milestones = MilestoneService.Milestones
        val projects = ProjectService.Projects
        val programs = ProgramService.Programs
        val streams = WorkStreamService.WorkStreams
        return milestones.innerJoin(projects, { milestones.projectId }, { projects.id })
            .innerJoin(programs, { projects.programId }, { programs.id })
            .innerJoin(streams, { programs.workStreamId }, { streams.id })
            .select(
                milestones.id, milestones.teamId, milestones.startDate, milestones.endDate, milestones.scheduleRevision, milestones.pinned,
            )
            .where {
                (milestones.id inList ids) and milestones.active() and projects.active() and programs.active() and streams.active()
            }
            .toList()
            .associate { row ->
                val start = row[milestones.startDate]
                val end = row[milestones.endDate]
                row[milestones.id].value to StoredSchedule(
                    teamId = row[milestones.teamId].value,
                    span = if (start != null && end != null) MilestoneSpan(start, end) else null,
                    scheduleRevision = row[milestones.scheduleRevision],
                    pinned = row[milestones.pinned],
                )
            }
    }
}
