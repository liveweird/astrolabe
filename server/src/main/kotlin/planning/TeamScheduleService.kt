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
 * The schedule batch writer: the team-scoped batch accept of an auto-proposal (v0.8.0), "N schedule PUTs in ONE plan write under the
 * TEAM's guard", and the cross-team accept of a run (1.8.0, [acceptRun]), the same over a SET of teams. It is the second writer of
 * `milestones.start_date/end_date/schedule_revision` beside [MilestoneService.schedule] and keeps its per-milestone optimistic
 * concurrency, but a stale item is SKIPPED (the rest are written) instead of failing the call.
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
            if (request.expectedRevision > revision) throw staleRevision(request.expectedRevision, "reload the team")
            val snapshot = request.scopeHash?.let { requireScopeUnchanged(teamId, request.expectedRevision, items, it) }
            val calendar = snapshot?.calendar ?: loadWorkingCalendar()
            val decided = decideItems(items, setOf(teamId), request.expectedRevision, calendar)
            // The decisions above read only; the writes are multi-row statements, not a round trip per item under the global lock.
            writeSchedules(decided.toWrite, revision + 1)
            decided
        }
        return write.value.outcome(write.revision)
    }

    /**
     * The cross-team accept (1.8.0, `POST /schedule-proposals/accept`): [request]'s items are written in ONE plan write for the run's
     * team SET, ONE revision bump. In this order: the whole-request shape is validated (400, before the lock) -> under the plan lock,
     * every team of the set in ascending id order is re-read and locked `FOR SHARE` ([lockActiveTeam], gone = 404) and re-guarded by
     * [guard] (the caller as of the lock must be ADMIN or the ACTIVE manager of EVERY team: 403, nothing written, no bump) -> the
     * `expectedRevision` above the plan revision is a 409 `stale-revision` -> [requireRunScopeUnchanged] (a 409 `stale-scope`: the
     * run's fingerprint, recomputed with the teams' CURRENT names, differs, or ANY milestone of ANY run team that is not an item was
     * scheduled after `expectedRevision`) -> per item, in body order, the first of GONE / NOT_ON_TEAM (its STORED team is outside the
     * set) / NO_WORKING_DAY / STALE skips it and the rest are written ([decideItems], the per-team batch's rules). An all-skipped
     * accept bumps like the batch. The 409 and 403 are whole-request: the transaction rolls back.
     */
    suspend fun acceptRun(request: CrossTeamAcceptRequest, guard: TeamGuard): TeamBatchOutcome {
        val items = validateCrossTeamAccept(request)
        val teamIds = request.teamIds.sorted()
        val write = database.withPlanWrite { revision ->
            for (teamId in teamIds) {
                lockActiveTeam(teamId)
                guard(teamId)
            }
            if (request.expectedRevision > revision) throw staleRevision(request.expectedRevision, "reload the proposal")
            val snapshot = requireRunScopeUnchanged(teamIds, request.expectedRevision, items, request.scopeHash)
            val decided = decideItems(items, teamIds.toSet(), request.expectedRevision, snapshot.calendar)
            writeSchedules(decided.toWrite, revision + 1)
            decided
        }
        return write.value.outcome(write.revision)
    }

    /** The decisions of one write: what is [accepted] (and [toWrite]), what is [skipped], and every found item's stored team. */
    private class Decided(
        val accepted: List<AcceptedSchedule>,
        val skipped: List<SkippedSchedule>,
        val toWrite: List<ValidatedBatchItem>,
        val storedTeams: Map<UInt, UInt>,
    ) {
        fun outcome(revision: Long) = TeamBatchOutcome(revision, accepted, skipped, storedTeams)
    }

    /**
     * The per-item rules shared by the team batch ([teamIds] = just that team) and the cross-team accept (the run's set), under the
     * lock, reading only: each item gets the first matching [skipReason] or is accepted with its STORED team, span and pin.
     */
    private suspend fun decideItems(
        items: List<ValidatedBatchItem>,
        teamIds: Set<UInt>,
        expectedRevision: Long,
        calendar: WorkingCalendar,
    ): Decided {
        val stored = storedSchedules(items.map { it.milestoneId })
        val accepted = mutableListOf<AcceptedSchedule>()
        val skipped = mutableListOf<SkippedSchedule>()
        val toWrite = mutableListOf<ValidatedBatchItem>()
        for (item in items) {
            val row = stored[item.milestoneId]
            val reason = skipReason(row, item.span, teamIds, expectedRevision, calendar)
            when {
                reason != null -> skipped += SkippedSchedule(item.milestoneId, reason)
                // A null reason means a stored row (the GONE verdict is the only one without it).
                row != null -> {
                    // An unscheduling item clears a pin in the same statement (`writeSchedules`); the route audits it.
                    val cleared = row.pinned && item.span == null
                    accepted += AcceptedSchedule(item.milestoneId, row.teamId, row.span, item.span, pinCleared = cleared)
                    toWrite += item
                }
            }
        }
        return Decided(accepted, skipped, toWrite, stored.mapValues { it.value.teamId })
    }

    private fun staleRevision(expectedRevision: Long, advice: String) = ConflictException(
        "The view revision $expectedRevision is ahead of the plan; $advice",
        problemType = STALE_REVISION_PROBLEM,
    )

    /**
     * The scope check of a run accept ([hash] is the run's, under the plan lock, nothing written yet): the SAME [loadCrossTeamSnapshot]
     * and [CrossTeamSnapshot.scopeHash] the run used, but with the teams' CURRENT names (the names are IN the fingerprint: a blank would
     * never match), must still give [hash]; and no milestone of ANY run team that the accept does not name - the movable ones AND the
     * fixed ones (started, pinned), whose spans are deliberately NOT in the run's hash - may carry a `schedule_revision` above
     * [expectedRevision] ([reschedulesOutsideBatch]: a colleague's drag, or a new milestone). Either is a 409 `stale-scope`. A per-team
     * hash never matches (another definition of "foreign"). Returns the snapshot (its calendar is the accept's).
     */
    private suspend fun requireRunScopeUnchanged(
        teamIds: List<UInt>,
        expectedRevision: Long,
        items: List<ValidatedBatchItem>,
        hash: String,
    ): CrossTeamSnapshot {
        val names = activeTeamNames(teamIds)
        // Every team was locked FOR SHARE in this very transaction (acceptRun), so none can be gone: a mismatch is a bug, not a 404.
        check(names.size == teamIds.size) { "a locked run team vanished: ${teamIds.filter { it !in names }}" }
        val snapshot = loadCrossTeamSnapshot(names)
        if (snapshot.scopeHash() != hash || reschedulesOutsideBatch(teamIds, expectedRevision, items.map { it.milestoneId })) {
            throw ConflictException(
                "The plan changed since the proposal (another milestone of one of the teams, a pin, a capacity period, a link or a " +
                    "holiday): propose again",
                problemType = STALE_SCOPE_PROBLEM,
            )
        }
        return snapshot
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
        val batchIds = items.map { it.milestoneId }
        val changed = snapshot.scopeHash(teamId) != hash || reschedulesOutsideBatch(listOf(teamId), expectedRevision, batchIds)
        if (changed) {
            throw ConflictException(
                "The team's plan changed since the proposal (another milestone, a pin, a capacity period, a link or a holiday): " +
                    "propose again",
                problemType = STALE_SCOPE_PROBLEM,
            )
        }
        return snapshot
    }

    /** Whether an ACTIVE milestone of ANY of [teamIds] that is not among [batchIds] was scheduled after [expectedRevision]. */
    private suspend fun reschedulesOutsideBatch(teamIds: Collection<UInt>, expectedRevision: Long, batchIds: List<UInt>): Boolean {
        val milestones = MilestoneService.Milestones
        val projects = ProjectService.Projects
        val programs = ProgramService.Programs
        val streams = WorkStreamService.WorkStreams
        return milestones.innerJoin(projects, { milestones.projectId }, { projects.id })
            .innerJoin(programs, { projects.programId }, { programs.id })
            .innerJoin(streams, { programs.workStreamId }, { streams.id })
            .select(milestones.id)
            .where {
                (milestones.teamId inList teamIds) and (milestones.scheduleRevision greater expectedRevision) and
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
        teamIds: Set<UInt>,
        expectedRevision: Long,
        calendar: WorkingCalendar,
    ): SkippedScheduleReason? = when {
        row == null -> SkippedScheduleReason.GONE
        row.teamId !in teamIds -> SkippedScheduleReason.NOT_ON_TEAM
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
