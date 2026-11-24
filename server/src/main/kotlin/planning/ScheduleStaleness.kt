package ch.nokillswit.planning

import ch.nokillswit.authz.ConflictException
import ch.nokillswit.infra.db.active
import kotlinx.coroutines.flow.toList
import org.jetbrains.exposed.v1.core.*
import org.jetbrains.exposed.v1.r2dbc.select

/**
 * The `409 stale-revision` of a write that carries a plan revision from the future: [expectedRevision] is above the plan's, so the
 * client's view cannot be of this plan (shared by the batch accepts and the proposal save).
 */
internal fun staleRevision(expectedRevision: Long, advice: String) = ConflictException(
    "The view revision $expectedRevision is ahead of the plan; $advice",
    problemType = STALE_REVISION_PROBLEM,
)

/**
 * Whether an ACTIVE milestone of ANY of [teamIds] that is not among [batchIds] was scheduled after [expectedRevision] (a colleague's
 * drag, or a new milestone), inside the caller's transaction. "Active" is `milestoneChain`'s: the milestone and its project, program
 * and work stream. The cross-team accept passes the items it writes as [batchIds]; the proposal save and a saved proposal's `state`
 * pass none (any later reschedule of a run team's milestone counts).
 */
internal suspend fun reschedulesOutsideBatch(teamIds: Collection<UInt>, expectedRevision: Long, batchIds: List<UInt>): Boolean {
    val milestones = MilestoneService.Milestones
    val projects = ProjectService.Projects
    val programs = ProgramService.Programs
    val streams = WorkStreamService.WorkStreams
    return milestones.innerJoin(projects, { milestones.projectId }, { projects.id })
        .innerJoin(programs, { projects.programId }, { programs.id })
        .innerJoin(streams, { programs.workStreamId }, { streams.id })
        .select(milestones.id)
        .where {
            val outside = if (batchIds.isEmpty()) Op.TRUE else milestones.id notInList batchIds
            (milestones.teamId inList teamIds) and (milestones.scheduleRevision greater expectedRevision) and outside and
                milestones.active() and projects.active() and programs.active() and streams.active()
        }
        .limit(1)
        .toList()
        .isNotEmpty()
}
