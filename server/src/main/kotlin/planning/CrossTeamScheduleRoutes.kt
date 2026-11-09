package ch.nokillswit.planning

import ch.nokillswit.authz.NotFoundException
import ch.nokillswit.authz.caller
import io.ktor.http.HttpStatusCode
import io.ktor.resources.Resource
import io.ktor.server.application.*
import io.ktor.server.request.receive
import io.ktor.server.resources.get
import io.ktor.server.resources.post
import io.ktor.server.response.respond
import io.ktor.server.routing.Route
import kotlinx.serialization.Serializable

@Serializable
@Resource("/api/v1/schedule-proposals")
class ScheduleProposalsRoute {
    @Serializable
    @Resource("teams")
    class Teams(val parent: ScheduleProposalsRoute = ScheduleProposalsRoute())
}

/**
 * The plan-scoped cross-team schedule routes (1.8.0, `planning-model.md` "The cross-team run"): unlike every team-scoped route the
 * team set is in the BODY, so the guard cannot run before the body is read.
 */
internal fun Route.crossTeamScheduleRoutes(d: PlanRouteDeps, crossTeam: CrossTeamProposalService) {
    runRoute(d, crossTeam)
    runnableTeamsRoute(d, crossTeam)
}

/**
 * `POST /schedule-proposals`: the cross-team run, a COMPUTATION (`200`, no lock, no revision bump, NO audit event). The order, which
 * differs from the per-team proposal's only where the set lives in the body:
 *  1. `call.receive` - the body decodes FIRST (a malformed body is a `400` even for a caller who would be refused: the team set to
 *     guard is IN it, so there is nothing to guard before it);
 *  2. [validateTeamIds] `400` (1..50 teams, none twice - the guard needs well-formed ids);
 *  3. [PlanRouteDeps.requireTeamManagers]: every team ACTIVE else `404` for EVERY caller (read-before-guard: ids are no secret), then
 *     ADMIN or the ACTIVE manager of EVERY team else `403` (the first failing guard wins);
 *  4. [validateAsOf] `400` - AFTER the guard, so a forbidden caller's malformed `asOf` stays `403`;
 *  5. one read-only snapshot ([CrossTeamProposalService.propose]); a team deleted in the gap since step 3 is the same `404`.
 * Nothing is written, so there is no inner re-guard under a lock (the per-team proposal's rule).
 */
private fun Route.runRoute(d: PlanRouteDeps, crossTeam: CrossTeamProposalService) {
    post<ScheduleProposalsRoute> {
        val caller = call.caller()
        val request = call.receive<CrossTeamProposalRequest>()
        val teamIds = validateTeamIds(request.teamIds)
        d.requireTeamManagers(caller, teamIds)
        val asOf = validateAsOf(request.asOf)
        call.respond(HttpStatusCode.OK, crossTeam.propose(teamIds, asOf) ?: throw NotFoundException("Team not found"))
    }
}

/**
 * `GET /schedule-proposals/teams`: the active teams the caller may include in a run - any authenticated caller, a read (no audit):
 * ADMIN every active team, otherwise the teams the caller currently manages (one query, `withManagedTeams`).
 */
private fun Route.runnableTeamsRoute(d: PlanRouteDeps, crossTeam: CrossTeamProposalService) {
    get<ScheduleProposalsRoute.Teams> {
        val caller = call.caller()
        call.respond(HttpStatusCode.OK, crossTeam.runnableTeams(d.actor(caller, withManagedTeams = true)))
    }
}
