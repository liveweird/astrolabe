package ch.nokillswit.flow

import ch.nokillswit.audit.audit
import ch.nokillswit.authz.CallerPrincipal
import ch.nokillswit.authz.NotFoundException
import ch.nokillswit.authz.caller
import ch.nokillswit.authz.isAdmin
import ch.nokillswit.authz.orNotFound
import ch.nokillswit.authz.requireAdmin
import ch.nokillswit.authz.requireTeamManagerOrAdmin
import ch.nokillswit.infra.paging.optionalUInt
import ch.nokillswit.teams.TeamGuard
import ch.nokillswit.teams.TeamService
import io.ktor.http.HttpHeaders
import io.ktor.http.HttpStatusCode
import io.ktor.resources.Resource
import io.ktor.server.application.*
import io.ktor.server.plugins.BadRequestException
import io.ktor.server.request.receive
import io.ktor.server.resources.delete
import io.ktor.server.resources.get
import io.ktor.server.resources.href
import io.ktor.server.resources.post
import io.ktor.server.response.header
import io.ktor.server.response.respond
import io.ktor.server.routing.Route
import kotlinx.serialization.Serializable

/** `GET /api/v1/integrations/flow/teams?connectionId=`: a connection's mirrored Flow teams. */
@Serializable
@Resource("/api/v1/integrations/flow/teams")
class FlowTeamsRoute

@Serializable
@Resource("/api/v1/integrations/flow/team-bindings")
class FlowTeamBindingsRoute {
    @Serializable
    @Resource("{id}")
    class Id(val parent: FlowTeamBindingsRoute = FlowTeamBindingsRoute(), val id: UInt)
}

/** `POST …/connections/{id}/team-bindings/match`: "Link all suggested" of one connection. */
@Serializable
@Resource("team-bindings/match")
class FlowTeamMatchRoute(val parent: FlowConnectionsRoute.Id)

/** `GET /api/v1/teams/{id}/flow`: the team page's Flow panel (its own read, not a member of the team view). */
@Serializable
@Resource("/api/v1/teams/{id}/flow")
class TeamFlowRoute(val id: UInt)

private const val TEAM = "Team"

/**
 * The team bindings. Reads are open to every authenticated user (the Flow team names, counts and - Q2a - the roster's display names; never
 * a base URL, token, account id or email). The writes are the team's ACTIVE manager's or ADMIN's (`requireTeamManagerOrAdmin`), except
 * "Link all suggested", which is ADMIN only, guarded FIRST. The team routes are READ-BEFORE-GUARD (team ids are sequential and every
 * signed-in user reads the plan): the team (or the binding's team) is resolved first - missing or deleted = `404` for every caller - then
 * the guard (`403`), then the rest (`400`). The link carries its team in the BODY, so the body is decoded first (the Jira bind's
 * documented exception): an undecodable body is a `400` for every caller. Each write re-runs the guard inside its transaction under the
 * team row lock (`TeamService.lockedIsActiveManager`), so only that inner verdict authorizes it. Audits are emitted AFTER the commit.
 */
internal fun Route.flowTeamBindingRoutes(bindings: FlowTeamBindingService, flowTeams: FlowTeamService, teams: TeamService) {
    fun guard(caller: CallerPrincipal): TeamGuard = { teamId ->
        requireTeamManagerOrAdmin(caller, teamId, teams::lockedIsActiveManager)
    }

    get<FlowTeamsRoute> {
        call.caller()
        val connectionId = call.request.queryParameters.optionalUInt("connectionId")
            ?: throw BadRequestException("connectionId is required")
        call.respond(HttpStatusCode.OK, flowTeams.list(connectionId).orNotFound("Flow connection"))
    }
    post<FlowTeamBindingsRoute> {
        val caller = call.caller()
        val request = call.receive<FlowTeamBindRequest>()
        if (!teams.exists(request.teamId)) throw NotFoundException("$TEAM not found")
        requireTeamManagerOrAdmin(caller, request.teamId, teams::isActiveManager)
        validateFlowTeamBind(request)
        val outcome = bindings.bind(FlowBindCommand(request.connectionId, request.flowTeamId, request.teamId, caller.userId), guard(caller))
        outcome.released.forEach { auditUnbound(caller, it) }
        auditBound(caller, outcome.binding, via = "link")
        call.response.header(HttpHeaders.Location, call.application.href(FlowTeamBindingsRoute.Id(id = outcome.binding.id)))
        call.respond(HttpStatusCode.Created, outcome.binding)
    }
    delete<FlowTeamBindingsRoute.Id> { route ->
        val caller = call.caller()
        val teamId = bindings.teamIdOf(route.id).orNotFound("Flow team binding")
        requireTeamManagerOrAdmin(caller, teamId, teams::isActiveManager)
        auditUnbound(caller, bindings.unbind(route.id, guard(caller)))
        call.respond(HttpStatusCode.NoContent)
    }
    post<FlowTeamMatchRoute> { route ->
        val caller = call.caller()
        requireAdmin(caller)
        val outcome = bindings.match(route.parent.id, caller.userId)
        outcome.released.forEach { auditUnbound(caller, it) }
        outcome.bindings.forEach { auditBound(caller, it, via = "match") }
        audit(
            "flow.teams_matched",
            "byUserId" to caller.userId.toLong(),
            "connectionId" to route.parent.id.toLong(),
            "boundCount" to outcome.bindings.size,
            "bindingIds" to outcome.bindings.joinToString(",") { it.id.toString() },
            "skippedNoMatch" to outcome.response.skipped.count { it.reason == FlowMatchSkipReason.NO_MATCH },
            "skippedAlreadyBound" to outcome.response.skipped.count { it.reason == FlowMatchSkipReason.ALREADY_BOUND },
        )
        call.respond(HttpStatusCode.OK, outcome.response)
    }
    get<TeamFlowRoute> { route ->
        val caller = call.caller()
        if (!teams.exists(route.id)) throw NotFoundException("$TEAM not found")
        val manages = caller.isAdmin() || teams.isActiveManager(route.id, caller.userId)
        call.respond(HttpStatusCode.OK, flowTeams.panel(route.id, manages).orNotFound(TEAM))
    }
}

private fun auditBound(caller: CallerPrincipal, binding: FlowTeamBindingResponse, via: String) = audit(
    "flow.team_bound",
    "byUserId" to caller.userId.toLong(),
    "bindingId" to binding.id.toLong(),
    "connectionId" to binding.connectionId.toLong(),
    "teamId" to binding.teamId.toLong(),
    "flowTeamId" to binding.flowTeamId.toLong(),
    "via" to via,
)

private fun auditUnbound(caller: CallerPrincipal, unbound: FlowUnboundBinding) = audit(
    "flow.team_unbound",
    "byUserId" to caller.userId.toLong(),
    "bindingId" to unbound.bindingId.toLong(),
    "connectionId" to unbound.connectionId.toLong(),
    "teamId" to unbound.teamId.toLong(),
    "flowTeamId" to unbound.flowTeamId.toLong(),
    "reason" to unbound.reason,
)
