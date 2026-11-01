package ch.nokillswit.planning

import io.ktor.server.plugins.BadRequestException
import kotlinx.serialization.Serializable

/** The most milestones one team-order PUT may list (the largest team holds about a hundred). */
const val MAX_TEAM_ORDER_MILESTONES = 1000

/**
 * The wholesale team order (`PUT /teams/{id}/milestone-order`): [milestoneIds] in the team's execution order become positions 1..n; the
 * team's other milestones are unlisted, and an EMPTY list resets the team to the default order. [expectedRevision] is the team's order
 * revision as the client read it (`order.revision` of the team view; any value up to the plan revision on a team's first write).
 */
@Serializable
data class TeamOrderUpdateRequest(
    val expectedRevision: Long,
    val milestoneIds: List<UInt>,
)

/** The answer of a team-order write: the plan revision it left behind, which is now this team's order revision. */
@Serializable
data class TeamOrderResponse(val revision: Long)

/** What a team-order write replaced, for the audit trail: the plan revisions around it and the listed order BEFORE it. */
data class TeamOrderOutcome(val revisionFrom: Long, val revisionTo: Long, val orderFrom: List<UInt>)

/**
 * The request-shape rules checked before the lock: a non-negative `expectedRevision` (as the spec's `minimum: 0` promises), at most
 * [MAX_TEAM_ORDER_MILESTONES] ids and no id twice.
 */
fun validateTeamOrder(request: TeamOrderUpdateRequest) {
    if (request.expectedRevision < 0) throw BadRequestException("expectedRevision must not be negative")
    val ids = request.milestoneIds
    if (ids.size > MAX_TEAM_ORDER_MILESTONES) {
        throw BadRequestException("milestoneIds must list at most $MAX_TEAM_ORDER_MILESTONES milestones")
    }
    if (ids.toSet().size != ids.size) throw BadRequestException("milestoneIds must be distinct")
}
