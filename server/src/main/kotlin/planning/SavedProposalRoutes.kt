package ch.nokillswit.planning

import ch.nokillswit.audit.audit
import ch.nokillswit.authz.caller
import ch.nokillswit.authz.orNotFound
import ch.nokillswit.authz.requireTeamManagerOfAllOrAdmin
import ch.nokillswit.plugins.RateLimits
import io.ktor.http.HttpHeaders
import io.ktor.http.HttpStatusCode
import io.ktor.resources.Resource
import io.ktor.server.application.*
import io.ktor.server.plugins.ratelimit.RateLimitName
import io.ktor.server.plugins.ratelimit.rateLimit
import io.ktor.server.request.receive
import io.ktor.server.resources.delete
import io.ktor.server.resources.get
import io.ktor.server.resources.href
import io.ktor.server.resources.post
import io.ktor.server.response.header
import io.ktor.server.response.respond
import io.ktor.server.routing.Route
import kotlinx.serialization.Serializable

@Serializable
@Resource("/api/v1/saved-schedule-proposals")
class SavedProposalsRoute {
    @Serializable
    @Resource("{id}")
    class Id(val parent: SavedProposalsRoute = SavedProposalsRoute(), val id: UInt)
}

/**
 * The saved cross-team proposals (V32, `scheduling.md` "Saved proposals"). Not plan state: no plan lock and no revision bump. Reads
 * are every authenticated caller's and emit no audit event; a rejected write (400/404/409) emits nothing, a 403 is the central
 * `authz.denied`.
 *
 * `POST` is the FOURTH body-first cross-team POST (the team set is in the body). The per-USER `schedule-proposal-save` bucket rides
 * the route node, so it runs first (a refused save spends a token too). Then the body decodes (`400`), [validateTeamIds] `400`,
 * every team ACTIVE else `404` for every caller, then ADMIN or the manager of EVERY listed team else `403`
 * ([PlanRouteDeps.requireTeamManagers]), then the rest of the shape `400` ([validateSavedProposalSave]; a forbidden caller's
 * malformed name stays `403`), then [SavedProposalService.save]'s transaction, which RE-RUNS the manager-of-every-team guard right
 * after its table lock (a manager cleared while the save waited is a `403`, nothing stored), then the two `409`s, then a ticked id
 * that is no move `400`. `DELETE` is READ-BEFORE-GUARD (the stored teams are the guard's input): a missing id is `404` for every
 * caller, then ADMIN or the manager of every stored team else `403`, then the hard delete (two short transactions, no inner guard:
 * it waits for no lock but a save's table lock).
 */
internal fun Route.savedProposalRoutes(d: PlanRouteDeps, service: SavedProposalService) {
    rateLimit(RateLimitName(RateLimits.SCHEDULE_PROPOSAL_SAVE)) {
        post<SavedProposalsRoute> {
            val caller = call.caller()
            val request = call.receive<SavedProposalSaveRequest>()
            val teamIds = validateTeamIds(request.teamIds)
            d.requireTeamManagers(caller, teamIds)
            val command = validateSavedProposalSave(request)
            val guard: suspend () -> Unit = { requireTeamManagerOfAllOrAdmin(caller, teamIds, d.teams::activeManagedTeamIds) }
            val saved = service.save(caller.userId, d.actor(caller, withManagedTeams = true), command, guard)
            val summary = saved.summary
            audit(
                "schedule_proposal.saved",
                "byUserId" to caller.userId.toLong(),
                "savedProposalId" to summary.id.toLong(),
                "name" to summary.name,
                "teamIds" to summary.teams.map { it.id }.sorted().joinToString(","),
                "asOf" to summary.asOf,
                "revision" to summary.planRevision,
                "moveCount" to summary.moveCount,
                "selectedCount" to summary.selectedCount,
                "prunedIds" to saved.prunedIds.joinToString(","),
            )
            call.response.header(HttpHeaders.Location, call.application.href(SavedProposalsRoute.Id(id = summary.id)))
            call.respond(HttpStatusCode.Created, summary)
        }
    }
    get<SavedProposalsRoute> {
        val caller = call.caller()
        call.respond(HttpStatusCode.OK, SavedProposalList(service.list(d.actor(caller, withManagedTeams = true))))
    }
    get<SavedProposalsRoute.Id> { route ->
        val caller = call.caller()
        call.respond(HttpStatusCode.OK, service.read(route.id, d.actor(caller, withManagedTeams = true)).orNotFound("Saved proposal"))
    }
    delete<SavedProposalsRoute.Id> { route ->
        val caller = call.caller()
        val header = service.headerOf(route.id).orNotFound("Saved proposal")
        requireTeamManagerOfAllOrAdmin(caller, header.teamIds, d.teams::activeManagedTeamIds)
        service.delete(route.id).orNotFound("Saved proposal")
        audit(
            "schedule_proposal.deleted",
            "byUserId" to caller.userId.toLong(),
            "savedProposalId" to route.id.toLong(),
            "name" to header.name,
        )
        call.respond(HttpStatusCode.NoContent)
    }
}
