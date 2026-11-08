package ch.nokillswit.flow

import ch.nokillswit.audit.audit
import ch.nokillswit.authz.caller
import ch.nokillswit.authz.orNotFound
import ch.nokillswit.authz.requireAdmin
import ch.nokillswit.infra.fetch.SKIPPED_CODE
import ch.nokillswit.infra.outbound.FlowOrigins
import ch.nokillswit.plugins.RateLimits
import io.ktor.http.HttpStatusCode
import io.ktor.resources.Resource
import io.ktor.server.plugins.ratelimit.RateLimitName
import io.ktor.server.plugins.ratelimit.rateLimit
import io.ktor.server.request.receive
import io.ktor.server.resources.post
import io.ktor.server.response.respond
import io.ktor.server.routing.Route
import kotlinx.serialization.Serializable

/** `POST /api/v1/integrations/flow/connections/test`: the ad-hoc test, carrying the token in its body. */
@Serializable
@Resource("test")
class FlowAdHocTestRoute(val parent: FlowConnectionsRoute = FlowConnectionsRoute())

/** `POST …/connections/{id}/test`: the stored connection, with its decrypted token. */
@Serializable
@Resource("test")
class FlowStoredTestRoute(val parent: FlowConnectionsRoute.Id)

/**
 * Test connection (ADMIN only, `requireAdmin` first on both routes: guard-before-read like the registry). A test makes two outbound calls
 * with the token, so both POSTs ride the per-IP `FLOW_TEST` bucket; neither ever answers 502 - a failed probe, an upstream failure and a
 * stored token that cannot be decrypted are ROWS in a `200`. Nothing holds a database transaction across the calls: the stored target is
 * read first, the outcome recorded after.
 */
internal fun Route.flowTestRoutes(connections: FlowConnectionService, connector: FlowConnector, origins: FlowOrigins) {
    rateLimit(RateLimitName(RateLimits.FLOW_TEST)) {
        post<FlowAdHocTestRoute> {
            val caller = call.caller()
            requireAdmin(caller)
            val request = sanitizedFlowConnection(call.receive())
            validateFlowConnection(request, apiTokenRequired = true, origins::baseUrlVerdict)
            val result = connector.testConnection(FlowTestTarget(request.baseUrl, request.timeZone, request.apiToken))
            auditTest(caller.userId, null, request.baseUrl, result)
            call.respond(HttpStatusCode.OK, result)
        }
        post<FlowStoredTestRoute> { route ->
            val caller = call.caller()
            requireAdmin(caller)
            val id = route.parent.id
            val stored = connections.readForTest(id).orNotFound("Flow connection")
            val target = FlowTestTarget(stored.baseUrl, stored.timeZone, stored.apiToken, stored.expectedUpdatedAt)
            val result = connector.testConnection(target)
            // The verdict is the real one; a result that judged an older row (an edit raced the test) is dropped (`recorded` false).
            val recorded = connections.recordTest(id, stored.expectedUpdatedAt, result.passed, System.currentTimeMillis())
            val answered = result.copy(recorded = recorded)
            auditTest(caller.userId, id, stored.baseUrl, answered)
            call.respond(HttpStatusCode.OK, answered)
        }
    }
}

/**
 * `flow.connection_tested`: who, which connection (null = ad hoc), the Flow HOST, the verdict and the failed probe names (a SKIPPED row
 * did not run and is no failure) - never the token.
 */
private fun auditTest(byUserId: UInt, connectionId: UInt?, baseUrl: String, result: FlowTestResult) {
    audit(
        "flow.connection_tested",
        "byUserId" to byUserId.toLong(),
        "connectionId" to connectionId?.toLong(),
        "host" to flowHostOf(baseUrl),
        "ok" to result.passed,
        "failedProbes" to result.rows.filter { !it.ok && it.code != SKIPPED_CODE }.map { it.name },
        "recorded" to result.recorded,
    )
}
