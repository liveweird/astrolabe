package ch.nokillswit.planning

import ch.nokillswit.audit.audit
import ch.nokillswit.authz.caller
import ch.nokillswit.authz.orNotFound
import ch.nokillswit.authz.requireTargetWindowEditorOrAdmin
import ch.nokillswit.infra.paging.optionalString
import ch.nokillswit.infra.paging.parsePaging
import ch.nokillswit.infra.paging.toPage
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
@Resource("/api/v1/projects")
class ProjectsRoute {
    @Serializable
    @Resource("{id}")
    class Id(val parent: ProjectsRoute = ProjectsRoute(), val id: UInt) {
        @Serializable
        @Resource("target-window")
        class TargetWindow(val parent: Id)

        @Serializable
        @Resource("details")
        class Details(val parent: Id)

        @Serializable
        @Resource("milestones")
        class Milestones(val parent: Id)

        @Serializable
        @Resource("move")
        class Move(val parent: Id)

        @Serializable
        @Resource("dependencies")
        class Dependencies(val parent: Id)
    }
}

private const val PROJECT = "Project"

/**
 * Projects: `GET /projects` is the paged picker list (any authenticated user; a name filter; each row carries its program's and work
 * stream's names). Created under a program (`POST /programs/{id}/projects`, in `ProgramRoutes.kt`). Read is any authenticated user; update,
 * delete and "create a milestone under it" (`POST /projects/{id}/milestones`, here — the parent id in the path is what the guard needs)
 * need an owner on the project's chain INCLUDING the project's own owner, or ADMIN. A delete cascades the project's milestones.
 * The target window is a separate PUT with a different audience: ADMIN, an owner ABOVE the project, or a `ROADMAP_EDITOR` — the
 * project's own owner alone gets a 403. The details PUT checks both guards. All read-before-guard. `POST /projects/{id}/move` reparents
 * under another program: the caller must own something ABOVE the project AND something on the target program's chain (or be ADMIN).
 * `POST /projects/{id}/dependencies` creates a link whose SUCCESSOR is this project or one of its milestones: the owner chain of
 * THIS project (its own owner included) or ADMIN — the predecessor's owner is asked nothing (`DependencyRoutes.kt`).
 */
internal fun Route.projectRoutes(d: PlanRouteDeps) {
    listProjectsRoute(d)
    get<ProjectsRoute.Id> { route ->
        call.caller()
        call.respond(HttpStatusCode.OK, d.structure.projects.read(route.id).orNotFound(PROJECT))
    }
    put<ProjectsRoute.Id> { route ->
        val caller = call.caller()
        d.requireOwner(caller, d.structure.projects.chain(route.id), PROJECT)
        val request = call.receive<ProjectUpdateRequest>().sanitized()
        validateProjectFields(request.name, request.description)
        val outcome = d.structure.projects.update(route.id, request, d.ownerGuard(caller))
        auditProjectUpdate(caller.userId, route.id, request, outcome)
        call.respond(HttpStatusCode.NoContent)
    }
    put<ProjectsRoute.Id.Details> { route ->
        val caller = call.caller()
        val projectId = route.parent.id
        val chain = d.structure.projects.chain(projectId).orNotFound(PROJECT)
        d.requireOwner(caller, chain, PROJECT)
        requireTargetWindowEditorOrAdmin(caller, d.callerPersonId(caller), chain, d.hasPermission)
        val body = call.receive<ProjectDetailsRequest>()
        val fields = ProjectUpdateRequest(body.name, body.description, body.ownerPersonId).sanitized()
        val window = TargetWindowRequest(body.targetStart, body.targetEnd)
        validateProjectFields(fields.name, fields.description)
        val outcome = d.structure.projects.updateDetails(projectId, fields, window, d.ownerGuard(caller), d.windowGuard(caller))
        auditProjectUpdate(caller.userId, projectId, fields, outcome)
        auditTargetWindowChange(caller.userId, projectId, outcome.windowFrom, outcome.windowTo)
        call.respond(HttpStatusCode.NoContent)
    }
    put<ProjectsRoute.Id.TargetWindow> { route ->
        val caller = call.caller()
        val projectId = route.parent.id
        val chain = d.structure.projects.chain(projectId).orNotFound(PROJECT)
        requireTargetWindowEditorOrAdmin(caller, d.callerPersonId(caller), chain, d.hasPermission)
        val request = call.receive<TargetWindowRequest>()
        val window = validateTargetWindow(request.targetStart, request.targetEnd)
        val outcome = d.structure.projects.setTargetWindow(projectId, request, d.windowGuard(caller))
        auditTargetWindowChange(caller.userId, projectId, outcome.from, window)
        call.respond(HttpStatusCode.NoContent)
    }
    delete<ProjectsRoute.Id> { route ->
        val caller = call.caller()
        d.requireOwner(caller, d.structure.projects.chain(route.id), PROJECT)
        val cascade = d.structure.projects.delete(route.id, d.ownerGuard(caller))
        audit(
            "project.deleted",
            "byUserId" to caller.userId.toLong(),
            "projectId" to route.id.toLong(),
            "milestoneCount" to cascade.milestoneCount,
            *cascade.dependencies.auditFields(),
        )
        call.respond(HttpStatusCode.NoContent)
    }
    post<ProjectsRoute.Id.Move> { route ->
        val caller = call.caller()
        val projectId = route.parent.id
        val person = d.requireMoveSource(caller, d.structure.projects.chain(projectId), PROJECT)
        val request = call.receive<ProjectMoveRequest>()
        d.requireMoveTarget(caller, person, d.structure.programs.chain(request.programId), "program", request.programId)
        val outcome = d.structure.projects.move(projectId, request.programId, d.moveGuards(caller))
        if (outcome.changed) {
            audit(
                "project.moved",
                "byUserId" to caller.userId.toLong(),
                "projectId" to projectId.toLong(),
                "programFrom" to outcome.from.toLong(),
                "programTo" to outcome.to.toLong(),
            )
        }
        call.respond(HttpStatusCode.NoContent)
    }
    post<ProjectsRoute.Id.Milestones> { route ->
        val caller = call.caller()
        val projectId = route.parent.id
        d.requireOwner(caller, d.structure.projects.chain(projectId), PROJECT)
        val request = call.receive<MilestoneCreateRequest>().sanitized()
        validateMilestoneFields(request.name, request.description, request.estimateMd)
        val created = d.structure.milestones.createResponse(projectId, request, d.ownerGuard(caller))
        val id = created.id
        audit(
            "milestone.created",
            "byUserId" to caller.userId.toLong(),
            "milestoneId" to id.toLong(),
            "projectId" to projectId.toLong(),
            "name" to request.name,
            "teamId" to request.teamId.toLong(),
            "estimateMd" to request.estimateMd,
        )
        call.response.header(HttpHeaders.Location, call.application.href(MilestonesRoute.Id(id = id)))
        call.respond(HttpStatusCode.Created, created)
    }
    createDependencyRoute(d)
}

private fun auditProjectUpdate(userId: UInt, projectId: UInt, request: ProjectUpdateRequest, outcome: ProjectUpdateOutcome) {
    val base = arrayOf("byUserId" to userId.toLong(), "projectId" to projectId.toLong())
    audit("project.updated", *base, "name" to request.name)
    if (outcome.ownerFrom != request.ownerPersonId) {
        audit(
            "project.owner_changed", *base,
            "ownerFrom" to outcome.ownerFrom.toLong(), "ownerTo" to request.ownerPersonId.toLong(),
        )
    }
}

private fun auditTargetWindowChange(userId: UInt, projectId: UInt, from: TargetWindow?, to: TargetWindow?) {
    if (from == to) return
    audit(
        "project.target_window_changed",
        "byUserId" to userId.toLong(),
        "projectId" to projectId.toLong(),
        "startFrom" to from?.start?.toString(),
        "endFrom" to from?.end?.toString(),
        "startTo" to to?.start?.toString(),
        "endTo" to to?.end?.toString(),
    )
}

/** `GET /projects`: the paged picker list, any authenticated user (`list-endpoints.md`). */
private fun Route.listProjectsRoute(d: PlanRouteDeps) {
    get<ProjectsRoute> {
        call.caller()
        val paging = call.parsePaging(sortable = PROJECT_SORT_FIELDS)
        val filter = ProjectListFilter(name = call.request.queryParameters.optionalString("name"))
        val result = d.structure.projects.list(filter, paging)
        call.respond(HttpStatusCode.OK, paging.toPage(result.items, result.total))
    }
}

/** `POST /projects/{id}/dependencies`: the SUCCESSOR's project is the path project, so its chain is the guard. */
private fun Route.createDependencyRoute(d: PlanRouteDeps) {
    post<ProjectsRoute.Id.Dependencies> { route ->
        val caller = call.caller()
        val projectId = route.parent.id
        d.requireOwner(caller, d.structure.projects.chain(projectId), PROJECT)
        val request = call.receive<DependencyCreateRequest>()
        validateDependencyCreate(request)
        val created = d.structure.dependencies.createResponse(projectId, request, d.ownerGuard(caller))
        val id = created.id
        audit(
            "dependency.created",
            "byUserId" to caller.userId.toLong(),
            "dependencyId" to id.toLong(),
            "projectId" to projectId.toLong(),
            "predKind" to request.predecessor.kind.name,
            "predId" to request.predecessor.id.toLong(),
            "succKind" to request.successor.kind.name,
            "succId" to request.successor.id.toLong(),
            "type" to request.type.name,
            "lagDays" to request.lagDays,
        )
        call.response.header(HttpHeaders.Location, call.application.href(DependenciesRoute.Id(id = id)))
        call.respond(HttpStatusCode.Created, created)
    }
}
