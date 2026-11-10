package ch.nokillswit.flow

import ch.nokillswit.authz.caller
import ch.nokillswit.authz.isAdmin
import ch.nokillswit.infra.paging.optionalBoolean
import ch.nokillswit.infra.paging.optionalEnum
import ch.nokillswit.infra.paging.optionalUInt
import ch.nokillswit.planning.DeviationSeverity
import ch.nokillswit.teams.TeamService
import io.ktor.http.HttpStatusCode
import io.ktor.resources.Resource
import io.ktor.server.resources.get
import io.ktor.server.response.respond
import io.ktor.server.routing.Route
import kotlinx.serialization.Serializable

/** `GET /api/v1/views/capacity-deviations`: where the plan's capacity differs from what Flow would make it carry, per bound team. */
@Serializable
@Resource("/api/v1/views/capacity-deviations")
class CapacityDeviationsRoute

/**
 * `GET /views/capacity-deviations`: any authenticated user (the team and Flow team names are in the panel, the figures in
 * `GET /teams/{id}/capacity`, the connection's name and status in the panel; never a base URL, token or registry detail). A read: no
 * audit event, no lock, no revision (the caller's managed teams are resolved once, for each item's `can.acknowledge`, and not at all for
 * an ADMIN). A repeated or malformed filter, an unknown enum value and a non-strict boolean are a `400` (`list-endpoints.md`); unknown
 * parameter NAMES are ignored.
 */
internal fun Route.capacityDeviationRoutes(service: CapacityDeviationService, teams: TeamService) {
    get<CapacityDeviationsRoute> {
        val caller = call.caller()
        val query = call.request.queryParameters
        val filter = CapacityDeviationFilter(
            connectionId = query.optionalUInt("connectionId"),
            teamId = query.optionalUInt("teamId"),
            severity = query.optionalEnum<DeviationSeverity>("severity"),
            kind = query.optionalEnum<CapacityDeviationKind>("kind"),
            acknowledged = query.optionalBoolean("acknowledged"),
            all = query.optionalBoolean("all"),
        )
        val admin = caller.isAdmin()
        val actor = CapacityDeviationActor(admin, if (admin) emptySet() else teams.activeManagedTeamIds(caller.userId))
        call.respond(HttpStatusCode.OK, service.view(filter, actor))
    }
}
