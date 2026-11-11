package ch.nokillswit.flow

import ch.nokillswit.audit.audit
import ch.nokillswit.authz.caller
import ch.nokillswit.authz.orNotFound
import ch.nokillswit.authz.requireTeamManagerOrAdmin
import ch.nokillswit.infra.paging.optionalLong
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

/**
 * `POST|DELETE /api/v1/integrations/flow/team-bindings/{id}/acknowledge`: acknowledge ("known, leave it") or withdraw ONE sprint's
 * capacity deviation of the bound team; the DELETE names the row with `?sprintId=` (absent = the team's own `TEAM_GONE` row).
 */
@Serializable
@Resource("acknowledge")
class CapacityAcknowledgeRoute(val parent: FlowTeamBindingsRoute.Id)

/** `POST …/team-bindings/{id}/acknowledge-all` (1.10): every row the client names, one all-or-nothing write. */
@Serializable
@Resource("acknowledge-all")
class CapacityAcknowledgeAllRoute(val parent: FlowTeamBindingsRoute.Id)

/** `POST …/team-bindings/{id}/unacknowledge-all` (1.11): the batch withdrawal of the rows the client lists as acknowledged. */
@Serializable
@Resource("unacknowledge-all")
class CapacityUnacknowledgeAllRoute(val parent: FlowTeamBindingsRoute.Id)

private const val BINDING = "Flow team binding"

/** The audit value of a row's sprint: the Flow sprint id, or `none` for the team's own row. */
private fun sprintAuditValue(sprintId: Long?): Any = sprintId ?: "none"

/**
 * The capacity acknowledge (1.9): the team's active manager or ADMIN (`requireTeamManagerOrAdmin`, the capacity import's guard), in the
 * import routes' **read-before-guard** order. The binding comes from the PATH, so the team is addressed before anything is decoded: the
 * binding (of an ACTIVE team) first - unknown, unlinked or its team deleted = `404` for EVERY caller (team ids are public) - then the
 * guard (`403`, whatever the body is), then the body (`400`), or for the DELETE the `sprintId` parameter (`400`: repeated, malformed or
 * below 1). The service runs the guard again under the binding's row lock with the team and the manager's person locked `FOR SHARE`;
 * the stale-fingerprint `409` and the withdrawal's `404` ("nothing stored") are decided there too. The audit lines are written after
 * the commit; a refused request writes none of its own. The acknowledge also prunes the binding's stored rows that are no longer listed
 * (1.10, under the same lock) and then audits `flow.capacity_acknowledgements_cleared` after its own line. No rate bucket: nothing
 * here calls Flow. The batch (1.10) follows the same order; its audit is one `flow.capacity_deviations_acknowledged` line, one single-write
 * line per row (the same fields, in the request's order) and then the cleared line. The batch withdrawal (1.11) is the same order with
 * the sprint list in the body's place: one `flow.capacity_deviations_unacknowledged` line, then the single withdrawal's line per row;
 * it answers 204, recomputes nothing and prunes nothing.
 */
internal fun Route.capacityAcknowledgeRoutes(
    acknowledgements: CapacityAcknowledgeService,
    bindings: FlowTeamBindingService,
    teams: TeamService,
) {
    post<CapacityAcknowledgeRoute> { route ->
        val caller = call.caller()
        val id = route.parent.id
        val teamId = bindings.teamIdOf(id).orNotFound(BINDING)
        requireTeamManagerOrAdmin(caller, teamId, teams::isActiveManager)
        val request = validateCapacityAcknowledge(call.receive<CapacityAcknowledgeRequest>())
        val outcome = acknowledgements.acknowledge(id, request.sprintId, request.fingerprint, caller.userId) { guarded ->
            requireTeamManagerOrAdmin(caller, guarded, teams::lockedIsActiveManager)
        }
        audit(
            "flow.capacity_deviation_acknowledged",
            "byUserId" to caller.userId.toLong(),
            "bindingId" to id.toLong(),
            "connectionId" to outcome.connectionId.toLong(),
            "teamId" to outcome.teamId.toLong(),
            "flowTeamId" to outcome.flowTeamId.toLong(),
            "sprintId" to sprintAuditValue(request.sprintId),
            "kind" to outcome.kind.name,
            "severity" to outcome.severity.name,
            "fingerprint" to request.fingerprint,
        )
        if (outcome.cleared.isNotEmpty()) {
            auditCapacityAcksCleared(id, outcome.cleared, outcome.connectionId, caller.userId, via = "acknowledge")
        }
        call.respond(HttpStatusCode.OK, outcome.acknowledgement)
    }
    delete<CapacityAcknowledgeRoute> { route ->
        val caller = call.caller()
        val id = route.parent.id
        val teamId = bindings.teamIdOf(id).orNotFound(BINDING)
        requireTeamManagerOrAdmin(caller, teamId, teams::isActiveManager)
        val sprintId = call.request.queryParameters.optionalLong("sprintId")
        val outcome = acknowledgements.unacknowledge(id, sprintId) { guarded ->
            requireTeamManagerOrAdmin(caller, guarded, teams::lockedIsActiveManager)
        }
        audit(
            "flow.capacity_deviation_unacknowledged",
            "byUserId" to caller.userId.toLong(),
            "bindingId" to id.toLong(),
            "connectionId" to outcome.connectionId.toLong(),
            "teamId" to outcome.teamId.toLong(),
            "flowTeamId" to outcome.flowTeamId.toLong(),
            "sprintId" to sprintAuditValue(sprintId),
            "fingerprint" to outcome.fingerprint,
        )
        call.respond(HttpStatusCode.NoContent)
    }
    capacityBatchAcknowledgeRoutes(acknowledgements, bindings, teams)
}

/** The 1.10 batch acknowledge and the 1.11 batch withdrawal (split off [capacityAcknowledgeRoutes] for the method-length rule). */
private fun Route.capacityBatchAcknowledgeRoutes(
    acknowledgements: CapacityAcknowledgeService,
    bindings: FlowTeamBindingService,
    teams: TeamService,
) {
    post<CapacityAcknowledgeAllRoute> { route ->
        // The single acknowledge's order: binding 404 (every caller), guard 403 (whatever the body), body 400, then the locked write.
        val caller = call.caller()
        val id = route.parent.id
        val teamId = bindings.teamIdOf(id).orNotFound(BINDING)
        requireTeamManagerOrAdmin(caller, teamId, teams::isActiveManager)
        val request = validateCapacityAcknowledgeAll(call.receive<CapacityAcknowledgeAllRequest>())
        val outcome = acknowledgements.acknowledgeAll(id, request.items, caller.userId) { guarded ->
            requireTeamManagerOrAdmin(caller, guarded, teams::lockedIsActiveManager)
        }
        val common = arrayOf(
            "byUserId" to caller.userId.toLong(),
            "bindingId" to id.toLong(),
            "connectionId" to outcome.connectionId.toLong(),
            "teamId" to outcome.teamId.toLong(),
            "flowTeamId" to outcome.flowTeamId.toLong(),
        )
        audit(
            "flow.capacity_deviations_acknowledged", *common,
            "count" to outcome.rows.size,
            "sprintIds" to outcome.rows.joinToString(",") { sprintAuditValue(it.acknowledgement.sprintId).toString() },
        )
        for (row in outcome.rows) {
            audit(
                "flow.capacity_deviation_acknowledged", *common,
                "sprintId" to sprintAuditValue(row.acknowledgement.sprintId), "kind" to row.kind.name, "severity" to row.severity.name,
                "fingerprint" to row.acknowledgement.fingerprint,
            )
        }
        if (outcome.cleared.isNotEmpty()) {
            auditCapacityAcksCleared(id, outcome.cleared, outcome.connectionId, caller.userId, via = "acknowledge")
        }
        call.respond(HttpStatusCode.OK, CapacityAcknowledgeBatch(outcome.rows.map { it.acknowledgement }))
    }
    post<CapacityUnacknowledgeAllRoute> { route ->
        // The batch acknowledge's order: binding 404 (every caller), guard 403 (whatever the body), body 400, then the locked write.
        val caller = call.caller()
        val id = route.parent.id
        val teamId = bindings.teamIdOf(id).orNotFound(BINDING)
        requireTeamManagerOrAdmin(caller, teamId, teams::isActiveManager)
        val request = validateCapacityUnacknowledgeAll(call.receive<CapacityUnacknowledgeAllRequest>())
        val outcome = acknowledgements.unacknowledgeAll(id, request.items.map { it.sprintId }) { guarded ->
            requireTeamManagerOrAdmin(caller, guarded, teams::lockedIsActiveManager)
        }
        val common = arrayOf(
            "byUserId" to caller.userId.toLong(),
            "bindingId" to id.toLong(),
            "connectionId" to outcome.connectionId.toLong(),
            "teamId" to outcome.teamId.toLong(),
            "flowTeamId" to outcome.flowTeamId.toLong(),
        )
        audit(
            "flow.capacity_deviations_unacknowledged", *common,
            "count" to outcome.rows.size,
            "sprintIds" to outcome.rows.joinToString(",") { sprintAuditValue(it.first).toString() },
        )
        for ((sprintId, fingerprint) in outcome.rows) {
            audit("flow.capacity_deviation_unacknowledged", *common, "sprintId" to sprintAuditValue(sprintId), "fingerprint" to fingerprint)
        }
        call.respond(HttpStatusCode.NoContent)
    }
}
