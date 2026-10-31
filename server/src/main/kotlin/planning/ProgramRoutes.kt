package ch.nokillswit.planning

import ch.nokillswit.audit.audit
import ch.nokillswit.authz.caller
import ch.nokillswit.authz.orNotFound
import ch.nokillswit.infra.db.orVanished
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
@Resource("/api/v1/programs")
class ProgramsRoute {
    @Serializable
    @Resource("{id}")
    class Id(val parent: ProgramsRoute = ProgramsRoute(), val id: UInt) {
        @Serializable
        @Resource("projects")
        class Projects(val parent: Id)

        @Serializable
        @Resource("move")
        class Move(val parent: Id)
    }
}

private const val PROGRAM = "Program"

/**
 * Programs: created under a work stream (`POST /work-streams/{id}/programs`, in `WorkStreamRoutes.kt` — the parent id in the path is
 * what the guard needs). Read is any authenticated user; update, delete and "create a project under it" need an owner on the program's
 * chain (work stream or program) or ADMIN, after the 404 (read-before-guard). `POST /programs/{id}/move` reparents under another work
 * stream: the caller must own the program's work stream (its own owner alone may not) AND the target work stream (or be ADMIN).
 */
internal fun Route.programRoutes(d: PlanRouteDeps) {
    get<ProgramsRoute.Id> { route ->
        call.caller()
        call.respond(HttpStatusCode.OK, d.programs.read(route.id).orNotFound(PROGRAM))
    }
    put<ProgramsRoute.Id> { route ->
        val caller = call.caller()
        d.requireOwner(caller, d.programs.chain(route.id), PROGRAM)
        val request = call.receive<ProgramUpdateRequest>().sanitized()
        validateProgram(request)
        val outcome = d.programs.update(route.id, request, d.ownerGuard(caller))
        val base = arrayOf("byUserId" to caller.userId.toLong(), "programId" to route.id.toLong())
        audit("program.updated", *base, "name" to request.name)
        if (outcome.ownerFrom != request.ownerPersonId) {
            audit(
                "program.owner_changed", *base,
                "ownerFrom" to outcome.ownerFrom.toLong(), "ownerTo" to request.ownerPersonId.toLong(),
            )
        }
        call.respond(HttpStatusCode.NoContent)
    }
    delete<ProgramsRoute.Id> { route ->
        val caller = call.caller()
        d.requireOwner(caller, d.programs.chain(route.id), PROGRAM)
        d.programs.delete(route.id, d.ownerGuard(caller))
        audit("program.deleted", "byUserId" to caller.userId.toLong(), "programId" to route.id.toLong())
        call.respond(HttpStatusCode.NoContent)
    }
    post<ProgramsRoute.Id.Move> { route ->
        val caller = call.caller()
        val programId = route.parent.id
        val person = d.requireMoveSource(caller, d.programs.chain(programId), PROGRAM)
        val request = call.receive<ProgramMoveRequest>()
        d.requireMoveTarget(caller, person, d.workStreams.chain(request.workStreamId), "work stream", request.workStreamId)
        val outcome = d.programs.move(programId, request.workStreamId, d.moveGuards(caller))
        if (outcome.changed) {
            audit(
                "program.moved",
                "byUserId" to caller.userId.toLong(),
                "programId" to programId.toLong(),
                "workStreamFrom" to outcome.from.toLong(),
                "workStreamTo" to outcome.to.toLong(),
            )
        }
        call.respond(HttpStatusCode.NoContent)
    }
    post<ProgramsRoute.Id.Projects> { route ->
        val caller = call.caller()
        val programId = route.parent.id
        d.requireOwner(caller, d.programs.chain(programId), PROGRAM)
        val request = call.receive<ProjectCreateRequest>().sanitized()
        validateProjectCreate(request)
        val id = d.projects.create(programId, request, d.ownerGuard(caller))
        audit(
            "project.created",
            "byUserId" to caller.userId.toLong(),
            "projectId" to id.toLong(),
            "programId" to programId.toLong(),
            "name" to request.name,
            "ownerPersonId" to request.ownerPersonId.toLong(),
        )
        call.response.header(HttpHeaders.Location, call.application.href(ProjectsRoute.Id(id = id)))
        call.respond(HttpStatusCode.Created, d.projects.read(id).orVanished("Project", id))
    }
}
