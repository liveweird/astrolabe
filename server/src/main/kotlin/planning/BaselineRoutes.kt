package ch.nokillswit.planning

import ch.nokillswit.audit.audit
import ch.nokillswit.authz.caller
import ch.nokillswit.authz.orNotFound
import ch.nokillswit.authz.requireRoadmapEditorOrAdmin
import io.ktor.http.HttpHeaders
import io.ktor.http.HttpStatusCode
import io.ktor.resources.Resource
import io.ktor.server.application.*
import io.ktor.server.request.receive
import io.ktor.server.resources.delete
import io.ktor.server.resources.get
import io.ktor.server.resources.href
import io.ktor.server.resources.post
import io.ktor.server.resources.put
import io.ktor.server.response.header
import io.ktor.server.response.respond
import io.ktor.server.routing.Route
import kotlinx.serialization.Serializable

@Serializable
@Resource("/api/v1/baselines")
class BaselinesRoute {
    @Serializable
    @Resource("{id}")
    class Id(val parent: BaselinesRoute = BaselinesRoute(), val id: UInt)
}

/**
 * The baselines registry API (V20, `planning-model.md` "Baselines"). Reads (`GET /baselines`, `GET /baselines/{id}`) are any
 * authenticated caller's; the list carries the caller's `can.manage`. The writes are ADMIN's or a `ROADMAP_EDITOR`'s - a plan-wide
 * statement like the global rank - and GUARD-BEFORE-READ, the ranking's shape (`RoadmapRoutes.kt`): `requireRoadmapEditorOrAdmin`
 * runs FIRST, before the body decodes and before the id lookup, so every other caller gets a uniform 403 whether or not the baseline
 * exists and even for a malformed body. The grant is re-read INSIDE the plan lock ([BaselineService]) - a request can be held open after
 * the outer guard, so only the inner verdict authorizes the write. A rejected write (400/404/409) emits no audit event, a 403 is the
 * central `authz.denied`.
 */
internal fun Route.baselineRoutes(d: PlanRouteDeps, service: BaselineService) {
    get<BaselinesRoute> {
        val caller = call.caller()
        val can = BaselineCan(PlanPermissions.canManageBaselines(d.actor(caller)))
        call.respond(HttpStatusCode.OK, BaselineList(service.list(), can))
    }
    post<BaselinesRoute> {
        val caller = call.caller()
        requireRoadmapEditorOrAdmin(caller, d.hasPermission)
        val request = call.receive<BaselineCreateRequest>()
        val values = sanitizedBaseline(request.name, request.description)
        validateBaseline(values.name, values.description)
        val created = service.create(caller.userId, values) { requireRoadmapEditorOrAdmin(caller, d.hasPermission) }
        audit(
            "baseline.created",
            "byUserId" to caller.userId.toLong(),
            "baselineId" to created.value.id.toLong(),
            "name" to created.value.name,
            "revisionTo" to created.revision,
            "milestoneCount" to created.value.milestoneCount,
            "projectCount" to created.value.projectCount,
        )
        call.response.header(HttpHeaders.Location, call.application.href(BaselinesRoute.Id(id = created.value.id)))
        call.respond(HttpStatusCode.Created, created.value)
    }
    get<BaselinesRoute.Id> { route ->
        call.caller()
        call.respond(HttpStatusCode.OK, service.read(route.id).orNotFound("Baseline"))
    }
    put<BaselinesRoute.Id> { route ->
        val caller = call.caller()
        requireRoadmapEditorOrAdmin(caller, d.hasPermission)
        val request = call.receive<BaselineUpdateRequest>()
        val values = sanitizedBaseline(request.name, request.description)
        validateBaseline(values.name, values.description)
        val updated = service.update(route.id, values) { requireRoadmapEditorOrAdmin(caller, d.hasPermission) }
        if (updated.value.changed) {
            audit(
                "baseline.updated",
                "byUserId" to caller.userId.toLong(),
                "baselineId" to route.id.toLong(),
                "nameFrom" to updated.value.nameFrom,
                "nameTo" to values.name,
                "descriptionChanged" to updated.value.descriptionChanged,
                "revisionTo" to updated.revision,
            )
        }
        call.respond(HttpStatusCode.NoContent)
    }
    delete<BaselinesRoute.Id> { route ->
        val caller = call.caller()
        requireRoadmapEditorOrAdmin(caller, d.hasPermission)
        val removed = service.delete(route.id) { requireRoadmapEditorOrAdmin(caller, d.hasPermission) }
        audit(
            "baseline.deleted",
            "byUserId" to caller.userId.toLong(),
            "baselineId" to route.id.toLong(),
            "name" to removed.value,
            "revisionTo" to removed.revision,
        )
        call.respond(HttpStatusCode.NoContent)
    }
}
