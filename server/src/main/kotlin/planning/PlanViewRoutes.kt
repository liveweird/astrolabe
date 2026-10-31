package ch.nokillswit.planning

import ch.nokillswit.authz.caller
import io.ktor.http.HttpStatusCode
import io.ktor.resources.Resource
import io.ktor.server.application.*
import io.ktor.server.resources.get
import io.ktor.server.response.respond
import io.ktor.server.routing.Route
import kotlinx.serialization.Serializable

@Serializable
@Resource("/api/v1/views/plan")
class PlanViewRoute

/** `GET /views/plan`: any authenticated user reads the whole plan; the caller's rights ride in each node's `can` flags. */
internal fun Route.planViewRoutes(d: PlanRouteDeps) {
    get<PlanViewRoute> {
        val caller = call.caller()
        call.respond(HttpStatusCode.OK, d.view.view(d.actor(caller)))
    }
}
