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

@Serializable
@Resource("/api/v1/views/team/{id}")
class TeamViewRoute(val id: UInt)

/**
 * `GET /views/plan`, `GET /views/project/{id}` and `GET /views/team/{id}`: any authenticated user reads the whole plan, one project
 * with its milestones or one team with its schedule, capacity and load (404 when the project, an ancestor or the team is gone, for
 * every caller: plan ids are sequential and the plan is open to read); the caller's rights ride in the `can` flags. The team view
 * service is passed beside [PlanRouteDeps] (its constructor is at detekt's parameter ceiling). A read: no audit event.
 */
internal fun Route.planViewRoutes(d: PlanRouteDeps, teamView: TeamViewService) {
    get<PlanViewRoute> {
        val caller = call.caller()
        call.respond(HttpStatusCode.OK, d.view.view(d.actor(caller)))
    }
    get<ProjectViewRoute> { route ->
        val caller = call.caller()
        call.respond(HttpStatusCode.OK, d.projectView.view(route.id, d.actor(caller, withManagedTeams = true)).orNotFound("Project"))
    }
    get<TeamViewRoute> { route ->
        val caller = call.caller()
        call.respond(HttpStatusCode.OK, teamView.view(route.id, d.actor(caller, withManagedTeams = true)).orNotFound("Team"))
    }
}
