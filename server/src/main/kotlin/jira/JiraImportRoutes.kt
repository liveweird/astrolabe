package ch.nokillswit.jira

import ch.nokillswit.audit.audit
import ch.nokillswit.authz.CallerPrincipal
import ch.nokillswit.authz.ConflictException
import ch.nokillswit.authz.ForbiddenException
import ch.nokillswit.authz.NotFoundException
import ch.nokillswit.authz.OwnerChain
import ch.nokillswit.authz.caller
import ch.nokillswit.authz.isAdmin
import ch.nokillswit.authz.orNotFound
import ch.nokillswit.authz.requireOwnerOrAdmin
import ch.nokillswit.infra.db.nowMillis
import ch.nokillswit.infra.fetch.FetchException
import ch.nokillswit.people.PersonService
import ch.nokillswit.plugins.RateLimits
import ch.nokillswit.plugins.respondProblem
import io.ktor.http.HttpStatusCode
import io.ktor.resources.Resource
import io.ktor.server.plugins.BadRequestException
import io.ktor.server.plugins.ratelimit.RateLimitName
import io.ktor.server.plugins.ratelimit.rateLimit
import io.ktor.server.request.receive
import io.ktor.server.resources.post
import io.ktor.server.response.respond
import io.ktor.server.routing.Route
import io.ktor.server.routing.RoutingContext
import kotlinx.serialization.Serializable

/** `POST …/connections/{id}/import-preview`: what an import of the connection's scope into one work stream would do (writes nothing). */
@Serializable
@Resource("import-preview")
class JiraImportPreviewRoute(val parent: JiraConnectionsRoute.Id)

/** `POST …/connections/{id}/import`: apply the ticked rows of a preview in ONE plan write (the one Jira write that moves the plan). */
@Serializable
@Resource("import")
class JiraImportApplyRoute(val parent: JiraConnectionsRoute.Id)

/**
 * The Jira import's routes (1.2). **The preview** is open to ADMIN or an owner of every target, in the order the plan fixed: the
 * per-USER `jira-import` bucket (spent BEFORE everything below, so a refused caller learns nothing and a `429` wins over any other
 * answer) -> the connection's existence (`404`; public through `GET /views/deviations`) -> the body (`400`) -> the NAMED targets'
 * chains (`404`: the work stream, `defaults.programId`, `defaults.projectId`) -> `403` for a login that owns no plan node at all, then
 * the guard on each named DEFAULT (`403`) -> THE TOKEN'S DECRYPT (`readForBind`: a caller refused by the checks above never reaches
 * it; the resolved-target `403` below still follows it and the browse; the `404` above reads the connection's state and touches no
 * token) -> the shape (`400`) -> the connection enabled (`400`), its token (`409`),
 * discovery (`409`) and mapping (`409`) -> ONE paged browse of the scope, outside any transaction (`502`) -> ONE read-only snapshot ->
 * the pure kernel -> the guard on the RESOLVED targets (`403`, naming the first one the caller does not own) -> `200`. The picked work
 * stream is a target only when a program would be created (a program owner may import under their program), so it is guarded there,
 * not up front; a caller who owns neither it, any target nor any node of its tree is refused too. It stores nothing and audits
 * nothing (a read; a `403` is the central `authz.denied`).
 * The caller's team-schedule rights decide `canSchedule`, never a refusal.
 *
 * **The apply** runs the SAME steps through the browse (same codes; the items' shape and every `overrides.teamId` join the `400`s, and a
 * browse truncated at the cap is a `400` before any write), then ONE plan write that re-reads and re-guards everything under the locks
 * ([JiraImportService.apply]). After the commit it audits `jira.import_applied` (one line, id lists) and `jira.binding_released` per dead
 * holder it released; a refused or rolled-back apply emits nothing of its own (a `403` is the central `authz.denied`). The answer
 * carries ids, keys and reasons only - no Jira text beyond what the caller's own preview showed.
 */
internal fun Route.jiraImportRoutes(
    connections: JiraConnectionService,
    imports: JiraImportService,
    people: PersonService,
    connector: JiraConnector,
) {
    /** The caller's ACTIVE person (not looked up for an ADMIN), and the same locked `FOR SHARE` for the transaction that follows. */
    suspend fun personOf(caller: CallerPrincipal): UInt? = if (caller.isAdmin()) null else people.activePersonIdOf(caller.userId)

    suspend fun lockedPersonOf(caller: CallerPrincipal): UInt? =
        if (caller.isAdmin()) null else people.lockedActivePersonIdOf(caller.userId)

    rateLimit(RateLimitName(RateLimits.JIRA_IMPORT)) {
        post<JiraImportPreviewRoute> { route ->
            val caller = call.caller()
            requireConnection(connections, route.parent.id)
            val scope = call.receive<JiraImportScope>()
            val admitted = admit(caller, personOf(caller), connections, route.parent.id, scope, null, imports)
            val context = admitted.context
            val now = nowMillis()
            val browse = browseOrBadGateway(connections, connector, route.parent.id, context, admitted, now) ?: return@post
            val issueIds = issueIdsOf(browse)
            val managerUserId = if (caller.isAdmin()) null else caller.userId
            val read = imports.read(scope.workStreamId, context.target.siteUrl, issueIds, managerUserId).orNotFound("Work stream")
            val defaults = scope.defaults ?: JiraImportDefaults()
            val input = ImportInput(browse, admitted.ready.mapping, admitted.ready.discovery, read.snapshot, defaults, scope.copyDates, now)
            val plan = JiraImportKernels.plan(input)
            val items = plan.rows.map { it.item }
            requireResolvedTargets(caller, admitted.personId, items, read, guardedByName = admitted.named.isNotEmpty())
            // A non-admin sees skipped rows without Jira's text (see redactForNonAdmin); an ADMIN sees everything.
            val shown = if (caller.isAdmin()) RedactedPreview(items, plan.unmatchedTeams) else redactForNonAdmin(plan)
            call.respond(
                HttpStatusCode.OK,
                JiraImportPreview(
                    connectionId = route.parent.id,
                    workStreamId = scope.workStreamId,
                    revision = read.revision,
                    asOf = now,
                    totals = plan.totals(),
                    unmatchedTeams = shown.unmatchedTeams,
                    items = shown.items,
                ),
            )
        }
        post<JiraImportApplyRoute> { route ->
            val caller = call.caller()
            requireConnection(connections, route.parent.id)
            val request = call.receive<JiraImportApplyRequest>()
            val admitted = admit(caller, personOf(caller), connections, route.parent.id, request.scope(), request.items, imports)
            val context = admitted.context
            val now = nowMillis()
            val browse = browseOrBadGateway(connections, connector, route.parent.id, context, admitted, now) ?: return@post
            val applied = ApplyContext(
                route.parent.id, request, admitted.keys, browse, admitted.ready.mapping, admitted.ready.discovery,
                context.mappingChangedAt, caller, { lockedPersonOf(caller) }, now,
            )
            val outcome = imports.apply(applied)
            auditImportApplied(caller, route.parent.id, request.workStreamId, outcome)
            call.respond(HttpStatusCode.OK, outcome.result)
        }
    }
}

/** What both routes know once the request passed the checks before the browse. */
private class Admitted(
    val context: JiraBindContext,
    val personId: UInt?,
    val named: List<OwnerChain>,
    val keys: List<String>,
    val ready: ImportPreflight,
)

/**
 * The connection's existence (`404`, for every caller) WITHOUT reading its token: the run's own state reader answers "gone" for a
 * missing or deleted row and never touches the encrypted column. The decrypting read comes only after [admit]'s `403`s.
 */
private suspend fun requireConnection(connections: JiraConnectionService, connectionId: UInt) {
    if (connections.runnableState(connectionId) == RunnableState.GONE) throw NotFoundException("Jira connection not found")
}

/**
 * The checks of both routes before the browse, in order: the NAMED targets' chains (`404`), `403` for a login that owns no plan node
 * (the bind's rule), the guard on each named default (`403`) - and ONLY THEN the decrypting read of the connection
 * ([JiraConnectionService.readForBind]; `404` if it vanished meanwhile), so a refused caller never makes the server decrypt the
 * stored token - the apply items' shape ([items]; `400`), the project keys, the shape that needs rows (the owner, the default team and
 * every override team active, the defaults under the stream: `400`), then the connection's state (`400`/`409`). Plain reads, no lock:
 * the apply repeats what matters under its own.
 */
private suspend fun admit(
    caller: CallerPrincipal,
    personId: UInt?,
    connections: JiraConnectionService,
    connectionId: UInt,
    scope: JiraImportScope,
    items: List<JiraImportApplyItem>?,
    imports: JiraImportService,
): Admitted {
    val named = imports.namedChains(scope)
    // A login that owns nothing is refused before the browse: only plan owners may learn what the site holds (the bind's rule).
    if (!caller.isAdmin() && (personId == null || !imports.ownsAnyNode(personId))) {
        throw ForbiddenException("Owner or admin role required")
    }
    named.forEach { requireOwnerOrAdmin(caller, personId, it) }
    val context = connections.readForBind(connectionId).orNotFound("Jira connection")
    items?.let(::validateApplyItems)
    val keys = validateImportScope(scope, context.target.projectKeys)
    imports.requireShape(scope, items.orEmpty().mapNotNull { it.overrides?.teamId })
    return Admitted(context, personId, named, keys, importPreflight(context))
}

/** The ONE paged browse, outside any transaction; null after answering `502` (the failure code only, never the upstream's text). */
private suspend fun RoutingContext.browseOrBadGateway(
    connections: JiraConnectionService,
    connector: JiraConnector,
    connectionId: UInt,
    context: JiraBindContext,
    admitted: Admitted,
    now: Long,
): ImportBrowse? = try {
    val stop = browseGuard(connections, connectionId)
    browseScope(connector, context, admitted.ready.token, admitted.keys, admitted.ready.mapping, admitted.ready.discovery, now, stop)
} catch (failure: FetchException) {
    // The code only: the exception's text names an endpoint; nothing of the upstream body or the credentials reaches a client.
    call.respondProblem(HttpStatusCode.BadGateway, "Jira did not answer (${failure.code})", type = JIRA_UPSTREAM_PROBLEM)
    null
}

/** After the commit (a line inside the transaction could describe a rollback): the released holders first, as the bind does. */
private fun auditImportApplied(caller: CallerPrincipal, connectionId: UInt, workStreamId: UInt, outcome: ImportOutcome) {
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
    val result = outcome.result
    fun ids(ids: List<UInt>) = ids.sorted().joinToString(",")
    fun created(level: JiraLevel) = ids(result.created.filter { it.kind == level }.map { it.id })
    audit(
        "jira.import_applied",
        "byUserId" to caller.userId.toLong(),
        "connectionId" to connectionId.toLong(),
        "workStreamId" to workStreamId.toLong(),
        "revisionTo" to result.revision,
        "createdCount" to result.created.size,
        "boundCount" to result.bound.size,
        "skippedCount" to result.skipped.size,
        "programIds" to created(JiraLevel.PROGRAM),
        "projectIds" to created(JiraLevel.PROJECT),
        "milestoneIds" to created(JiraLevel.MILESTONE),
        "scheduledIds" to ids(result.created.filter { it.scheduled }.map { it.id }),
        "bindingIds" to ids(result.created.map { it.bindingId } + result.bound.map { it.bindingId }),
    )
}

/** What a connection must have before anything is read from its site: a readable token, a discovery and a usable effective mapping. */
internal class ImportPreflight(val token: String, val discovery: JiraDiscovery, val mapping: JiraMapping)

/**
 * The connection's state checks, in order: enabled (`400`), token (`409 jira-token-unreadable`), discovery (`409 jira-not-discovered`),
 * the effective mapping as stored-or-defaults against the CURRENT discovery (`409 jira-mapping-invalid`; the bind's own resolution).
 * The mapped levels' issue types are checked by [browseScope] before its first request.
 */
internal fun importPreflight(context: JiraBindContext): ImportPreflight {
    if (!context.enabled) throw BadRequestException(CONNECTION_DISABLED)
    val token = context.target.apiToken ?: throw ConflictException(
        "The stored API token cannot be decrypted - ask an administrator to enter it again", JIRA_TOKEN_UNREADABLE_PROBLEM,
    )
    val discovery = context.state.discovery
        ?: throw ConflictException("The connection has not been tested yet - ask an administrator to test it", JIRA_NOT_DISCOVERED_PROBLEM)
    return ImportPreflight(token, discovery, effectiveMapping(context.state, discovery))
}
