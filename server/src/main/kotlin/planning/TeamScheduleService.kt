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

/** The milestone columns the batch decides on, as stored at the lock. */
private class StoredSchedule(val teamId: UInt, val span: MilestoneSpan?, val scheduleRevision: Long)

/**
 * The team-scoped schedule write (v0.8.0): the batch accept of an auto-proposal, "N schedule PUTs in ONE plan write under the TEAM's
 * guard". It is the second writer of `milestones.start_date/end_date/schedule_revision` beside [MilestoneService.schedule] and keeps its
 * per-milestone optimistic concurrency, but a stale item is SKIPPED (the rest are written) instead of failing the call.
 */
class TeamScheduleService(private val database: R2dbcDatabase) {
    /**
     * Applies [request] under the plan lock, in this order: the whole-batch shape is validated (400, before the lock) -> the team is
     * re-read and its row locked `FOR SHARE` (gone = 404) -> [guard] (the manager as of the lock: 403, nothing written, no bump) ->
     * `expectedRevision` above the current plan revision (a view from the future) is a 409 `stale-revision` for the WHOLE batch -> the
     * working calendar is read once -> per item, in body order, the first of: no active milestone [SkippedScheduleReason.GONE], not on
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
            val calendar = loadWorkingCalendar()
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
                        accepted += AcceptedSchedule(item.milestoneId, row.span, item.span)
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
            .select(milestones.id, milestones.teamId, milestones.startDate, milestones.endDate, milestones.scheduleRevision)
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
                )
            }
    }
}
