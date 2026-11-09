package ch.nokillswit.planning

import ch.nokillswit.audit.audit
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

    @Serializable
    @Resource("accept")
    class Accept(val parent: ScheduleProposalsRoute = ScheduleProposalsRoute())

    @Serializable
    @Resource("check")
    class Check(val parent: ScheduleProposalsRoute = ScheduleProposalsRoute())
}

/**
 * The plan-scoped cross-team schedule routes (1.8.0, `planning-model.md` "The cross-team run"): unlike every team-scoped route the
 * team set is in the BODY, so the guard cannot run before the body is read.
 */
internal fun Route.crossTeamScheduleRoutes(d: PlanRouteDeps, crossTeam: CrossTeamProposalService, schedules: TeamScheduleService) {
    runRoute(d, crossTeam)
    runnableTeamsRoute(d, crossTeam)
    acceptRoute(d, schedules)
    checkRoute(d, crossTeam)
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

/**
 * `POST /schedule-proposals/accept`: the accept of a run, N teams' schedule PUTs in ONE plan write. The order of the checks is the run's
 * (the team SET is in the body) with the batch's write half: the body decodes FIRST (`400`, a missing `scopeHash` included), then
 * [validateTeamIds] `400`, then [PlanRouteDeps.requireTeamManagers] (every team ACTIVE else `404` for EVERY caller, then ADMIN or the
 * ACTIVE manager of EVERY team else `403`: a forbidden caller's malformed items stay `403`), then [TeamScheduleService.acceptRun]: the
 * rest of the shape `400` before the lock, and under the plan lock every team locked and re-guarded ([PlanRouteDeps.teamManagerGuard]),
 * the `409`s, the per-item rules. Answers the per-team batch's `{revision, accepted, skipped}`.
 *
 * Audit, after the commit (a 4xx emits nothing of its own, a 403 is the central `authz.denied`): `milestone.scheduled` per accepted
 * item whose dates changed, with the item's STORED team, `milestone.unpinned` per released pin ([auditScheduledItems]), and ONE
 * `team.schedule_batch_applied` PER TEAM of the set (ascending id) over the items whose stored team it is - a GONE or NOT_ON_TEAM item
 * has no run team and is in no line (the response carries it); a team with no item gets a zero line (the lock was taken on its
 * behalf) - each with the additive `runTeamIds` (the sorted set, comma-joined) so the N lines read as one accept.
 */
private fun Route.acceptRoute(d: PlanRouteDeps, schedules: TeamScheduleService) {
    post<ScheduleProposalsRoute.Accept> {
        val caller = call.caller()
        val request = call.receive<CrossTeamAcceptRequest>()
        val teamIds = validateTeamIds(request.teamIds)
        d.requireTeamManagers(caller, teamIds)
        val outcome = schedules.acceptRun(request, d.teamManagerGuard(caller))
        auditScheduledItems(caller.userId, outcome)
        val runTeamIds = teamIds.sorted()
        for (teamId in runTeamIds) {
            val accepted = outcome.accepted.filter { it.teamId == teamId }.map { it.milestoneId }.sorted()
            val skipped = outcome.skipped.filter { outcome.storedTeams[it.milestoneId] == teamId }.map { it.milestoneId }.sorted()
            audit(
                "team.schedule_batch_applied",
                "byUserId" to caller.userId.toLong(),
                "teamId" to teamId.toLong(),
                "revisionTo" to outcome.revision,
                "acceptedCount" to accepted.size,
                "skippedCount" to skipped.size,
                "acceptedIds" to accepted.joinToString(","),
                "skippedIds" to skipped.joinToString(","),
                "runTeamIds" to runTeamIds.joinToString(","),
            )
        }
        call.respond(HttpStatusCode.OK, outcome.toResponse())
    }
}

/**
 * `POST /schedule-proposals/check`: the link verdicts and the weekly load of the run teams for the dates the ticked
 * [ScheduleCheckRequest.items] would give them - a COMPUTATION (`200`, one read-only snapshot, no lock, no revision bump, NO audit
 * event). The run's order of checks: the body decodes FIRST, [validateTeamIds] `400`, [PlanRouteDeps.requireTeamManagers] (every team
 * ACTIVE else `404`, then ADMIN or the ACTIVE manager of EVERY team else `403`), then the items' shape [validateScheduleCheck] `400` (a
 * forbidden caller's malformed items stay `403`), then [CrossTeamProposalService.check] (`400` for a milestone outside the run teams; a
 * team deleted in the gap since the guard is the same `404`). Nothing is written, so no inner re-guard under a lock.
 */
private fun Route.checkRoute(d: PlanRouteDeps, crossTeam: CrossTeamProposalService) {
    post<ScheduleProposalsRoute.Check> {
        val caller = call.caller()
        val request = call.receive<ScheduleCheckRequest>()
        val teamIds = validateTeamIds(request.teamIds)
        d.requireTeamManagers(caller, teamIds)
        val items = validateScheduleCheck(request)
        call.respond(HttpStatusCode.OK, crossTeam.check(teamIds, items) ?: throw NotFoundException("Team not found"))
    }
}
