package ch.nokillswit.flow

import ch.nokillswit.authz.caller
import ch.nokillswit.authz.orNotFound
import ch.nokillswit.authz.requireTeamManagerOrAdmin
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

private const val BINDING = "Flow team binding"

/**
 * The capacity import's routes (the preview; the apply is a later step). **Read-before-guard**, the team routes' order: the binding
 * (of an ACTIVE team) is resolved first - missing, unlinked or its team deleted = `404` for every caller - then the TEAM's active manager
 * or ADMIN (`requireTeamManagerOrAdmin`, `403`: another team's manager, a project owner, an editor and a stranger are refused), then the
 * body (`400`). A preview writes nothing, takes no lock and is not audited: it is a computation over the mirror and the team's periods.
 */
internal fun Route.capacityImportRoutes(service: CapacityImportService, bindings: FlowTeamBindingService, teams: TeamService) {
    post<CapacityPreviewRoute> { route ->
        val caller = call.caller()
        val teamId = bindings.teamIdOf(route.parent.id).orNotFound(BINDING)
        requireTeamManagerOrAdmin(caller, teamId, teams::isActiveManager)
        val request = call.receive<CapacityPreviewRequest>()
        val from = validateCapacityPreview(request)
        call.respond(HttpStatusCode.OK, service.preview(route.parent.id, from, request.includeClosed).orNotFound(BINDING))
    }
}
