package ch.nokillswit.planning

import ch.nokillswit.audit.audit
import ch.nokillswit.authz.caller
import ch.nokillswit.authz.orNotFound
import ch.nokillswit.infra.paging.optionalString
import ch.nokillswit.infra.paging.parsePaging
import ch.nokillswit.infra.paging.toPage
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
@Resource("/api/v1/milestones")
class MilestonesRoute {
    @Serializable
    @Resource("{id}")
    class Id(val parent: MilestonesRoute = MilestonesRoute(), val id: UInt) {
        @Serializable
        @Resource("schedule")
        class Schedule(val parent: Id)
    }
}

private const val MILESTONE = "Milestone"

/**
 * Milestones: `GET /milestones` is the paged picker list (any authenticated user; a name filter; each row carries its project's name).
 * Created under a project (`POST /projects/{id}/milestones`, in `ProjectRoutes.kt` — the parent id in the path is what the
 * guard needs). Read is any authenticated user. The PLAN FIELDS (update, delete) need an owner on the milestone's project chain — the
 * project's own owner included — or ADMIN; the DATES (`PUT .../schedule`) need the milestone's TEAM manager or ADMIN, and a project owner
 * who is not that manager gets a 403 (the product rule of v0.3.0). All read-before-guard (404, 403, then the body); the write re-runs the
 * guard under the plan lock against a re-read chain (the owner guard, and the manager guard with the manager's person and team row
 * locked `FOR SHARE`), so only the inner verdict authorizes it.
 */
internal fun Route.milestoneRoutes(d: PlanRouteDeps) {
    get<MilestonesRoute> {
        call.caller()
        val paging = call.parsePaging(sortable = MILESTONE_SORT_FIELDS)
        val filter = MilestoneListFilter(name = call.request.queryParameters.optionalString("name"))
        val result = d.milestones.list(filter, paging)
        call.respond(HttpStatusCode.OK, paging.toPage(result.items, result.total))
    }
    get<MilestonesRoute.Id> { route ->
        call.caller()
        call.respond(HttpStatusCode.OK, d.milestones.read(route.id).orNotFound(MILESTONE))
    }
    put<MilestonesRoute.Id> { route ->
        val caller = call.caller()
        d.requireOwner(caller, d.milestones.chain(route.id)?.owners, MILESTONE)
        val request = call.receive<MilestoneUpdateRequest>().sanitized()
        validateMilestoneFields(request.name, request.description, request.estimateMd)
        val outcome = d.milestones.update(route.id, request, d.ownerGuard(caller))
        val base = arrayOf("byUserId" to caller.userId.toLong(), "milestoneId" to route.id.toLong())
        audit("milestone.updated", *base, "name" to request.name, "estimateMd" to request.estimateMd)
        if (outcome.teamFrom != request.teamId) {
            // Who may schedule the milestone changed: a rights path, so its own trail line (the dates stay).
            audit("milestone.team_changed", *base, "teamFrom" to outcome.teamFrom.toLong(), "teamTo" to request.teamId.toLong())
        }
        call.respond(HttpStatusCode.NoContent)
    }
    put<MilestonesRoute.Id.Schedule> { route ->
        val caller = call.caller()
        val id = route.parent.id
        d.requireManager(caller, d.milestones.chain(id))
        val request = call.receive<MilestoneScheduleRequest>()
        val span = validateScheduleRequest(request)
        val outcome = d.milestones.schedule(id, request, d.managerGuard(caller))
        if (outcome.from != span) {
            audit(
                "milestone.scheduled",
                "byUserId" to caller.userId.toLong(),
                "milestoneId" to id.toLong(),
                "teamId" to outcome.teamId.toLong(),
                "startFrom" to outcome.from?.start?.toString(),
                "endFrom" to outcome.from?.end?.toString(),
                "startTo" to span?.start?.toString(),
                "endTo" to span?.end?.toString(),
                "revisionTo" to outcome.revision,
            )
        }
        call.respond(HttpStatusCode.OK, ScheduleResponse(outcome.revision))
    }
    delete<MilestonesRoute.Id> { route ->
        val caller = call.caller()
        val chain = d.milestones.chain(route.id).orNotFound(MILESTONE)
        d.requireOwner(caller, chain.owners, MILESTONE)
        val cascade = d.milestones.delete(route.id, d.ownerGuard(caller))
        audit(
            "milestone.deleted",
            "byUserId" to caller.userId.toLong(),
            "milestoneId" to route.id.toLong(),
            "projectId" to chain.projectId.toLong(),
            *cascade.auditFields(),
        )
        call.respond(HttpStatusCode.NoContent)
    }
}
