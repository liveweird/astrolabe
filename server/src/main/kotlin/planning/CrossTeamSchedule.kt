package ch.nokillswit.planning

import io.ktor.server.plugins.BadRequestException
import kotlinx.serialization.Serializable

/** The most teams one cross-team run may name (the sample plan has 15; the cap bounds the document and the passes). */
const val MAX_RUN_TEAMS = 50

/**
 * `POST /schedule-proposals` (1.8.0): the ONE proposal over several teams. [asOf] means what it means for the per-team proposal
 * ([ScheduleProposalRequest]); [teamIds] is the run's team SET (1..[MAX_RUN_TEAMS], each once), in any order - the server places the
 * teams in dependency order, so the request order never matters.
 */
@Serializable
data class CrossTeamProposalRequest(val asOf: String, val teamIds: List<UInt>)

/**
 * One team's block of a [CrossTeamProposal]: the per-team proposal's document ([ScheduleProposal]) minus what the run owns (the
 * revision, `asOf` and the hash). [dependencies] are the links touching THIS team (a link between two run teams is listed in both
 * blocks) whose verdict is or was violated over the WHOLE run's final dates; [weeks] is this team's load after accepting every move
 * of the run.
 */
@Serializable
data class CrossTeamProposalTeam(
    val teamId: UInt,
    val name: String,
    val moves: List<ScheduleProposalMove>,
    val unchanged: List<UInt>,
    val unplaced: List<ScheduleProposalUnplaced>,
    val pinned: List<UInt>,
    val weeks: List<WeekLoadView>,
    val weeksTruncated: Boolean,
    val dependencies: List<ScheduleProposalLink>,
)

/**
 * A project whose derived span the run would change (1.33.0, [SpanKernels.projectSpanChanges]): [before] its span now (null = it has no
 * scheduled milestone yet), [after] over EVERY milestone of the project (the run teams' proposed dates, the stored ones elsewhere),
 * [endShiftDays] the change of its end in working days (later positive; null when [before] is).
 */
@Serializable
data class ScheduleProposalProject(
    val projectId: UInt,
    val name: String,
    val before: DateSpan?,
    val after: DateSpan,
    val endShiftDays: Int?,
)

/**
 * The run's answer: a COMPUTATION, nothing is stored. [revision] is the plan revision of the snapshot (the accept's `expectedRevision`),
 * [passes] the passes the kernel made, [settled] whether another pass would reproduce every result (false = the pass limit was hit and
 * the last pass's dates stand), [teams] in PLACEMENT order (the order the kernel placed them: the one list, no separate `order`) and
 * [projects] the projects whose derived span the run would change, ascending by id (no default: a stored row without it is another
 * format) and [scopeHash] the fingerprint of the run's inputs the milestones' own schedule revisions do not cover (`ScheduleScope.kt`,
 * [runScope]).
 */
@Serializable
data class CrossTeamProposal(
    val revision: Long,
    val asOf: String,
    val passes: Int,
    val settled: Boolean,
    val teams: List<CrossTeamProposalTeam>,
    val projects: List<ScheduleProposalProject>,
    val scopeHash: String,
)

/** A team whose proposed moves the caller may accept (`GET /schedule-proposals/teams`). */
@Serializable
data class ProposalTeam(val id: UInt, val name: String)

/** The bounded teams whose moves the caller may accept; [truncated] says more such teams exist. */
@Serializable
data class ProposalTeamList(val items: List<ProposalTeam>, val truncated: Boolean)

/**
 * `POST /schedule-proposals/accept` (1.8.0): the accept of a [CrossTeamProposal], N teams' schedule PUTs in ONE plan write. [teamIds] is
 * the run's team SET (the proposal's request, not derived from the items: a team whose moves were all unticked is still a premise of
 * the run and must be checked and locked), [expectedRevision] the proposal's `revision` and [scopeHash] its `scopeHash` - REQUIRED,
 * the run's whole point is the cross-team premise. [acceptTeamIds] (1.33.0) are the teams whose moves the caller accepts: a subset of
 * [teamIds] (absent = all of them, the 1.8.0 contract); the guard runs over them alone, an item of any other team is skipped
 * `NOT_ON_TEAM`, and the scope token and the sweep still cover the whole run. [items] are the ticked moves of every team
 * ([TeamScheduleBatchItem], at most [MAX_RUN_SCHEDULE_ITEMS]); the answer is the per-team batch's [TeamScheduleBatchResponse].
 */
@Serializable
data class CrossTeamAcceptRequest(
    val expectedRevision: Long,
    val scopeHash: String,
    val teamIds: List<UInt>,
    val items: List<TeamScheduleBatchItem>,
    val acceptTeamIds: List<UInt>? = null,
)

/**
 * The run's team-set rule, checked right after the body decodes and BEFORE the guard (the guard needs well-formed ids): between one and
 * [MAX_RUN_TEAMS] teams, none twice (a 400 otherwise). Returns the ids as given.
 */
fun validateTeamIds(ids: List<UInt>): List<UInt> {
    if (ids.isEmpty() || ids.size > MAX_RUN_TEAMS || ids.toSet().size != ids.size) {
        throw BadRequestException("teamIds must list between 1 and $MAX_RUN_TEAMS teams, each once")
    }
    return ids
}

/**
 * The accept set's rule, checked after [validateTeamIds] and BEFORE the guard (the guard runs over it): absent = [teamIds]; given,
 * between one and [MAX_RUN_TEAMS] teams, none twice, each one of [teamIds] (a 400 otherwise). Returns the set to guard and write.
 */
fun validateAcceptTeamIds(acceptTeamIds: List<UInt>?, teamIds: List<UInt>): List<UInt> {
    if (acceptTeamIds == null) return teamIds
    if (acceptTeamIds.isEmpty() || acceptTeamIds.size > MAX_RUN_TEAMS || acceptTeamIds.toSet().size != acceptTeamIds.size) {
        throw BadRequestException("acceptTeamIds must list between 1 and $MAX_RUN_TEAMS teams, each once")
    }
    if (!teamIds.containsAll(acceptTeamIds)) throw BadRequestException("acceptTeamIds must each be one of teamIds")
    return acceptTeamIds
}

/**
 * `POST /schedule-proposals/check` (1.8.0): the ticked subset of a run (or of one team's proposal) as hypothetical dates. [teamIds] is
 * the run's team SET (as the run's: any login may ask); [items] the ticked moves - each milestone of one of those teams,
 * once, [TeamScheduleBatchItem] (the null pair = unschedule) - applied over the STORED spans of those teams. There is no `asOf`: no
 * verdict reads it.
 */
@Serializable
data class ScheduleCheckRequest(val teamIds: List<UInt>, val items: List<TeamScheduleBatchItem>)

/**
 * One run team's verdicts for the hypothetical dates: [weeks] its load with the items applied (at most `MAX_LOAD_WEEKS`),
 * [dependencies] the links touching it that are or were VIOLATED (as [CrossTeamProposalTeam.dependencies]; a link between two run teams
 * is in both blocks).
 */
@Serializable
data class ScheduleCheckTeam(
    val teamId: UInt,
    val weeks: List<WeekLoadView>,
    val weeksTruncated: Boolean,
    val dependencies: List<ScheduleProposalLink>,
)

/** The check's answer: a COMPUTATION, one block per requested team in the REQUEST's order. */
@Serializable
data class ScheduleCheckResponse(val teams: List<ScheduleCheckTeam>)

/**
 * The check's item rules, checked after the teams' 404 (the team set is already shaped, [validateTeamIds]): 1..[MAX_RUN_SCHEDULE_ITEMS]
 * items, no milestone twice, each through [validateSchedule] (a 400 names the failing item's index).
 */
fun validateScheduleCheck(request: ScheduleCheckRequest): List<ValidatedBatchItem> =
    validateItemList(request.items, MAX_RUN_SCHEDULE_ITEMS)
