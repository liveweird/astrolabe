package ch.nokillswit.teams

import ch.nokillswit.audit.audit
import ch.nokillswit.authz.caller
import ch.nokillswit.authz.orNotFound
import ch.nokillswit.authz.requireAdmin
import ch.nokillswit.infra.db.orVanished
import ch.nokillswit.infra.paging.optionalString
import ch.nokillswit.infra.paging.parsePaging
import ch.nokillswit.infra.paging.toPage
import io.ktor.http.HttpHeaders
import io.ktor.http.HttpStatusCode
import io.ktor.resources.Resource
import io.ktor.server.application.*
import io.ktor.server.auth.authenticate
import io.ktor.server.request.receive
import io.ktor.server.resources.delete
import io.ktor.server.resources.get
import io.ktor.server.resources.href
import io.ktor.server.resources.post
import io.ktor.server.resources.put
import io.ktor.server.response.header
import io.ktor.server.response.respond
import io.ktor.server.routing.routing
import kotlinx.serialization.Serializable

@Serializable
@Resource("/api/v1/teams")
class TeamsRoute {
    @Serializable
    @Resource("{id}")
    class Id(val parent: TeamsRoute = TeamsRoute(), val id: UInt)
}

fun Application.configureTeamRoutes() {
    val teamService = attributes[TeamServiceKey]
    val capacityService = attributes[TeamCapacityServiceKey]

    routing {
        authenticate {
            // Reads are any-authenticated (the owner pickers and the Teams page); every mutation
            // is ADMIN-only with the guard BEFORE the body decodes and the id lookup — a
            // non-admin probe gets a uniform 403 whether or not the id exists.
            get<TeamsRoute> {
                call.caller()
                val paging = call.parsePaging(sortable = TEAM_SORT_FIELDS)
                val params = call.request.queryParameters
                val filter = TeamListFilter(
                    name = params.optionalString("name"),
                )
                val result = teamService.list(filter, paging)
                call.respond(HttpStatusCode.OK, paging.toPage(result.items, result.total))
            }
            post<TeamsRoute> {
                val caller = call.caller()
                requireAdmin(caller)
                val request = sanitizedTeamCreate(call.receive())
                validateTeamCreate(request)
                val id = teamService.create(request)
                audit(
                    "team.created",
                    "byUserId" to caller.userId.toLong(),
                    "teamId" to id.toLong(),
                    "name" to request.name,
                    "managerPersonId" to request.managerPersonId?.toLong(),
                )
                call.response.header(HttpHeaders.Location, call.application.href(TeamsRoute.Id(id = id)))
                call.respond(HttpStatusCode.Created, teamService.read(id).orVanished("Team", id))
            }
            get<TeamsRoute.Id> { route ->
                call.caller()
                call.respond(HttpStatusCode.OK, teamService.read(route.id).orNotFound("Team"))
            }
            put<TeamsRoute.Id> { route ->
                val caller = call.caller()
                requireAdmin(caller)
                val request = sanitizedTeamUpdate(call.receive())
                validateTeamUpdate(request)
                val outcome = teamService.update(route.id, request)
                outcome.affected.orNotFound("Team")
                audit(
                    "team.updated",
                    "byUserId" to caller.userId.toLong(),
                    "teamId" to route.id.toLong(),
                    "name" to request.name,
                )
                // A manager assignment is a privilege change, so it is its own trail line.
                if (outcome.managerFrom != request.managerPersonId) {
                    audit(
                        "team.manager_changed",
                        "byUserId" to caller.userId.toLong(),
                        "teamId" to route.id.toLong(),
                        "managerFrom" to outcome.managerFrom?.toLong(),
                        "managerTo" to request.managerPersonId?.toLong(),
                    )
                }
                call.respond(HttpStatusCode.NoContent)
            }
            delete<TeamsRoute.Id> { route ->
                val caller = call.caller()
                requireAdmin(caller)
                val outcome = teamService.delete(route.id)
                outcome.affected.orNotFound("Team")
                audit(
                    "team.deleted",
                    "byUserId" to caller.userId.toLong(),
                    "teamId" to route.id.toLong(),
                    "capacityPeriodCount" to outcome.capacityPeriodCount,
                )
                call.respond(HttpStatusCode.NoContent)
            }
            // The team's capacity periods: the second routes file of `teams/` (the manager guard differs from the ADMIN-only registry).
            teamCapacityRoutes(teamService, capacityService)
        }
    }
}
