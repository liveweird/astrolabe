package ch.nokillswit.jira

import ch.nokillswit.authz.caller
import ch.nokillswit.authz.isAdmin
import ch.nokillswit.infra.paging.optionalBoolean
import ch.nokillswit.infra.paging.optionalEnum
import ch.nokillswit.infra.paging.optionalUInt
import ch.nokillswit.people.PersonServiceKey
import ch.nokillswit.planning.DeviationKind
import ch.nokillswit.planning.DeviationSeverity
import ch.nokillswit.planning.PlanActor
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
 * audit event, no lock, no revision (the caller's person is resolved once, for each item's `can.acknowledge`). A repeated or malformed
 * filter, an unknown enum value or a non-strict boolean is a `400`
 * (`list-endpoints.md`); unknown parameter NAMES are ignored.
 */
fun Application.configureDeviationRoutes() {
    val deviations = attributes[DeviationViewServiceKey]
    val people = attributes[PersonServiceKey]
    routing {
        authenticate {
            get<DeviationViewRoute> {
                val caller = call.caller()
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
                    acknowledged = query.optionalBoolean("acknowledged"),
                )
                // The caller's ACTIVE person, for `can.acknowledge` only (not looked up for an ADMIN, who needs no ownership).
                val admin = caller.isAdmin()
                val personId = if (admin) null else people.activePersonIdOf(caller.userId)
                // `roadmapEditor` and `managedTeamIds` are false/empty ON PURPOSE: `can.acknowledge` reads neither (ownership or ADMIN). A
                // future `can` flag that needs either must load them here, or it would answer false for everyone.
                val actor = PlanActor(admin, personId, roadmapEditor = false, managedTeamIds = emptySet())
                call.respond(HttpStatusCode.OK, deviations.view(filter, actor))
            }
        }
    }
}
