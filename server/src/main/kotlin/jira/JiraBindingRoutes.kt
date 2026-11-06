package ch.nokillswit.jira

import ch.nokillswit.audit.audit
import ch.nokillswit.authz.CallerPrincipal
import ch.nokillswit.authz.ConflictException
import ch.nokillswit.authz.caller
import ch.nokillswit.authz.isAdmin
import ch.nokillswit.authz.orNotFound
import ch.nokillswit.authz.requireOwnerOrAdmin
import ch.nokillswit.infra.db.nowMillis
import ch.nokillswit.infra.fetch.FetchException
import ch.nokillswit.infra.fetch.PermitWait
import ch.nokillswit.infra.paging.optionalEnum
import ch.nokillswit.infra.paging.optionalString
import ch.nokillswit.infra.paging.optionalUInt
import ch.nokillswit.infra.paging.parsePaging
import ch.nokillswit.infra.paging.toPage
import ch.nokillswit.people.PersonService
import ch.nokillswit.plugins.RateLimits
import ch.nokillswit.plugins.respondProblem
import io.ktor.http.HttpHeaders
import io.ktor.http.HttpStatusCode
import io.ktor.resources.Resource
import io.ktor.server.application.*
import io.ktor.server.plugins.BadRequestException
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
import kotlinx.coroutines.withContext
import kotlinx.serialization.Serializable

@Serializable
@Resource("/api/v1/integrations/jira/bindings")
class JiraBindingsRoute {
    @Serializable
    @Resource("{id}")
    class Id(val parent: JiraBindingsRoute = JiraBindingsRoute(), val id: UInt)
}

private const val MAX_Q_LENGTH = 100

/**
 * The bindings (any authenticated user reads; the owner chain of the node or ADMIN writes). **Read-before-guard**, the plan nodes'
 * idiom: the node's chain is resolved first (a missing or deleted node is `404` for every caller), then `requireOwnerOrAdmin` (`403`),
 * then the rest of the body (`400`). The node is in the BODY, so the body is decoded first: a body that does not decode (including an
 * unknown `level`) is a `400` before any guard - no node was addressed. The guard runs again inside the bind's transaction against the
 * chain re-read there, with the caller's person re-resolved `FOR SHARE`. An unbind of a binding whose node is gone is guarded by the
 * chain as last stored (`authorization.md`).
 */
internal fun Route.jiraBindingRoutes(
    connections: JiraConnectionService,
    bindings: JiraBindingService,
    people: PersonService,
    connector: JiraConnector,
    /** `jira.bindPermitWaitMillis`: how long a bind may queue for an outbound permit before it answers 502 `BUSY` (a person is waiting). */
    bindPermitWaitMillis: Long,
) {
    /** The caller's ACTIVE person, or null (not looked up for an ADMIN, who needs no ownership). */
    suspend fun personOf(caller: CallerPrincipal): UInt? = if (caller.isAdmin()) null else people.activePersonIdOf(caller.userId)

    /** The same, locking the person row `FOR SHARE` for the transaction that follows: the guard's second run. */
    suspend fun lockedPersonOf(caller: CallerPrincipal): UInt? =
        if (caller.isAdmin()) null else people.lockedActivePersonIdOf(caller.userId)

    get<JiraBindingsRoute> {
        call.caller()
        val query = call.request.queryParameters
        val paging = call.parsePaging(sortable = JIRA_BINDING_SORT_FIELDS)
        val q = query.optionalString("q")?.trim()
        if (q != null && q.length > MAX_Q_LENGTH) throw BadRequestException("q must be at most $MAX_Q_LENGTH characters")
        val filter = JiraBindingFilter(query.optionalUInt("connectionId"), query.optionalEnum<JiraLevel>("level"), q)
        val result = bindings.list(filter, paging)
        call.respond(HttpStatusCode.OK, paging.toPage(result.items, result.total))
    }
    get<JiraBindingsRoute.Id> { route ->
        call.caller()
        call.respond(HttpStatusCode.OK, bindings.read(route.id).orNotFound("Jira binding"))
    }
    // The per-USER bucket rides the route node, i.e. it runs BEFORE the handler and so before the guard: a 403 or 400 spends a token too.
    rateLimit(RateLimitName(RateLimits.JIRA_BIND)) {
        post<JiraBindingsRoute> {
            val caller = call.caller()
            val request = call.receive<JiraBindRequest>()
            requireOwnerOrAdmin(caller, personOf(caller), bindings.chainOf(request.level, request.nodeId).orNotFound(request.level.title()))
            val checked = validateBindRequest(request)
            val observation = try {
                // Interactive: a bind queues for an outbound permit at most [bindPermitWaitMillis], then answers 502 `BUSY` - never ahead
                // of an administrator's Test connection for long (the pool is shared, and its size is what the heap was sized on).
                withContext(PermitWait(bindPermitWaitMillis)) { observeForBind(connections, connector, checked) }
            } catch (failure: FetchException) {
                // The code only: the exception's text names an endpoint; nothing of the upstream body or the credentials reaches a client.
                call.respondProblem(HttpStatusCode.BadGateway, "Jira did not answer (${failure.code})", type = JIRA_UPSTREAM_PROBLEM)
                return@post
            }
            val command = JiraBindCommand(checked.connectionId, checked.level, checked.nodeId, observation, caller.userId)
            val outcome = bindings.bind(command) { chain -> requireOwnerOrAdmin(caller, lockedPersonOf(caller), chain) }
            // After the commit: an audit line inside the transaction could describe a bind that rolled back.
            outcome.released.forEach { released ->
                audit(
                    "jira.binding_released",
                    "byUserId" to caller.userId.toLong(),
                    "bindingId" to released.bindingId.toLong(),
                    "connectionId" to released.connectionId.toLong(),
                    "level" to released.level.name,
                    "nodeId" to released.nodeId.toLong(),
                    "issueKey" to released.issueKey,
                    "reason" to "NODE_GONE",
                )
            }
            val binding = outcome.binding
            audit(
                "jira.binding_created",
                "byUserId" to caller.userId.toLong(),
                "bindingId" to binding.id.toLong(),
                "connectionId" to binding.connectionId.toLong(),
                "level" to binding.level.name,
                "nodeKind" to binding.node.kind.name,
                "nodeId" to binding.node.id.toLong(),
                "issueId" to binding.issueId,
                "issueKey" to binding.issueKey,
            )
            call.response.header(HttpHeaders.Location, call.application.href(JiraBindingsRoute.Id(id = binding.id)))
            call.respond(HttpStatusCode.Created, binding)
        }
    }
    delete<JiraBindingsRoute.Id> { route ->
        val caller = call.caller()
        requireOwnerOrAdmin(caller, personOf(caller), bindings.chainForUnbind(route.id).orNotFound("Jira binding"))
        val outcome = bindings.unbind(route.id) { chain -> requireOwnerOrAdmin(caller, lockedPersonOf(caller), chain) }
        audit(
            "jira.binding_deleted",
            "byUserId" to caller.userId.toLong(),
            "bindingId" to route.id.toLong(),
            "connectionId" to outcome.connectionId.toLong(),
            "level" to outcome.level.name,
            "nodeId" to outcome.nodeId.toLong(),
            "issueId" to outcome.issueId,
            "issueKey" to outcome.issueKey,
        )
        call.respond(HttpStatusCode.NoContent)
    }
}

/**
 * Everything a bind checks BEFORE its transaction, in order, ending with the ONE Jira call (outside any transaction): the connection
 * (unknown, deleted or disabled: `400` on the body field), its token and discovery (`409`, an administrator's to fix), the mapping as
 * stored-or-defaults against the CURRENT discovery (`409 jira-mapping-invalid` for a stale one - the mapping is the connection's state,
 * not the request's, so it is not the `400` of a PUT that submits one), the level's mapping and the key's project scope (`400`), the
 * issue (an unknown one is `400`; an upstream failure surfaces as the [FetchException] the route answers `502`) and finally that the
 * issue sits at the hierarchy level the mapping gives the plan level (`400`, naming both). Returns the issue as the first observation.
 */
private suspend fun observeForBind(
    connections: JiraConnectionService,
    connector: JiraConnector,
    request: JiraBindRequest,
): JiraObservation {
    val context = connections.readForBind(request.connectionId)?.takeIf { it.enabled } ?: throw BadRequestException(UNKNOWN_CONNECTION)
    val target = context.target
    val token = target.apiToken
        ?: throw ConflictException(
            "The stored API token cannot be decrypted - ask an administrator to enter it again", JIRA_TOKEN_UNREADABLE_PROBLEM,
        )
    val discovery = context.state.discovery
        ?: throw ConflictException("The connection has not been tested yet - ask an administrator to test it", JIRA_NOT_DISCOVERED_PROBLEM)
    val mapping = effectiveMapping(context.state, discovery)
    val mapped = mapping.mappedLevels().firstOrNull { it.first == request.level }?.second
        ?: throw BadRequestException("This connection does not map ${request.level.label()}s to a Jira level")
    requireInScope(request.issueKey, target.projectKeys)
    val issue = connector.readIssue(target, token, request.issueKey, observationFields(mapping))
        ?: throw BadRequestException("Unknown Jira issue: ${request.issueKey}")
    val observation = JiraObservation.of(issue, mapping, discovery, request.level, nowMillis())
        ?: throw FetchException(JIRA_SOURCE, "INVALID_RESPONSE", null, "/rest/api/3/issue/{id}")
    // A moved issue answers under its NEW key: that project must be in scope too.
    requireInScope(observation.issueKey, target.projectKeys)
    if (observation.hierarchyLevel != mapped.hierarchyLevel) {
        throw BadRequestException(levelMismatch(observation, request.level, mapped.hierarchyLevel, discovery))
    }
    return observation
}

/** The stored mapping, else the defaults (the bind's and Peek's one resolution); a `409` when it no longer fits or is unreadable. */
internal fun effectiveMapping(state: JiraMappingState, discovery: JiraDiscovery): JiraMapping =
    when (val resolved = resolveEffectiveMapping(state, discovery)) {
        is MappingResolution.Usable -> resolved.mapping
        MappingResolution.Unreadable -> throw ConflictException(
            "The connection's stored mapping cannot be read - ask an administrator to save it again", JIRA_MAPPING_INVALID_PROBLEM,
        )
        is MappingResolution.Invalid -> throw ConflictException(
            "The connection's mapping no longer fits the site (${resolved.problem}) - ask an administrator to update it",
            JIRA_MAPPING_INVALID_PROBLEM,
        )
    }

private fun levelMismatch(observation: JiraObservation, level: JiraLevel, wanted: Int, discovery: JiraDiscovery): String {
    val actual = observation.hierarchyLevel?.let { "level $it" } ?: "an unknown level"
    val type = observation.typeName?.let { " ($it)" }.orEmpty()
    val names = discovery.levels.firstOrNull { it.level == wanted }?.typeNames?.joinToString("/")?.let { " ($it)" }.orEmpty()
    return "${observation.issueKey} is at $actual$type; ${level.label()}s map to level $wanted$names"
}
