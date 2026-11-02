package ch.nokillswit.planning

import ch.nokillswit.audit.audit
import ch.nokillswit.authz.NotFoundException
import ch.nokillswit.authz.caller
import io.ktor.http.HttpStatusCode
import io.ktor.resources.Resource
import io.ktor.server.application.*
import io.ktor.server.request.receive
import io.ktor.server.resources.post
import io.ktor.server.response.respond
import io.ktor.server.routing.Route
import kotlinx.serialization.Serializable

@Serializable
@Resource("/api/v1/teams/{id}/milestone-schedules")
class TeamMilestoneSchedulesRoute(val id: UInt)

@Serializable
@Resource("/api/v1/teams/{id}/schedule-proposal")
class TeamScheduleProposalRoute(val id: UInt)

/**
 * The team-scoped schedule routes (v0.8.0, beside `TeamOrderRoutes.kt`): the team's manager or ADMIN, nobody else - above all not the
 * project's owner. READ-BEFORE-GUARD like the order PUT: the team is resolved first (missing or deleted = 404 for every caller), then
 * `requireTeamManagerOrAdmin` (403), then the body (a forbidden caller's malformed body stays 403), then the whole-batch validation (400,
 * in the service before the lock). The service re-runs the guard under the plan lock ([PlanRouteDeps.teamManagerGuard]), so only that
 * inner verdict authorizes the write.
 */
internal fun Route.teamScheduleRoutes(d: PlanRouteDeps, schedules: TeamScheduleService, proposals: ScheduleProposalService) {
    proposalRoute(d, proposals)
    batchScheduleRoute(d, schedules)
}

/**
 * `POST /teams/{id}/schedule-proposal`: the auto-proposal for ONE team's not-yet-started milestones; a computation, so `200` with no
 * `Location`, no lock, no revision bump and NO audit event (like the view GETs; `observability.md`). The same guard as the batch, run
 * once - nothing is written, so there is no inner re-guard: read-before-guard (the team resolved first, missing or deleted = 404 for
 * every caller), `requireTeamManagerOrAdmin` (403), then the body (a forbidden caller's malformed body stays 403), then `asOf` (400).
 */
private fun Route.proposalRoute(d: PlanRouteDeps, proposals: ScheduleProposalService) {
    post<TeamScheduleProposalRoute> { route ->
        val caller = call.caller()
        d.requireTeamManager(caller, route.id)
        val request = call.receive<ScheduleProposalRequest>()
        val asOf = validateProposalRequest(request)
        call.respond(HttpStatusCode.OK, proposals.propose(route.id, asOf) ?: throw NotFoundException("Team not found"))
    }
}

/**
 * `POST /teams/{id}/milestone-schedules`: the batch accept. A `POST` (not a replace: unlisted milestones keep their dates); answers 200
 * `{revision, accepted, skipped}`. Audit: `milestone.scheduled` per accepted item whose dates actually changed (the single PUT's fields,
 * so the trail reads the same however a bar moved) and ONE `team.schedule_batch_applied` per accepted request, an all-skipped one
 * included; a 4xx emits nothing of its own.
 */
private fun Route.batchScheduleRoute(d: PlanRouteDeps, schedules: TeamScheduleService) {
    post<TeamMilestoneSchedulesRoute> { route ->
        val caller = call.caller()
        d.requireTeamManager(caller, route.id)
        val request = call.receive<TeamScheduleBatchRequest>()
        val outcome = schedules.batch(route.id, request, d.teamManagerGuard(caller))
        val byUserId = caller.userId.toLong()
        for (item in outcome.accepted.filter { it.from != it.to }) {
            audit(
                "milestone.scheduled",
                "byUserId" to byUserId,
                "milestoneId" to item.milestoneId.toLong(),
                "teamId" to route.id.toLong(),
                "startFrom" to item.from?.start?.toString(),
                "endFrom" to item.from?.end?.toString(),
                "startTo" to item.to?.start?.toString(),
                "endTo" to item.to?.end?.toString(),
                "revisionTo" to outcome.revision,
            )
        }
        audit(
            "team.schedule_batch_applied",
            "byUserId" to byUserId,
            "teamId" to route.id.toLong(),
            "revisionTo" to outcome.revision,
            "acceptedCount" to outcome.accepted.size,
            "skippedCount" to outcome.skipped.size,
            "acceptedIds" to outcome.accepted.map { it.milestoneId }.sorted().joinToString(","),
            "skippedIds" to outcome.skipped.map { it.milestoneId }.sorted().joinToString(","),
        )
        call.respond(
            HttpStatusCode.OK,
            TeamScheduleBatchResponse(outcome.revision, outcome.accepted.map { it.milestoneId }, outcome.skipped),
        )
    }
}
