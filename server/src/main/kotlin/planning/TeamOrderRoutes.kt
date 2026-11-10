package ch.nokillswit.planning

import ch.nokillswit.audit.audit
import ch.nokillswit.authz.caller
import io.ktor.http.HttpStatusCode
import io.ktor.resources.Resource
import io.ktor.server.application.*
import io.ktor.server.request.receive
import io.ktor.server.resources.put
import io.ktor.server.response.respond
import io.ktor.server.routing.Route
import kotlinx.serialization.Serializable

@Serializable
@Resource("/api/v1/teams/{id}/milestone-order")
class TeamMilestoneOrderRoute(val id: UInt)

/**
 * `PUT /teams/{id}/milestone-order`: the team's manager or ADMIN replaces the team's milestone order wholesale; the project owner and
 * every other caller get 403. READ-BEFORE-GUARD like the schedule PUT (team ids are sequential and every signed-in user reads the plan):
 * the team is resolved first (missing or deleted = 404 for every caller), then `requireTeamManagerOrAdmin` (403), then the body (a
 * forbidden caller's malformed body stays 403), then the pure validation (400). The service re-runs the guard under the plan lock
 * ([PlanRouteDeps.teamManagerGuard]), so only that inner verdict authorizes the write. Every accepted PUT is audited, a no-op one included.
 */
internal fun Route.teamOrderRoutes(d: PlanRouteDeps) {
    put<TeamMilestoneOrderRoute> { route ->
        val caller = call.caller()
        d.requireTeamManager(caller, route.id)
        val request = call.receive<TeamOrderUpdateRequest>()
        validateTeamOrder(request)
        val outcome = d.scheduling.teamOrder.replaceOrder(route.id, request, d.teamManagerGuard(caller))
        audit(
            "team.milestone_order_changed",
            "byUserId" to caller.userId.toLong(),
            "teamId" to route.id.toLong(),
            "revisionFrom" to outcome.revisionFrom,
            "revisionTo" to outcome.revisionTo,
            "orderFrom" to outcome.orderFrom.joinToString(","),
            "orderTo" to request.milestoneIds.joinToString(","),
        )
        call.respond(HttpStatusCode.OK, TeamOrderResponse(outcome.revisionTo))
    }
}
