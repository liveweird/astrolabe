package ch.nokillswit.flow

import ch.nokillswit.authz.caller
import ch.nokillswit.authz.orNotFound
import ch.nokillswit.authz.requireTeamManagerOrAdmin
import ch.nokillswit.teams.CapacityWriteListeners
import ch.nokillswit.teams.TeamService
import io.ktor.http.HttpStatusCode
import io.ktor.resources.Resource
import io.ktor.server.application.*
import io.ktor.server.request.receive
import io.ktor.server.resources.post
import io.ktor.server.response.respond
import io.ktor.server.routing.Route
import kotlinx.serialization.Serializable

/** `POST /api/v1/integrations/flow/team-bindings/{id}/capacity-preview`: what importing the bound Flow team's sprints would do. */
@Serializable
@Resource("capacity-preview")
class CapacityPreviewRoute(val parent: FlowTeamBindingsRoute.Id)

/** `POST /api/v1/integrations/flow/team-bindings/{id}/capacity-import`: apply the ticked rows of a preview. */
@Serializable
@Resource("capacity-import")
class CapacityImportRoute(val parent: FlowTeamBindingsRoute.Id)

private const val BINDING = "Flow team binding"

/**
 * The capacity import's routes (the preview and the apply). **Read-before-guard**, the team routes' order: the binding
 * (of an ACTIVE team) is resolved first - missing, unlinked or its team deleted = `404` for every caller - then the TEAM's active manager
 * or ADMIN (`requireTeamManagerOrAdmin`, `403`: another team's manager, a project owner, an editor and a stranger are refused), then the
 * body (`400`). A preview writes nothing, takes no lock and is not audited: it is a computation over the mirror and the team's periods.
 * The apply is the capacity routes' write: the guard is re-run INSIDE the transaction under the team row lock
 * (`TeamService.lockedIsActiveManager`), so only that inner verdict authorizes it; it audits after the commit (`auditCapacityImport`) and
 * then, when it wrote a period, tells the [CapacityWriteListeners] (the acknowledgement prune), still before the response.
 */
internal fun Route.capacityImportRoutes(
    service: CapacityImportService,
    bindings: FlowTeamBindingService,
    teams: TeamService,
    listeners: CapacityWriteListeners,
) {
    post<CapacityPreviewRoute> { route ->
        val caller = call.caller()
        val teamId = bindings.teamIdOf(route.parent.id).orNotFound(BINDING)
        requireTeamManagerOrAdmin(caller, teamId, teams::isActiveManager)
        val request = call.receive<CapacityPreviewRequest>()
        val from = validateCapacityPreview(request)
        call.respond(HttpStatusCode.OK, service.preview(route.parent.id, from, request.includeClosed).orNotFound(BINDING))
    }
    post<CapacityImportRoute> { route ->
        val caller = call.caller()
        val teamId = bindings.teamIdOf(route.parent.id).orNotFound(BINDING)
        requireTeamManagerOrAdmin(caller, teamId, teams::isActiveManager)
        val command = validateCapacityApply(call.receive<CapacityApplyRequest>())
        val outcome = service.apply(route.parent.id, command) { id -> requireTeamManagerOrAdmin(caller, id, teams::lockedIsActiveManager) }
        auditCapacityImport(caller, outcome)
        // Only an apply that wrote something tells the listeners (an all-skipped one changed no period); before the response, so the
        // page's next read of the deviations sees the pruned acknowledgements.
        val applied = outcome.applied
        if (applied.created.isNotEmpty() || applied.updated.isNotEmpty() || applied.deleted.isNotEmpty()) {
            listeners.written(outcome.teamId, caller.userId)
        }
        call.respond(HttpStatusCode.OK, outcome.response)
    }
}
