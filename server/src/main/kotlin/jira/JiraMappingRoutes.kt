package ch.nokillswit.jira

import ch.nokillswit.audit.audit
import ch.nokillswit.authz.ConflictException
import ch.nokillswit.authz.NotFoundException
import ch.nokillswit.authz.caller
import ch.nokillswit.authz.orNotFound
import ch.nokillswit.authz.requireAdmin
import ch.nokillswit.infra.fetch.FetchException
import ch.nokillswit.infra.paging.singleValue
import ch.nokillswit.plugins.RateLimits
import ch.nokillswit.plugins.respondProblem
import io.ktor.http.HttpStatusCode
import io.ktor.resources.Resource
import io.ktor.server.plugins.BadRequestException
import io.ktor.server.plugins.ratelimit.RateLimitName
import io.ktor.server.plugins.ratelimit.rateLimit
import io.ktor.server.request.receive
import io.ktor.server.resources.get
import io.ktor.server.resources.put
import io.ktor.server.response.respond
import io.ktor.server.routing.Route
import kotlinx.serialization.Serializable

/** `GET`/`PUT …/connections/{id}/mapping`: the connection's field mapping (stored, defaults, effective) and its replacement. */
@Serializable
@Resource("mapping")
class JiraMappingRoute(val parent: JiraConnectionsRoute.Id)

/** `GET …/connections/{id}/peek?key=ABC-12`: one issue read through the mapping, to see what a real site yields before any binding. */
@Serializable
@Resource("peek")
class JiraPeekRoute(val parent: JiraConnectionsRoute.Id)

/**
 * The mapping and Peek (ADMIN only, `requireAdmin` first on every route: guard-before-read like the registry). The PUT checks the rules
 * that need no discovery before any database read, then the service re-checks all of them under the row lock against the snapshot it
 * reads. Peek makes two outbound calls with the stored token (the unauthenticated `tenant_info`, then the issue), so it rides the per-IP
 * `jira-test` bucket; it holds no database transaction across them, stores nothing and audits nothing (a read).
 */
internal fun Route.jiraMappingRoutes(connections: JiraConnectionService, connector: JiraConnector) {
    get<JiraMappingRoute> { route ->
        requireAdmin(call.caller())
        val state = connections.readMapping(route.parent.id).orNotFound("Jira connection")
        val defaults = state.discovery?.let(JiraMappingDefaults::resolve)
        val stored = state.mapping
        val discovery = state.discovery
        val problems = when {
            state.stored == StoredMapping.Unreadable -> listOf("The stored mapping cannot be read by this version - save a new one")
            stored != null && discovery != null -> mappingProblems(stored, discovery)
            else -> emptyList()
        }
        call.respond(
            HttpStatusCode.OK,
            JiraMappingResponse(state.mapping, defaults, state.mapping ?: defaults, state.discovery?.discoveredAt, problems),
        )
    }
    put<JiraMappingRoute> { route ->
        val caller = call.caller()
        requireAdmin(caller)
        val document = call.receive<JiraMapping>()
        validateMappingShape(document)
        val outcome = connections.writeMapping(route.parent.id, document).orNotFound("Jira connection")
        // The canonical document's digests, never the document: the digest is all an audit needs.
        audit(
            "jira.mapping_changed",
            "byUserId" to caller.userId.toLong(),
            "connectionId" to route.parent.id.toLong(),
            "beforeSha256" to outcome.beforeSha256,
            "afterSha256" to outcome.afterSha256,
        )
        call.respond(HttpStatusCode.NoContent)
    }
    rateLimit(RateLimitName(RateLimits.JIRA_TEST)) {
        get<JiraPeekRoute> { route ->
            requireAdmin(call.caller())
            val key = call.request.queryParameters.singleValue("key")?.trim()?.takeIf(ISSUE_KEY_PATTERN::matches)
                ?: throw BadRequestException("key must be a Jira issue key such as ABC-12")
            val context = connections.readForPeek(route.parent.id).orNotFound("Jira connection")
            val target = context.target
            requireInScope(key, target.projectKeys)
            val discovery = context.state.discovery ?: throw ConflictException(NOT_DISCOVERED_DETAIL, JIRA_NOT_DISCOVERED_PROBLEM)
            val token = target.apiToken
                ?: throw ConflictException("The stored API token cannot be decrypted - enter it again", JIRA_TOKEN_UNREADABLE_PROBLEM)
            val mapping = context.state.mapping ?: JiraMappingDefaults.resolve(discovery)
            val response = try {
                val issue = connector.peek(target, token, key, mapping) ?: throw NotFoundException("Jira issue not found")
                peekResponse(issue, mapping, discovery)
            } catch (failure: FetchException) {
                // The code only: the exception's text names an endpoint; nothing of the upstream body or the credentials reaches a client.
                call.respondProblem(HttpStatusCode.BadGateway, "Jira did not answer (${failure.code})", type = JIRA_UPSTREAM_PROBLEM)
                return@get
            }
            // A moved issue answers under its NEW key: that project must be in scope too.
            requireInScope(response.issue.key, target.projectKeys)
            call.respond(HttpStatusCode.OK, response)
        }
    }
}

private const val NOT_DISCOVERED_DETAIL = "Test the connection first - no discovery has been stored yet"

internal fun requireInScope(issueKey: String, projectKeys: List<String>) {
    if (issueKey.substringBeforeLast('-') !in projectKeys) {
        throw BadRequestException("$issueKey is outside the connection's project keys")
    }
}
