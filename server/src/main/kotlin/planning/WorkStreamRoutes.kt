package ch.nokillswit.planning

import ch.nokillswit.audit.audit
import ch.nokillswit.authz.caller
import ch.nokillswit.authz.orNotFound
import ch.nokillswit.authz.requireAdmin
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
@Resource("/api/v1/work-streams")
class WorkStreamsRoute {
    @Serializable
    @Resource("{id}")
    class Id(val parent: WorkStreamsRoute = WorkStreamsRoute(), val id: UInt) {
        @Serializable
        @Resource("programs")
        class Programs(val parent: Id)
    }
}

private const val WORK_STREAM = "Work stream"

/**
 * Work streams: create is ADMIN only (guard first — it addresses no node); read is any authenticated user; update, delete and
 * "create a program under it" need the stream's owner (or ADMIN) AFTER the 404 (read-before-guard). Reassigning the owner is part of
 * the update body, so any caller who may edit may hand the stream over (the user's answer 3; the ancestors can take it back).
 */
internal fun Route.workStreamRoutes(d: PlanRouteDeps) {
    post<WorkStreamsRoute> {
        val caller = call.caller()
        requireAdmin(caller)
        val request = call.receive<WorkStreamCreateRequest>().sanitized()
        validateWorkStream(request)
        val id = d.structure.workStreams.create(request)
        audit(
            "work_stream.created",
            "byUserId" to caller.userId.toLong(),
            "workStreamId" to id.toLong(),
            "name" to request.name,
            "ownerPersonId" to request.ownerPersonId.toLong(),
        )
        call.response.header(HttpHeaders.Location, call.application.href(WorkStreamsRoute.Id(id = id)))
        call.respond(HttpStatusCode.Created, d.structure.workStreams.read(id).orVanished(WORK_STREAM, id))
    }
    get<WorkStreamsRoute.Id> { route ->
        call.caller()
        call.respond(HttpStatusCode.OK, d.structure.workStreams.read(route.id).orNotFound(WORK_STREAM))
    }
    put<WorkStreamsRoute.Id> { route ->
        val caller = call.caller()
        d.requireOwner(caller, d.structure.workStreams.chain(route.id), WORK_STREAM)
        val request = call.receive<WorkStreamUpdateRequest>().sanitized()
        validateWorkStream(request)
        val outcome = d.structure.workStreams.update(route.id, request, d.ownerGuard(caller))
        val base = arrayOf("byUserId" to caller.userId.toLong(), "workStreamId" to route.id.toLong())
        audit("work_stream.updated", *base, "name" to request.name)
        // An owner change is a rights path (the new owner gains the whole subtree), so it is its own trail line.
        if (outcome.ownerFrom != request.ownerPersonId) {
            audit(
                "work_stream.owner_changed", *base,
                "ownerFrom" to outcome.ownerFrom.toLong(), "ownerTo" to request.ownerPersonId.toLong(),
            )
        }
        // Closing (an end date appears) and reopening (it disappears) are the lifecycle events of a stream.
        if (outcome.endFrom == null && request.endDate != null) audit("work_stream.closed", *base, "endDate" to request.endDate)
        if (outcome.endFrom != null && request.endDate == null) {
            audit("work_stream.reopened", *base, "endFrom" to outcome.endFrom.toString())
        }
        call.respond(HttpStatusCode.NoContent)
    }
    delete<WorkStreamsRoute.Id> { route ->
        val caller = call.caller()
        d.requireOwner(caller, d.structure.workStreams.chain(route.id), WORK_STREAM)
        d.structure.workStreams.delete(route.id, d.ownerGuard(caller))
        audit("work_stream.deleted", "byUserId" to caller.userId.toLong(), "workStreamId" to route.id.toLong())
        call.respond(HttpStatusCode.NoContent)
    }
    post<WorkStreamsRoute.Id.Programs> { route ->
        val caller = call.caller()
        val streamId = route.parent.id
        d.requireOwner(caller, d.structure.workStreams.chain(streamId), WORK_STREAM)
        val request = call.receive<ProgramCreateRequest>().sanitized()
        validateProgram(request)
        val id = d.structure.programs.create(streamId, request, d.ownerGuard(caller))
        audit(
            "program.created",
            "byUserId" to caller.userId.toLong(),
            "programId" to id.toLong(),
            "workStreamId" to streamId.toLong(),
            "name" to request.name,
            "ownerPersonId" to request.ownerPersonId.toLong(),
        )
        call.response.header(HttpHeaders.Location, call.application.href(ProgramsRoute.Id(id = id)))
        call.respond(HttpStatusCode.Created, d.structure.programs.read(id).orVanished("Program", id))
    }
}
