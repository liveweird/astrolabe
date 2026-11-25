package ch.nokillswit.planning

import ch.nokillswit.audit.audit
import ch.nokillswit.authz.caller
import ch.nokillswit.authz.requireAdmin
import io.ktor.http.HttpStatusCode
import io.ktor.resources.Resource
import io.ktor.server.application.*
import io.ktor.server.request.receive
import io.ktor.server.resources.put
import io.ktor.server.response.respond
import io.ktor.server.routing.Route
import kotlinx.serialization.Serializable

@Serializable
@Resource("/api/v1/work-stream-order")
class WorkStreamOrderRoute

@Serializable
@Resource("/api/v1/work-streams/{id}/program-order")
class ProgramOrderRoute(val id: UInt)

/**
 * The shared plan order (V34; `plan-tree.md`).
 * `PUT /work-stream-order`: ADMIN only, GUARD-BEFORE-READ (the route addresses no node, so there is no 404 to order against): the
 * guard runs before the body is read, so a forbidden caller's malformed body stays 403, then the pure validation (400); the stale
 * check and the id check run under the plan lock ([PlanOrderService.replaceWorkStreamOrder]).
 * `PUT /work-streams/{id}/program-order`: the stream's owner or ADMIN, READ-BEFORE-GUARD like every node route (the stream is resolved
 * first: missing or deleted = 404 for every caller; then `requireOwnerOrAdmin` 403; then the body; then the pure validation). The
 * service re-reads the chain and re-runs the guard under the plan lock ([PlanRouteDeps.ownerGuard]), so only that inner verdict
 * authorizes the write. Every accepted PUT is audited, a no-op one included.
 */
internal fun Route.planOrderRoutes(d: PlanRouteDeps, order: PlanOrderService) {
    put<WorkStreamOrderRoute> {
        val caller = call.caller()
        requireAdmin(caller)
        val request = call.receive<WorkStreamOrderUpdateRequest>()
        validateWorkStreamOrder(request)
        val outcome = order.replaceWorkStreamOrder(request)
        audit(
            "plan.work_stream_order_changed",
            "byUserId" to caller.userId.toLong(),
            "revisionFrom" to outcome.revisionFrom,
            "revisionTo" to outcome.revisionTo,
            "orderFrom" to outcome.orderFrom.joinToString(","),
            "orderTo" to request.workStreamIds.joinToString(","),
        )
        call.respond(HttpStatusCode.OK, PlanOrderResponse(outcome.revisionTo))
    }
    put<ProgramOrderRoute> { route ->
        val caller = call.caller()
        d.requireOwner(caller, d.structure.workStreams.chain(route.id), "Work stream")
        val request = call.receive<ProgramOrderUpdateRequest>()
        validateProgramOrder(request)
        val outcome = order.replaceProgramOrder(route.id, request, d.ownerGuard(caller))
        audit(
            "work_stream.program_order_changed",
            "byUserId" to caller.userId.toLong(),
            "workStreamId" to route.id.toLong(),
            "revisionFrom" to outcome.revisionFrom,
            "revisionTo" to outcome.revisionTo,
            "orderFrom" to outcome.orderFrom.joinToString(","),
            "orderTo" to request.programIds.joinToString(","),
        )
        call.respond(HttpStatusCode.OK, PlanOrderResponse(outcome.revisionTo))
    }
}
