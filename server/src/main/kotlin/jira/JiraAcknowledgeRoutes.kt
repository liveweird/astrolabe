package ch.nokillswit.jira

import ch.nokillswit.audit.audit
import ch.nokillswit.authz.CallerPrincipal
import ch.nokillswit.authz.caller
import ch.nokillswit.authz.isAdmin
import ch.nokillswit.authz.orNotFound
import ch.nokillswit.authz.requireOwnerOrTeamManagerOrAdmin
import ch.nokillswit.infra.paging.optionalEnum
import ch.nokillswit.people.PersonService
import ch.nokillswit.planning.DeviationKind
import ch.nokillswit.teams.TeamService
import io.ktor.http.HttpStatusCode
import io.ktor.http.Parameters
import io.ktor.resources.Resource
import io.ktor.server.application.*
import io.ktor.server.plugins.BadRequestException
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
 * The acknowledge guard of both calls: the owner chain of the bound node or ADMIN, the bind's guard, and since 1.12 - for a MILESTONE
 * binding only - the ACTIVE manager of the milestone's team (whoever stamped the acknowledgement; program and project bindings are
 * unchanged). Outside the transaction the person and the manager are read plainly ([require]); under the binding's row lock the
 * person is re-resolved `FOR SHARE` and a non-owner's team and its manager's person are locked `FOR SHARE` too ([requireLocked]).
 */
private class AcknowledgeGuards(private val people: PersonService, private val teams: TeamService) {
    /** The caller's ACTIVE person, or null (not looked up for an ADMIN, who needs no ownership). */
    private suspend fun personOf(caller: CallerPrincipal): UInt? = if (caller.isAdmin()) null else people.activePersonIdOf(caller.userId)

    /** The same, locking the person row `FOR SHARE` for the transaction that follows: the guard's second run. */
    private suspend fun lockedPersonOf(caller: CallerPrincipal): UInt? =
        if (caller.isAdmin()) null else people.lockedActivePersonIdOf(caller.userId)

    suspend fun require(caller: CallerPrincipal, audience: AckAudience) =
        requireOwnerOrTeamManagerOrAdmin(caller, personOf(caller), audience.owners, audience.teamId, teams::isActiveManager)

    suspend fun requireLocked(caller: CallerPrincipal, audience: AckAudience) =
        requireOwnerOrTeamManagerOrAdmin(caller, lockedPersonOf(caller), audience.owners, audience.teamId, teams::lockedIsActiveManager)
}

/**
 * The `?kind=` of the DELETE: absent = every row; present, it must be a [DeviationKind] name (a blank or unknown value is a `400`).
 * Fails closed: a query parameter of any other NAME (a misspelt `kinds`, `kind[]`) is a `400` too, because ignoring it would withdraw
 * every stored acknowledgement of the binding. The name is not echoed.
 */
private fun Parameters.kindParameter(): DeviationKind? {
    if (names().any { it != "kind" }) throw BadRequestException("Unknown query parameter (the only one accepted is kind)")
    val kind = optionalEnum<DeviationKind>("kind")
    if (kind == null && contains("kind")) {
        throw BadRequestException("Unknown kind (allowed: ${DeviationKind.entries.joinToString { it.name }})")
    }
    return kind
}

/** The fields every acknowledge audit line carries. */
private fun auditFields(userId: UInt, bindingId: UInt, connectionId: UInt, level: JiraLevel, nodeId: UInt, issueKey: String) = arrayOf(
    "byUserId" to userId.toLong(),
    "bindingId" to bindingId.toLong(),
    "connectionId" to connectionId.toLong(),
    "level" to level.name,
    "nodeId" to nodeId.toLong(),
    "issueKey" to issueKey,
)

/**
 * Acknowledge a binding's deviations until they change (1.3), per line since 1.12: the owner chain of the bound node or ADMIN, the
 * bind's guard, and since 1.12 - for a MILESTONE binding only - the ACTIVE manager of the milestone's team ([AcknowledgeGuards]), in
 * the plan nodes' **read-before-guard** order. The binding comes from the PATH, so the node is addressed before anything is decoded:
 * the binding's ACTIVE audience first (unknown, unbound, or a binding whose node or an ancestor is gone: `404` for EVERY caller), then
 * the guard (`403`, whatever the body is), then the body (`400`) or, for the DELETE, the `kind` parameter (`400`). The service runs
 * the guard again under the binding's row lock with the caller's person re-resolved `FOR SHARE` and the milestone's STORED team
 * re-read, the team and its manager's person locked `FOR SHARE`; the stale-fingerprint `409` and the withdrawal's `404` ("nothing
 * stored") are decided there too. The audit lines are written after the commit and a refused request writes none: one
 * `jira.deviation_acknowledged` / `jira.deviation_unacknowledged` line per stamped / cleared row (the same fields whether the request
 * named a kind or not), and for the KIND-LESS form one batch line before them, `jira.deviations_acknowledged` /
 * `jira.deviations_unacknowledged`. No rate bucket: nothing here calls Jira.
 */
internal fun Route.jiraAcknowledgeRoutes(acknowledgements: JiraAcknowledgeService, people: PersonService, teams: TeamService) {
    val guards = AcknowledgeGuards(people, teams)

    post<JiraAcknowledgeRoute> { route ->
        val caller = call.caller()
        guards.require(caller, acknowledgements.audienceOf(route.id).orNotFound("Jira binding"))
        val request = validateAcknowledge(call.receive<AcknowledgeRequest>())
        val outcome = acknowledgements.acknowledge(route.id, request.fingerprint, request.kind, caller.userId) { locked ->
            guards.requireLocked(caller, locked)
        }
        val common = auditFields(caller.userId, route.id, outcome.connectionId, outcome.level, outcome.nodeId, outcome.issueKey)
        if (outcome.requestedKind == null) {
            audit(
                "jira.deviations_acknowledged", *common,
                "count" to outcome.lines.size,
                "kinds" to outcome.lines.joinToString(",") { it.kind.name },
                "listFingerprint" to request.fingerprint,
            )
        }
        for (line in outcome.lines) {
            audit(
                "jira.deviation_acknowledged", *common,
                "kind" to line.kind.name, "severity" to line.severity.name, "fingerprint" to line.fingerprint,
            )
        }
        call.respond(HttpStatusCode.OK, outcome.acknowledgement)
    }
    delete<JiraAcknowledgeRoute> { route ->
        val caller = call.caller()
        guards.require(caller, acknowledgements.audienceOf(route.id).orNotFound("Jira binding"))
        val kind = call.request.queryParameters.kindParameter()
        val outcome = acknowledgements.unacknowledge(route.id, kind) { locked -> guards.requireLocked(caller, locked) }
        val common = auditFields(caller.userId, route.id, outcome.connectionId, outcome.level, outcome.nodeId, outcome.issueKey)
        if (outcome.requestedKind == null) {
            audit(
                "jira.deviations_unacknowledged", *common,
                "count" to outcome.rows.size,
                "kinds" to outcome.rows.joinToString(",") { it.kind },
            )
        }
        for (row in outcome.rows) {
            audit("jira.deviation_unacknowledged", *common, "kind" to row.kind, "fingerprint" to row.fingerprint)
        }
        call.respond(HttpStatusCode.NoContent)
    }
}
