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
import ch.nokillswit.sync.RunnableState
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
 * chains (`404`: the work stream, `defaults.programId`, `defaults.projectId` and, 1.14, the rooted import's `root`) -> `403` for a login
 * that owns no plan node at all, then the guard on each named DEFAULT and on the ROOT's chain (`403`) -> THE TOKEN'S DECRYPT
 * (`readForBind`: a caller refused by the checks above never reaches
 * it; the resolved-target `403` below still follows it and the browse; the `404` above reads the connection's state and touches no
 * token) -> the shape (`400`; the filter's day count is checked here, so the up-front `403`s win over it; the root lies under the
 * picked work stream; the resolved-target `403` comes after the browse) -> the connection enabled (`400`),
 * its token (`409`), discovery (`409`) and mapping (`409`) -> the root's ACTIVE link through THIS connection (`409 jira-root-unusable`)
 * -> ONE paged browse of the scope, outside any transaction (`502`; under an
 * active filter it narrows the query and adds the by-id reads of the parents the filter left out, each round preceded by a short read of
 * the bindings in its own snapshot, none across a Jira call; with a `root` the browse is [browseChildren]: the root read by id - a
 * `404`, another id, a key outside the connection's projects or another level are the `409` - and then only what Jira lists under it)
 * -> ONE read-only snapshot ->
 * the pure kernel -> the root's own row must read `ALREADY_BOUND` to the root node (`409 jira-root-unusable`; the root is never a row of
 * the answer) -> the guard on the RESOLVED targets (`403`, naming the first one the caller does not own) -> `200`. The picked work
 * stream is a target only when a program would be created (a program owner may import under their program), so it is guarded there,
 * not up front; a caller who owns neither it, any target nor any node of its tree is refused too. It stores nothing and audits
 * nothing (a read; a `403` is the central `authz.denied`) - except a ROOTED preview that is answered, which audits
 * `jira.import_previewed` (ids and the row count) because it reads a whole subtree's text for a login that linked the root itself.
 * The caller's team-schedule rights decide `canSchedule`, never a refusal.
 *
 * **The apply** runs the SAME steps through the browse (same codes; the items' shape and every `overrides.teamId` and
 * `overrides.ownerPersonId` join the `400`s, and a browse truncated at the cap is a `400` before any write), then ONE plan write that
 * re-reads and re-guards everything under the locks
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
            val browse = browseOrBadGateway(connections, connector, imports, route.parent.id, context, admitted, now) ?: return@post
            val issueIds = issueIdsOf(browse)
            val managerUserId = if (caller.isAdmin()) null else caller.userId
            val read = imports.read(scope.workStreamId, context.target.siteUrl, issueIds, managerUserId).orNotFound("Work stream")
            val defaults = scope.defaults ?: JiraImportDefaults()
            val input = ImportInput(browse, admitted.ready.mapping, admitted.ready.discovery, read.snapshot, defaults, scope.copyDates, now)
            val whole = JiraImportKernels.plan(input)
            // A rooted import: the root's own row must be what the browse promised, and it is never a row of the answer (1.14).
            val plan = admitted.root?.let { root ->
                whole.requireRootRow(root)
                whole.withoutRow(root.issueId)
            } ?: whole
            val items = plan.rows.map { it.item }
            requireResolvedTargets(caller, admitted.personId, items, read, guardedByName = admitted.named.isNotEmpty())
            // A rooted preview reads the text of everything under one linked item: the one preview that leaves a trace (ids only), so a
            // bind, a rooted preview and an unbind cannot read a subtree unseen. A refused preview (any status above) emits nothing.
            admitted.root?.let { auditRootedPreview(caller, route.parent.id, it, items.size) }
            // A non-admin sees skipped rows without Jira's text, and under an active filter without their keys (see redactForNonAdmin);
            // an ADMIN sees everything.
            val shown =
                if (caller.isAdmin()) RedactedPreview(items, plan.unmatchedTeams) else redactForNonAdmin(plan, scope.filter.isActive())
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
            val browse = browseOrBadGateway(connections, connector, imports, route.parent.id, context, admitted, now) ?: return@post
            val applied = ApplyContext(
                route.parent.id, request, admitted.keys, browse, admitted.ready.mapping, admitted.ready.discovery,
                context.mappingChangedAt, caller, { lockedPersonOf(caller) }, now, admitted.root,
            )
            val outcome = imports.apply(applied)
            auditImportApplied(caller, route.parent.id, request, outcome)
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
    val filter: JiraImportFilter?,
    /** The rooted import's stored link (1.14), null for a whole-scope import. */
    val root: ImportRoot?,
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
 * (the bind's rule), the guard on each named default and on the root's chain (`403`) - and ONLY THEN the decrypting read of the connection
 * ([JiraConnectionService.readForBind]; `404` if it vanished meanwhile), so a refused caller never makes the server decrypt the
 * stored token - the apply items' shape ([items]; `400`), the project keys, the shape that needs rows (the owner, the default team and
 * every override team and owner active, the defaults and the root under the stream: `400`), then the connection's state (`400`/`409`),
 * then the root's active link through this connection (`409`). Plain reads, no lock: the apply repeats what matters under its own.
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
    imports.requireShape(scope, items.orEmpty().mapNotNull { it.overrides })
    val ready = importPreflight(context)
    val root = scope.root?.let { imports.resolveRoot(connectionId, it) }
    return Admitted(context, personId, named, keys, ready, scope.filter, root)
}

/** The ONE paged browse, outside any transaction; null after answering `502` (the failure code only, never the upstream's text). */
private suspend fun RoutingContext.browseOrBadGateway(
    connections: JiraConnectionService,
    connector: JiraConnector,
    imports: JiraImportService,
    connectionId: UInt,
    context: JiraBindContext,
    admitted: Admitted,
    now: Long,
): ImportBrowse? = try {
    val stop = browseGuard(connections, connectionId)
    val ready = admitted.ready
    val root = admitted.root
    if (root != null) {
        // A rooted import (1.14): the root by id, then what Jira lists under it. The filter is the request's own, judged by the server.
        val spec = ChildBrowse(admitted.keys, context.target.projectKeys, root, admitted.filter)
        browseChildren(connector, context, ready.token, spec, ready.mapping, ready.discovery, now, stop)
    } else {
        // ONE place builds the query and reads the parents, for the preview AND the apply: both come here with their request's own filter.
        val filter = admitted.filter?.takeIf { it.isActive() }?.let { active ->
            ImportBrowseFilter(active) { ids -> imports.liveHeldIssueIds(context.target.siteUrl, ids) }
        }
        browseScope(connector, context, ready.token, admitted.keys, ready.mapping, ready.discovery, now, stop, filter = filter)
    }
} catch (failure: FetchException) {
    // The code only: the exception's text names an endpoint; nothing of the upstream body or the credentials reaches a client.
    call.respondProblem(HttpStatusCode.BadGateway, "Jira did not answer (${failure.code})", type = JIRA_UPSTREAM_PROBLEM)
    null
}

/** `jira.import_previewed`: a rooted preview that was answered. Ids and a count only - never a key, a name or a summary. */
private fun auditRootedPreview(caller: CallerPrincipal, connectionId: UInt, root: ImportRoot, rows: Int) {
    audit(
        "jira.import_previewed",
        "byUserId" to caller.userId.toLong(),
        "connectionId" to connectionId.toLong(),
        "rootLevel" to root.level.name,
        "rootNodeId" to root.nodeId.toLong(),
        "rowCount" to rows,
    )
}

/** After the commit (a line inside the transaction could describe a rollback): the released holders first, as the bind does. */
private fun auditImportApplied(caller: CallerPrincipal, connectionId: UInt, request: JiraImportApplyRequest, outcome: ImportOutcome) {
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
    // The per-row owners (1.14) actually applied: only to a created PROGRAM or PROJECT (the others ignore the field). An ownership grant
    // hands rights over a subtree, so the people it named are on the line.
    val ownerOverrides = request.items.mapNotNull { item -> item.overrides?.ownerPersonId?.let { item.jiraId to it } }.toMap()
    val appliedOwners = result.created.filter { it.kind != JiraLevel.MILESTONE }.mapNotNull { ownerOverrides[it.jiraId] }.distinct()
    audit(
        "jira.import_applied",
        "byUserId" to caller.userId.toLong(),
        "connectionId" to connectionId.toLong(),
        "workStreamId" to request.workStreamId.toLong(),
        "ownerPersonId" to request.ownerPersonId.toLong(),
        "ownerOverridePersonIds" to ids(appliedOwners),
        "revisionTo" to result.revision,
        "createdCount" to result.created.size,
        "boundCount" to result.bound.size,
        "skippedCount" to result.skipped.size,
        "programIds" to created(JiraLevel.PROGRAM),
        "projectIds" to created(JiraLevel.PROJECT),
        "milestoneIds" to created(JiraLevel.MILESTONE),
        "scheduledIds" to ids(result.created.filter { it.scheduled }.map { it.id }),
        "bindingIds" to ids(result.created.map { it.bindingId } + result.bound.map { it.bindingId }),
        "excludeDone" to (request.filter?.excludeDone ?: false),
        "updatedWithinDays" to request.filter?.updatedWithinDays,
        "rootLevel" to request.root?.level?.name,
        "rootNodeId" to request.root?.nodeId?.toLong(),
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
