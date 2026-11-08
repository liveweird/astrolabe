package ch.nokillswit.jira

import ch.nokillswit.audit.audit
import ch.nokillswit.authz.ConflictException
import ch.nokillswit.authz.caller
import ch.nokillswit.authz.orNotFound
import ch.nokillswit.authz.requireAdmin
import ch.nokillswit.infra.fetch.SKIPPED_CODE
import ch.nokillswit.plugins.RateLimits
import io.ktor.http.ContentType
import io.ktor.http.HttpStatusCode
import io.ktor.resources.Resource
import io.ktor.server.plugins.ratelimit.RateLimitName
import io.ktor.server.plugins.ratelimit.rateLimit
import io.ktor.server.request.receive
import io.ktor.server.resources.get
import io.ktor.server.resources.post
import io.ktor.server.response.respond
import io.ktor.server.response.respondText
import io.ktor.server.routing.Route
import kotlinx.serialization.Serializable

/** `POST /api/v1/integrations/jira/connections/test`: the ad-hoc test, carrying the token in its body. */
@Serializable
@Resource("test")
class JiraAdHocTestRoute(val parent: JiraConnectionsRoute = JiraConnectionsRoute())

/** `POST …/connections/{id}/test`: the stored connection, with its decrypted token. */
@Serializable
@Resource("test")
class JiraStoredTestRoute(val parent: JiraConnectionsRoute.Id)

/** `GET …/connections/{id}/discovery`: the stored field/issue-type snapshot and what the marker rules resolved. */
@Serializable
@Resource("discovery")
class JiraDiscoveryRoute(val parent: JiraConnectionsRoute.Id)

/**
 * Test connection and the discovery report (ADMIN only, `requireAdmin` first on every route: guard-before-read like the registry). A test
 * makes up to ~10 outbound calls, so both POSTs ride the per-IP `JIRA_TEST` bucket; neither ever answers 502 - a failed probe, an
 * upstream failure and a stored token that cannot be decrypted are all ROWS in a `200`. Nothing holds a database transaction across the
 * calls: the stored target is read first, the outcome recorded after.
 */
internal fun Route.jiraTestRoutes(connections: JiraConnectionService, recorder: JiraTestRecorder, connector: JiraConnector) {
    rateLimit(RateLimitName(RateLimits.JIRA_TEST)) {
        post<JiraAdHocTestRoute> {
            val caller = call.caller()
            requireAdmin(caller)
            val request = sanitizedJiraConnection(call.receive())
            validateJiraConnection(request, apiTokenRequired = true)
            val target = JiraTestTarget(request.siteUrl, request.email, request.apiToken, request.authScheme, request.projectKeys)
            val outcome = connector.testConnection(target)
            auditTest(caller.userId, null, request.siteUrl, outcome.result)
            call.respond(HttpStatusCode.OK, outcome.result)
        }
        post<JiraStoredTestRoute> { route ->
            val caller = call.caller()
            requireAdmin(caller)
            val id = route.parent.id
            val target = connections.readForTest(id).orNotFound("Jira connection")
            val outcome = connector.testConnection(target)
            val passed = outcome.result.passed
            // The snapshot is kept whenever `field` and `issuetype` both answered, whatever else failed; the verdict is the real one.
            val recording = recorder.recordTest(
                id, checkNotNull(target.expectedUpdatedAt), outcome.result.cloudId, passed, outcome.discovery, System.currentTimeMillis(),
            )
            val answered = outcome.result.copy(discoveredAt = recording.discoveredAt, recorded = recording.recorded)
            auditTest(caller.userId, id, target.siteUrl, answered)
            call.respond(HttpStatusCode.OK, answered)
        }
    }
    get<JiraDiscoveryRoute> { route ->
        requireAdmin(call.caller())
        val stored = recorder.readDiscovery(route.parent.id).orNotFound("Jira connection")
        if (stored == NO_DISCOVERY) {
            throw ConflictException("Test the connection first - no discovery has been stored yet", JIRA_NOT_DISCOVERED_PROBLEM)
        }
        call.respondText(stored, ContentType.Application.Json)
    }
}

/**
 * `jira.connection_tested`: who, which connection (null = ad hoc), the site HOST, the verdict and the failed probe names (a SKIPPED row
 * did not run and is no failure) - never the token.
 */
private fun auditTest(byUserId: UInt, connectionId: UInt?, siteUrl: String, result: JiraTestResult) {
    audit(
        "jira.connection_tested",
        "byUserId" to byUserId.toLong(),
        "connectionId" to connectionId?.toLong(),
        "host" to jiraHostOf(siteUrl),
        "ok" to result.passed,
        "failedProbes" to result.rows.filter { !it.ok && it.code != SKIPPED_CODE }.map { it.name },
        "recorded" to result.recorded,
        "stub" to result.stub,
    )
}
