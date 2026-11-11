package ch.nokillswit.jira

import ch.nokillswit.audit.audit
import ch.nokillswit.authz.CallerPrincipal
import ch.nokillswit.authz.caller
import ch.nokillswit.authz.isAdmin
import ch.nokillswit.authz.orNotFound
import ch.nokillswit.authz.requireOwnerOrTeamManagerOrAdmin
import ch.nokillswit.people.PersonService
import ch.nokillswit.teams.TeamService
import io.ktor.http.HttpStatusCode
import io.ktor.resources.Resource
import io.ktor.server.application.*
import io.ktor.server.request.receive
import io.ktor.server.resources.delete
import io.ktor.server.resources.post
import io.ktor.server.response.respond
import io.ktor.server.routing.Route
import kotlinx.serialization.Serializable

@Serializable
@Resource("/api/v1/integrations/jira/bindings/{id}/acknowledge")
class JiraAcknowledgeRoute(val id: UInt)

/**
 * Acknowledge a binding's deviations until they change (1.3): the owner chain of the bound node or ADMIN, the bind's guard, and since
 * 1.12 - for a MILESTONE binding only - the ACTIVE manager of the milestone's team (whoever stamped the acknowledgement; program and
 * project bindings are unchanged), in the plan nodes' **read-before-guard** order. The binding comes from the PATH, so the node is
 * addressed before anything is decoded: the binding's ACTIVE audience first (unknown, unbound, or a binding whose node or an ancestor is
 * gone: `404` for EVERY caller), then `requireOwnerOrTeamManagerOrAdmin` (`403`, whatever the body is; `TeamService.isActiveManager`
 * outside), then the body (`400`). The service runs the guard again under the binding's row lock with the caller's person re-resolved
 * `FOR SHARE` and the milestone's STORED team re-read, the team and its manager's person locked `FOR SHARE`
 * (`TeamService.lockedIsActiveManager`); the stale-fingerprint `409` is decided there too. The audit lines are written after the commit.
 * No rate bucket: nothing here calls Jira.
 */
internal fun Route.jiraAcknowledgeRoutes(acknowledgements: JiraAcknowledgeService, people: PersonService, teams: TeamService) {
    /** The caller's ACTIVE person, or null (not looked up for an ADMIN, who needs no ownership). */
    suspend fun personOf(caller: CallerPrincipal): UInt? = if (caller.isAdmin()) null else people.activePersonIdOf(caller.userId)

    /** The same, locking the person row `FOR SHARE` for the transaction that follows: the guard's second run. */
    suspend fun lockedPersonOf(caller: CallerPrincipal): UInt? =
        if (caller.isAdmin()) null else people.lockedActivePersonIdOf(caller.userId)

    /**
     * The guard: the owner chain, the milestone's team manager or ADMIN. Outside the transaction [isManager] is `isActiveManager`; under
     * the binding's row lock it is `lockedIsActiveManager` (team and manager's person `FOR SHARE`), asked AFTER the caller's person.
     */
    suspend fun requireAcknowledger(
        caller: CallerPrincipal,
        personId: UInt?,
        audience: AckAudience,
        isManager: suspend (UInt, UInt) -> Boolean,
    ) = requireOwnerOrTeamManagerOrAdmin(caller, personId, audience.owners, audience.teamId, isManager)

    post<JiraAcknowledgeRoute> { route ->
        val caller = call.caller()
        val audience = acknowledgements.audienceOf(route.id).orNotFound("Jira binding")
        requireAcknowledger(caller, personOf(caller), audience, teams::isActiveManager)
        val request = validateAcknowledge(call.receive<AcknowledgeRequest>())
        val outcome = acknowledgements.acknowledge(route.id, request.fingerprint, caller.userId) { locked ->
            requireAcknowledger(caller, lockedPersonOf(caller), locked, teams::lockedIsActiveManager)
        }
        audit(
            "jira.deviation_acknowledged",
            "byUserId" to caller.userId.toLong(),
            "bindingId" to route.id.toLong(),
            "connectionId" to outcome.connectionId.toLong(),
            "level" to outcome.level.name,
            "nodeId" to outcome.nodeId.toLong(),
            "issueKey" to outcome.issueKey,
            "kinds" to outcome.kinds.joinToString(","),
            "fingerprint" to request.fingerprint,
        )
        call.respond(HttpStatusCode.OK, outcome.acknowledgement)
    }
    delete<JiraAcknowledgeRoute> { route ->
        val caller = call.caller()
        val audience = acknowledgements.audienceOf(route.id).orNotFound("Jira binding")
        requireAcknowledger(caller, personOf(caller), audience, teams::isActiveManager)
        val outcome = acknowledgements.unacknowledge(route.id) { locked ->
            requireAcknowledger(caller, lockedPersonOf(caller), locked, teams::lockedIsActiveManager)
        }
        audit(
            "jira.deviation_unacknowledged",
            "byUserId" to caller.userId.toLong(),
            "bindingId" to route.id.toLong(),
            "connectionId" to outcome.connectionId.toLong(),
            "level" to outcome.level.name,
            "nodeId" to outcome.nodeId.toLong(),
            "issueKey" to outcome.issueKey,
            "fingerprint" to outcome.fingerprint,
        )
        call.respond(HttpStatusCode.NoContent)
    }
}
