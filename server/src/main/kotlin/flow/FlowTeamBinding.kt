package ch.nokillswit.flow

import io.ktor.server.plugins.BadRequestException
import kotlinx.serialization.Serializable

/** `409` problem type: the Astrolabe team already has a Flow team, or the Flow team is already linked to a (live) Astrolabe team. */
const val FLOW_ALREADY_BOUND_PROBLEM = "urn:astrolabe:problem:already-bound"

/** `400` text of a link whose Flow team is not in the connection's mirror (never mirrored, or gone from Flow since). */
const val UNKNOWN_FLOW_TEAM = "Unknown Flow team: refresh the connection"

/**
 * `POST /integrations/flow/team-bindings`: link Astrolabe team [teamId] to Flow team [flowTeamId] of connection [connectionId]. The team
 * is in the BODY, so the body is decoded before the guard can read the team (the Jira bind's documented exception): an undecodable body
 * is a `400` for every caller, everything that needs the team or the connection comes after.
 */
@Serializable
data class FlowTeamBindRequest(val connectionId: UInt, val flowTeamId: Int, val teamId: UInt)

/** Flow team ids are positive integers (Flow's `teams.id`); the one rule the route and the service share. */
fun validateFlowTeamBind(request: FlowTeamBindRequest): FlowTeamBindRequest {
    if (request.flowTeamId < 1) throw BadRequestException("flowTeamId must be a positive number")
    return request
}

/** A team binding as the writes answer it: the Flow team's name is the one it had when linked (a rename in Flow does not change it). */
@Serializable
data class FlowTeamBindingResponse(
    val id: UInt,
    val connectionId: UInt,
    val teamId: UInt,
    val teamName: String,
    val flowTeamId: Int,
    val flowTeamName: String,
    val createdAt: Long,
)

/** Why "Link all suggested" left a Flow team alone: nothing unique to match, or it is already linked. */
@Serializable
enum class FlowMatchSkipReason { NO_MATCH, ALREADY_BOUND }

@Serializable
data class FlowMatchBound(val bindingId: UInt, val teamId: UInt, val flowTeamId: Int)

@Serializable
data class FlowMatchSkipped(val flowTeamId: Int, val reason: FlowMatchSkipReason)

/** `POST …/connections/{id}/team-bindings/match`: what was linked (every current suggestion) and what was left, by the mirror's order. */
@Serializable
data class FlowTeamMatchResponse(val bound: List<FlowMatchBound>, val skipped: List<FlowMatchSkipped>)

/**
 * One Flow team of a connection's mirror for the link dialog and the connection page's Teams section. [bindingId] is the ACTIVE binding of
 * an ACTIVE Astrolabe team ([boundTeamId]/[boundTeamName]), else null; [suggestedTeamId]/[suggestedTeamName] the one unbound team the name
 * matches ([FlowTeamMatchKernels]), only for a Flow team that is not bound. [members] counts the roster's membership intervals, [sprints]
 * the mirrored sprints; neither names a person. No base URL, token, account id or email ever appears here.
 */
@Serializable
data class FlowTeamListItem(
    val flowTeamId: Int,
    val name: String,
    val bindingId: UInt?,
    val boundTeamId: UInt?,
    val boundTeamName: String?,
    val suggestedTeamId: UInt?,
    val suggestedTeamName: String?,
    val members: Int,
    val sprints: Int,
    val observedAt: Long,
)

/** `GET /integrations/flow/teams?connectionId=`: the mirror of one connection (at most Flow's own cap of 1,000 teams), unpaged. */
@Serializable
data class FlowTeamList(val connectionId: UInt, val teamsAt: Long?, val items: List<FlowTeamListItem>)

/** A binding one write soft-deleted (the audit's input): [reason] is `UNLINKED` for an unlink, `TEAM_GONE` for a dead holder released. */
data class FlowUnboundBinding(val bindingId: UInt, val connectionId: UInt, val teamId: UInt, val flowTeamId: Int, val reason: String)

/** What a link committed: the new binding and the dead-team holder of the same Flow team it released on the way. */
data class FlowBindOutcome(val binding: FlowTeamBindingResponse, val released: List<FlowUnboundBinding>)

/** What "Link all suggested" committed: the response, the bindings it made (for the audits) and the dead holders it released. */
data class FlowMatchOutcome(
    val response: FlowTeamMatchResponse,
    val bindings: List<FlowTeamBindingResponse>,
    val released: List<FlowUnboundBinding>,
)

/** The link's command: [byUserId] is the login that asked (`created_by_user_id`, a plain id: `flow/` names no `users` type). */
class FlowBindCommand(val connectionId: UInt, val flowTeamId: Int, val teamId: UInt, val byUserId: UInt)
