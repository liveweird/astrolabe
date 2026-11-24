package ch.nokillswit.planning

import ch.nokillswit.infra.validation.requireNameAndDescription
import ch.nokillswit.infra.validation.sanitizeSingleLine
import io.ktor.server.plugins.BadRequestException
import kotlinx.serialization.Serializable
import java.time.LocalDate

/** The most saved proposals kept: the 21st save removes the oldest (`scheduling.md` "Saved proposals"). */
const val MAX_SAVED_PROPOSALS = 20
const val MAX_SAVED_PROPOSAL_NAME_LENGTH = 100

/**
 * The shape version of the stored `document` ([CrossTeamProposal]) and `check_document` ([ScheduleCheckResponse]): a row of another
 * format reads as [SavedProposalState.UNREADABLE]. A change to either DTO (or anything it nests) bumps this and adds the new
 * fingerprint to `StoredProposalFormatTest`, which fails otherwise: the stored JSON outlives the code that wrote it.
 */
const val STORED_PROPOSAL_FORMAT: Short = 1

/**
 * `POST /saved-schedule-proposals` (1.26.0): [teamIds], [asOf], [expectedRevision] and [scopeHash] are the run's (the accept's body
 * without the items); [selectedMilestoneIds] are the ticked moves. The server stores its OWN re-computation of the run, never a
 * document the client sends, and refuses a stale view ([expectedRevision] above the plan, or a changed [scopeHash]).
 */
@Serializable
data class SavedProposalSaveRequest(
    val name: String,
    val asOf: String,
    val teamIds: List<UInt>,
    val expectedRevision: Long,
    val scopeHash: String,
    val selectedMilestoneIds: List<UInt>,
)

/** The request after [validateSavedProposalSave]: the trimmed name, the parsed day and the ticked ids as sent. */
class SavedProposalCommand(
    val name: String,
    val asOf: LocalDate,
    val teamIds: List<UInt>,
    val expectedRevision: Long,
    val scopeHash: String,
    val selected: List<UInt>,
)

/** A team of a saved proposal as it was named at the save. */
@Serializable
data class SavedProposalTeam(val id: UInt, val name: String)

/** The caller's right on a listed proposal ([PlanPermissions.canDeleteSavedProposal]). */
@Serializable
data class SavedProposalListCan(val delete: Boolean)

/** The caller's rights on one proposal: Accept only while it is CURRENT ([PlanPermissions.canAcceptSavedProposal]). */
@Serializable
data class SavedProposalCan(val accept: Boolean, val delete: Boolean)

/**
 * One saved proposal in a list (and the save's answer): the facts, never the document. [planRevision] is the plan revision the run was
 * computed at, [moveCount] the moves it proposes and [selectedCount] how many were ticked.
 */
@Serializable
data class SavedProposalSummary(
    val id: UInt,
    val name: String,
    val asOf: String,
    val planRevision: Long,
    val createdAt: Long,
    val createdBy: BaselineCreator?,
    val teams: List<SavedProposalTeam>,
    val moveCount: Int,
    val selectedCount: Int,
    val passes: Int,
    val settled: Boolean,
    val can: SavedProposalListCan,
)

/** `GET /saved-schedule-proposals`: the newest [MAX_SAVED_PROPOSALS] at most, newest first - a bounded set, not paged. */
@Serializable
data class SavedProposalList(val items: List<SavedProposalSummary>)

/**
 * Whether a saved proposal still describes the plan, derived at read and never stored: CURRENT = both scope digests equal the stored
 * token's and no run-team milestone was rescheduled after the proposal's plan revision; CHANGED = otherwise (a team gone included);
 * UNREADABLE = stored in another [STORED_PROPOSAL_FORMAT], so it carries no document.
 */
@Serializable
enum class SavedProposalState { CURRENT, CHANGED, UNREADABLE }

/** `GET /saved-schedule-proposals/{id}`: the summary's facts plus the state, the ticks and the stored documents. */
@Serializable
data class SavedProposalRecord(
    val id: UInt,
    val name: String,
    val asOf: String,
    val planRevision: Long,
    val createdAt: Long,
    val createdBy: BaselineCreator?,
    val teams: List<SavedProposalTeam>,
    val moveCount: Int,
    val selectedCount: Int,
    val passes: Int,
    val settled: Boolean,
    val state: SavedProposalState,
    val selectedMilestoneIds: List<UInt>,
    val proposal: CrossTeamProposal?,
    val check: ScheduleCheckResponse?,
    val can: SavedProposalCan,
)

/**
 * The save's shape rules, checked after the guard (the team set is already shaped and guarded): a trimmed name of 1..100 characters
 * (a control character is a 400), a non-negative `expectedRevision`, a `scopeHash` of 64 lowercase hex digits, a valid `asOf`, and
 * 1..[MAX_RUN_SCHEDULE_ITEMS] selected milestone ids, none twice.
 */
fun validateSavedProposalSave(request: SavedProposalSaveRequest): SavedProposalCommand {
    val name = sanitizeSingleLine(request.name, "Name")
    requireNameAndDescription(name, null, MAX_SAVED_PROPOSAL_NAME_LENGTH, 0)
    if (request.expectedRevision < 0) throw BadRequestException("expectedRevision must not be negative")
    if (!SCOPE_HASH.matches(request.scopeHash)) throw BadRequestException("scopeHash must be 64 lowercase hexadecimal characters")
    val asOf = validateAsOf(request.asOf)
    val selected = request.selectedMilestoneIds
    if (selected.isEmpty() || selected.size > MAX_RUN_SCHEDULE_ITEMS) {
        throw BadRequestException("selectedMilestoneIds must list between 1 and $MAX_RUN_SCHEDULE_ITEMS milestones")
    }
    if (selected.toSet().size != selected.size) throw BadRequestException("selectedMilestoneIds must name each milestone once")
    return SavedProposalCommand(name, asOf, request.teamIds, request.expectedRevision, request.scopeHash, selected)
}
