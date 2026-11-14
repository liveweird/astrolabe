package ch.nokillswit.planning

import ch.nokillswit.audit.audit
import ch.nokillswit.authz.caller
import ch.nokillswit.authz.requireRoadmapEditorOrAdmin
import ch.nokillswit.infra.paging.optionalUInt
import io.ktor.http.HttpStatusCode
import io.ktor.resources.Resource
import io.ktor.server.application.*
import io.ktor.server.request.receive
import io.ktor.server.resources.get
import io.ktor.server.resources.put
import io.ktor.server.response.respond
import io.ktor.server.routing.Route
import kotlinx.serialization.Serializable

@Serializable
@Resource("/api/v1/views/roadmap")
class RoadmapViewRoute

@Serializable
@Resource("/api/v1/roadmap/ranking")
class RoadmapRankingRoute

/**
 * The optional `?criticalPath=N` of the roadmap view (1.7) and the programs view (1.16): absent/blank = no block, a repeated key or a
 * value that is not a non-negative integer is a plain `400` (`optionalUInt`, as `?baseline=`). Whether N names an ACTIVE project is the
 * service's question ([criticalPathTo]).
 */
internal fun ApplicationCall.criticalPathParam(): UInt? = request.queryParameters.optionalUInt("criticalPath")

/**
 * The global project rank. `GET /views/roadmap`: any authenticated user reads it; `can.editRank` and each project's
 * `can.editTargetWindow` carry the caller's rights (the view service is [PlanRouteDeps.views]).
 * `PUT /roadmap/ranking`: ADMIN or a `ROADMAP_EDITOR`, GUARD-BEFORE-READ (the route addresses no node: the guard runs before the
 * body is read, so every other caller gets a uniform 403 even for a malformed body). The grant is re-checked INSIDE the plan lock
 * ([RoadmapService.replaceRanking]) — a request can be held open after the outer guard, so only the inner verdict authorizes the write.
 */
internal fun Route.roadmapRoutes(d: PlanRouteDeps) {
    get<RoadmapViewRoute> {
        val caller = call.caller()
        call.respond(HttpStatusCode.OK, d.views.roadmap.view(d.actor(caller), call.baselineParam(), call.criticalPathParam()))
    }
    put<RoadmapRankingRoute> {
        val caller = call.caller()
        requireRoadmapEditorOrAdmin(caller, d.hasPermission)
        val request = call.receive<RankingUpdateRequest>()
        val outcome = d.roadmap.replaceRanking(request) { requireRoadmapEditorOrAdmin(caller, d.hasPermission) }
        audit(
            "roadmap.ranked",
            "byUserId" to caller.userId.toLong(),
            "revisionFrom" to outcome.revisionFrom,
            "revisionTo" to outcome.revisionTo,
            "orderFrom" to outcome.orderFrom.joinToString(","),
            "orderTo" to request.projectIds.joinToString(","),
        )
        call.respond(HttpStatusCode.OK, RankingResponse(outcome.revisionTo))
    }
}
