package ch.nokillswit.planning

import ch.nokillswit.authz.caller
import ch.nokillswit.authz.orNotFound
import ch.nokillswit.infra.paging.optionalUInt
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
@Resource("/api/v1/views/programs")
class ProgramsViewRoute

@Serializable
@Resource("/api/v1/views/team/{id}")
class TeamViewRoute(val id: UInt)

@Serializable
@Resource("/api/v1/views/baseline/{id}")
class BaselineViewRoute(val id: UInt)

/**
 * The optional `?baseline=N` of the four timeline views: absent/blank = no overlay, a repeated key or a value that is not a
 * non-negative integer is a `400` (`optionalUInt`, the list endpoints' rule). Whether N names an ACTIVE baseline is the view's
 * question AFTER its own existence rules (`requireActiveBaseline`).
 */
internal fun ApplicationCall.baselineParam(): UInt? = request.queryParameters.optionalUInt("baseline")

/**
 * `GET /views/plan`, `GET /views/project/{id}`, `GET /views/programs` and `GET /views/team/{id}`: any authenticated user reads the
 * whole plan, one project with its milestones, the plan tree with its derived spans and flag roll-ups, or one team with its schedule,
 * capacity and load (404 when the project, an ancestor or the team is gone, for every caller: plan ids are sequential and the plan is
 * open to read); the caller's rights ride in the `can` flags. The team, roadmap, programs and baseline view services are passed beside
 * [PlanRouteDeps] in [PlanViewServices] (its constructor is at detekt's parameter ceiling). The project, team, programs (here) and
 * roadmap (`RoadmapRoutes.kt`) views take `?baseline=N`; `GET /views/baseline/{id}` is the comparison document (404 for an unknown or
 * deleted baseline: it is the addressed resource). Any authenticated user; a read: no audit event.
 */
internal fun Route.planViewRoutes(d: PlanRouteDeps, views: PlanViewServices) {
    get<PlanViewRoute> {
        val caller = call.caller()
        call.respond(HttpStatusCode.OK, d.view.view(d.actor(caller)))
    }
    get<ProjectViewRoute> { route ->
        val caller = call.caller()
        val baseline = call.baselineParam()
        val view = d.projectView.view(route.id, d.actor(caller, withManagedTeams = true), baseline)
        call.respond(HttpStatusCode.OK, view.orNotFound("Project"))
    }
    get<ProgramsViewRoute> {
        val caller = call.caller()
        call.respond(HttpStatusCode.OK, views.programs.view(d.actor(caller), call.baselineParam()))
    }
    get<TeamViewRoute> { route ->
        val caller = call.caller()
        val baseline = call.baselineParam()
        call.respond(HttpStatusCode.OK, views.team.view(route.id, d.actor(caller, withManagedTeams = true), baseline).orNotFound("Team"))
    }
    get<BaselineViewRoute> { route ->
        call.caller()
        call.respond(HttpStatusCode.OK, views.baseline.view(route.id).orNotFound("Baseline"))
    }
}
