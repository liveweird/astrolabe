package ch.nokillswit.planning

import ch.nokillswit.authz.caller
import ch.nokillswit.authz.orNotFound
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

@Serializable
@Resource("/api/v1/views/project/{id}")
class ProjectViewRoute(val id: UInt)

/**
 * `GET /views/plan` and `GET /views/project/{id}`: any authenticated user reads the whole plan, or one project with its milestones
 * (404 when the project or an ancestor is gone, for every caller: plan ids are sequential and the plan is open to read); the
 * caller's rights ride in each node's `can` flags.
 */
internal fun Route.planViewRoutes(d: PlanRouteDeps) {
    get<PlanViewRoute> {
        val caller = call.caller()
        call.respond(HttpStatusCode.OK, d.view.view(d.actor(caller)))
    }
    get<ProjectViewRoute> { route ->
        val caller = call.caller()
        call.respond(HttpStatusCode.OK, d.projectView.view(route.id, d.actor(caller, withManagedTeams = true)).orNotFound("Project"))
    }
}
