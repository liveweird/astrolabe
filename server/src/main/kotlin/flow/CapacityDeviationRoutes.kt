package ch.nokillswit.flow

import ch.nokillswit.authz.caller
import ch.nokillswit.infra.paging.optionalEnum
import ch.nokillswit.infra.paging.optionalUInt
import ch.nokillswit.planning.DeviationSeverity
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
 * audit event, no lock, no revision. A repeated or malformed filter and an unknown enum value are a `400` (`list-endpoints.md`);
 * unknown parameter NAMES are ignored.
 */
internal fun Route.capacityDeviationRoutes(service: CapacityDeviationService) {
    get<CapacityDeviationsRoute> {
        call.caller()
        val query = call.request.queryParameters
        val filter = CapacityDeviationFilter(
            connectionId = query.optionalUInt("connectionId"),
            teamId = query.optionalUInt("teamId"),
            severity = query.optionalEnum<DeviationSeverity>("severity"),
            kind = query.optionalEnum<CapacityDeviationKind>("kind"),
        )
        call.respond(HttpStatusCode.OK, service.view(filter))
    }
}
