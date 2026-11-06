package ch.nokillswit.jira

import ch.nokillswit.authz.caller
import ch.nokillswit.infra.paging.optionalBoolean
import ch.nokillswit.infra.paging.optionalEnum
import ch.nokillswit.infra.paging.optionalUInt
import io.ktor.http.HttpStatusCode
import io.ktor.resources.Resource
import io.ktor.server.application.*
import io.ktor.server.auth.authenticate
import io.ktor.server.resources.get
import io.ktor.server.response.respond
import io.ktor.server.routing.routing
import kotlinx.serialization.Serializable

@Serializable
@Resource("/api/v1/views/deviations")
class DeviationViewRoute

/**
 * `GET /views/deviations`: any authenticated user (the plan, the bindings' node names and the issue data of a binding are already
 * readable by every login; the `connections` block lists every active connection with its NAME - the id and the site of a BOUND one
 * were already in `GET /bindings`, a binding-less one is new - so a non-admin owner's bind dialog can pick one; never the email,
 * token, keys or mapping). A read: no
 * audit event, no lock, no revision. A repeated or malformed filter, an unknown enum value or a non-strict boolean is a `400`
 * (`list-endpoints.md`); unknown parameter NAMES are ignored.
 */
fun Application.configureDeviationRoutes() {
    val deviations = attributes[DeviationViewServiceKey]
    routing {
        authenticate {
            get<DeviationViewRoute> {
                call.caller()
                val query = call.request.queryParameters
                val filter = DeviationFilter(
                    connectionId = query.optionalUInt("connectionId"),
                    level = query.optionalEnum<JiraLevel>("level"),
                    severity = query.optionalEnum<DeviationSeverity>("severity"),
                    kind = query.optionalEnum<DeviationKind>("kind"),
                    workStreamId = query.optionalUInt("workStreamId"),
                    programId = query.optionalUInt("programId"),
                    projectId = query.optionalUInt("projectId"),
                    teamId = query.optionalUInt("teamId"),
                    all = query.optionalBoolean("all"),
                )
                call.respond(HttpStatusCode.OK, deviations.view(filter))
            }
        }
    }
}
