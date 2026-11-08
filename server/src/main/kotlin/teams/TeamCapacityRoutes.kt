package ch.nokillswit.teams

import ch.nokillswit.audit.audit
import ch.nokillswit.authz.CallerPrincipal
import ch.nokillswit.authz.NotFoundException
import ch.nokillswit.authz.caller
import ch.nokillswit.authz.orNotFound
import ch.nokillswit.authz.requireTeamManagerOrAdmin
import ch.nokillswit.infra.db.orVanished
import io.ktor.http.HttpHeaders
import io.ktor.http.HttpStatusCode
import io.ktor.resources.Resource
import io.ktor.server.application.*
import io.ktor.server.request.receive
import io.ktor.server.resources.delete
import io.ktor.server.resources.get
import io.ktor.server.resources.href
import io.ktor.server.resources.post
import io.ktor.server.resources.put
import io.ktor.server.response.header
import io.ktor.server.response.respond
import io.ktor.server.routing.Route
import kotlinx.serialization.Serializable

/** `/api/v1/teams/{id}/capacity`: a team's periods — the collection (GET list, POST create). */
@Serializable
@Resource("capacity")
class TeamCapacityRoute(val parent: TeamsRoute.Id)

/** `/api/v1/capacity-periods/{id}`: one period — GET, full-replace PUT, DELETE. */
@Serializable
@Resource("/api/v1/capacity-periods")
class CapacityPeriodsRoute {
    @Serializable
    @Resource("{id}")
    class Id(val parent: CapacityPeriodsRoute = CapacityPeriodsRoute(), val id: UInt)
}

private const val TEAM = "Team"
private const val PERIOD = "Capacity period"

/**
 * Capacity periods (V16): reads are open to every authenticated user; the writes need the team's ACTIVE manager or ADMIN
 * (`requireTeamManagerOrAdmin`) — the second `teams/` routes file, because the guard differs from the registry's ADMIN-only one.
 * All READ-BEFORE-GUARD (team ids are sequential and every signed-in user reads the plan): the team (or the period's team) is
 * resolved first — missing or deleted = 404 for every caller — then the guard (403), then the body (a forbidden caller's malformed
 * body stays 403), then the validation (400). The service re-runs the guard under the team row lock
 * (`TeamService.lockedIsActiveManager`), so only that inner verdict authorizes the write.
 */
internal fun Route.teamCapacityRoutes(teams: TeamService, capacity: TeamCapacityService) {
    // The write guard the service re-runs inside its transaction, after the team row is locked.
    fun guard(caller: CallerPrincipal): TeamGuard = { teamId ->
        requireTeamManagerOrAdmin(caller, teamId, teams::lockedIsActiveManager)
    }

    get<TeamCapacityRoute> { route ->
        call.caller()
        call.respond(HttpStatusCode.OK, capacity.list(route.parent.id).orNotFound(TEAM))
    }
    post<TeamCapacityRoute> { route ->
        val caller = call.caller()
        val teamId = route.parent.id
        if (!teams.exists(teamId)) throw NotFoundException("$TEAM not found")
        requireTeamManagerOrAdmin(caller, teamId, teams::isActiveManager)
        val values = validateCapacityPeriod(call.receive<CapacityPeriodRequest>())
        val id = capacity.create(teamId, values, guard(caller))
        audit(
            "team.capacity_period_created",
            "byUserId" to caller.userId.toLong(),
            "teamId" to teamId.toLong(),
            "periodId" to id.toLong(),
            "effectiveFrom" to values.effectiveFrom.toString(),
            "mdPerWeek" to values.mdPerWeek.toDouble(),
            "wipLimit" to (values.wipLimit ?: NO_LIMIT),
        )
        call.response.header(HttpHeaders.Location, call.application.href(CapacityPeriodsRoute.Id(id = id)))
        call.respond(HttpStatusCode.Created, capacity.read(id).orVanished(PERIOD, id))
    }
    get<CapacityPeriodsRoute.Id> { route ->
        call.caller()
        call.respond(HttpStatusCode.OK, capacity.read(route.id).orNotFound(PERIOD))
    }
    put<CapacityPeriodsRoute.Id> { route ->
        val caller = call.caller()
        val teamId = capacity.teamIdOf(route.id).orNotFound(PERIOD)
        requireTeamManagerOrAdmin(caller, teamId, teams::isActiveManager)
        val values = validateCapacityPeriod(call.receive<CapacityPeriodRequest>())
        val outcome = capacity.update(route.id, values, guard(caller))
        // A same-values PUT is a 204 and writes (and audits) nothing.
        if (outcome.changed) {
            audit(
                "team.capacity_period_updated",
                "byUserId" to caller.userId.toLong(),
                "teamId" to outcome.teamId.toLong(),
                "periodId" to route.id.toLong(),
                "effectiveFromFrom" to outcome.before.effectiveFrom.toString(),
                "effectiveFromTo" to outcome.after.effectiveFrom.toString(),
                "mdPerWeekFrom" to outcome.before.mdPerWeek.toDouble(),
                "mdPerWeekTo" to outcome.after.mdPerWeek.toDouble(),
                "wipLimitFrom" to (outcome.before.wipLimit ?: NO_LIMIT),
                "wipLimitTo" to (outcome.after.wipLimit ?: NO_LIMIT),
                // A PUT always leaves the period MANUAL; FLOW -> MANUAL is the manager taking over an imported period.
                "sourceFrom" to outcome.sourceBefore.name,
                "sourceTo" to CapacitySource.MANUAL.name,
            )
        }
        call.respond(HttpStatusCode.NoContent)
    }
    delete<CapacityPeriodsRoute.Id> { route ->
        val caller = call.caller()
        val teamId = capacity.teamIdOf(route.id).orNotFound(PERIOD)
        requireTeamManagerOrAdmin(caller, teamId, teams::isActiveManager)
        capacity.delete(route.id, guard(caller))
        audit(
            "team.capacity_period_deleted",
            "byUserId" to caller.userId.toLong(),
            "teamId" to teamId.toLong(),
            "periodId" to route.id.toLong(),
        )
        call.respond(HttpStatusCode.NoContent)
    }
}

/** The audit value of a period without a WIP limit. */
private const val NO_LIMIT = "none"
