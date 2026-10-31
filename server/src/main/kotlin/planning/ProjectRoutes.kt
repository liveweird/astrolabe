package ch.nokillswit.planning

import ch.nokillswit.audit.audit
import ch.nokillswit.authz.caller
import ch.nokillswit.authz.orNotFound
import ch.nokillswit.authz.requireTargetWindowEditorOrAdmin
import io.ktor.http.HttpStatusCode
import io.ktor.resources.Resource
import io.ktor.server.application.*
import io.ktor.server.request.receive
import io.ktor.server.resources.delete
import io.ktor.server.resources.get
import io.ktor.server.resources.put
import io.ktor.server.response.respond
import io.ktor.server.routing.Route
import kotlinx.serialization.Serializable

@Serializable
@Resource("/api/v1/projects")
class ProjectsRoute {
    @Serializable
    @Resource("{id}")
    class Id(val parent: ProjectsRoute = ProjectsRoute(), val id: UInt) {
        @Serializable
        @Resource("target-window")
        class TargetWindow(val parent: Id)
    }
}

private const val PROJECT = "Project"

/**
 * Projects: created under a program (`POST /programs/{id}/projects`, in `ProgramRoutes.kt`). Read is any authenticated user; update and
 * delete need an owner on the project's chain INCLUDING the project's own owner, or ADMIN. The target window is a separate PUT with a
 * different audience: ADMIN, an owner ABOVE the project, or a `ROADMAP_EDITOR` — the project's own owner alone gets a 403.
 * All read-before-guard.
 */
internal fun Route.projectRoutes(d: PlanRouteDeps) {
    get<ProjectsRoute.Id> { route ->
        call.caller()
        call.respond(HttpStatusCode.OK, d.projects.read(route.id).orNotFound(PROJECT))
    }
    put<ProjectsRoute.Id> { route ->
        val caller = call.caller()
        d.requireOwner(caller, d.projects.chain(route.id), PROJECT)
        val request = call.receive<ProjectUpdateRequest>().sanitized()
        validateProjectFields(request.name, request.description)
        val outcome = d.projects.update(route.id, request, d.ownerGuard(caller))
        val base = arrayOf("byUserId" to caller.userId.toLong(), "projectId" to route.id.toLong())
        audit("project.updated", *base, "name" to request.name)
        if (outcome.ownerFrom != request.ownerPersonId) {
            audit(
                "project.owner_changed", *base,
                "ownerFrom" to outcome.ownerFrom.toLong(), "ownerTo" to request.ownerPersonId.toLong(),
            )
        }
        call.respond(HttpStatusCode.NoContent)
    }
    put<ProjectsRoute.Id.TargetWindow> { route ->
        val caller = call.caller()
        val projectId = route.parent.id
        val chain = d.projects.chain(projectId).orNotFound(PROJECT)
        requireTargetWindowEditorOrAdmin(caller, d.callerPersonId(caller), chain, d.hasPermission)
        val request = call.receive<TargetWindowRequest>()
        val window = validateTargetWindow(request.targetStart, request.targetEnd)
        val outcome = d.projects.setTargetWindow(projectId, request, d.windowGuard(caller))
        if (outcome.from != window) {
            audit(
                "project.target_window_changed",
                "byUserId" to caller.userId.toLong(),
                "projectId" to projectId.toLong(),
                "startFrom" to outcome.from?.start?.toString(),
                "endFrom" to outcome.from?.end?.toString(),
                "startTo" to window?.start?.toString(),
                "endTo" to window?.end?.toString(),
            )
        }
        call.respond(HttpStatusCode.NoContent)
    }
    delete<ProjectsRoute.Id> { route ->
        val caller = call.caller()
        d.requireOwner(caller, d.projects.chain(route.id), PROJECT)
        d.projects.delete(route.id, d.ownerGuard(caller))
        audit("project.deleted", "byUserId" to caller.userId.toLong(), "projectId" to route.id.toLong())
        call.respond(HttpStatusCode.NoContent)
    }
}
