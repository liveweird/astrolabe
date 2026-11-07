package ch.nokillswit.jira

import ch.nokillswit.authz.CallerPrincipal
import ch.nokillswit.authz.ConflictException
import ch.nokillswit.authz.ForbiddenException
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
import kotlinx.serialization.Serializable

/** `POST …/connections/{id}/import-preview`: what an import of the connection's scope into one work stream would do (writes nothing). */
@Serializable
@Resource("import-preview")
class JiraImportPreviewRoute(val parent: JiraConnectionsRoute.Id)

/**
 * The Jira import's routes (1.2; the apply lands with its own route). **The preview** is open to ADMIN or an owner of every target, in
 * the order the plan fixed: the per-USER `jira-import` bucket (spent BEFORE everything below, so a refused caller learns nothing and a
 * `429` wins over any other answer) -> the connection (`404`; its existence is public through `GET /views/deviations`) -> the body
 * (`400`) -> the NAMED targets' chains (`404`: the work stream, `defaults.programId`, `defaults.projectId`) -> `403` for a login that owns
 * no plan node at all, then the guard on each named DEFAULT (`403`) -> the shape (`400`) -> the connection enabled (`400`), its token
 * (`409`), discovery (`409`) and mapping (`409`) -> ONE paged browse of the scope, outside any transaction (`502`) -> ONE read-only
 * snapshot -> the pure kernel -> the guard on the RESOLVED targets (`403`, naming the first one the caller does not own) -> `200`. The
 * picked work stream is a target only when a program would be created (a program owner may import under their program), so it is
 * guarded here, not up front; a caller who owns neither it nor any target is refused too. It stores nothing and audits nothing (a read;
 * a `403` is the central `authz.denied`). The caller's team-schedule rights decide `canSchedule`, never a refusal.
 */
internal fun Route.jiraImportRoutes(
    connections: JiraConnectionService,
    imports: JiraImportService,
    people: PersonService,
    connector: JiraConnector,
) {
    rateLimit(RateLimitName(RateLimits.JIRA_IMPORT)) {
        post<JiraImportPreviewRoute> { route ->
            val caller = call.caller()
            val context = connections.readForBind(route.parent.id).orNotFound("Jira connection")
            val scope = call.receive<JiraImportScope>()
            val personId = if (caller.isAdmin()) null else people.activePersonIdOf(caller.userId)
            val named = imports.namedChains(scope)
            // A login that owns nothing is refused before the browse: only plan owners may learn what the site holds (the bind's rule).
            if (!caller.isAdmin() && (personId == null || !imports.ownsAnyNode(personId))) {
                throw ForbiddenException("Owner or admin role required")
            }
            named.forEach { requireOwnerOrAdmin(caller, personId, it) }
            val keys = validateImportScope(scope, context.target.projectKeys)
            imports.requireShape(scope)
            val ready = importPreflight(context)
            val now = nowMillis()
            val browse = try {
                val stop = browseGuard(connections, route.parent.id)
                browseScope(connector, context, ready.token, keys, ready.mapping, ready.discovery, now, stop)
            } catch (failure: FetchException) {
                // The code only: the exception's text names an endpoint; nothing of the upstream body or the credentials reaches a client.
                call.respondProblem(HttpStatusCode.BadGateway, "Jira did not answer (${failure.code})", type = JIRA_UPSTREAM_PROBLEM)
                return@post
            }
            val issueIds = browse.issues.flatMap { listOfNotNull(it.observation.issueId, it.observation.parentIssueId) }.distinct()
            val managerUserId = if (caller.isAdmin()) null else caller.userId
            val read = imports.read(scope.workStreamId, context.target.siteUrl, issueIds, managerUserId).orNotFound("Work stream")
            val defaults = scope.defaults ?: JiraImportDefaults()
            val input = ImportInput(browse, ready.mapping, ready.discovery, read.snapshot, defaults, scope.copyDates, now)
            val plan = JiraImportKernels.plan(input)
            requireResolvedTargets(caller, personId, plan, read, guardedByName = named.isNotEmpty())
            // A non-admin sees skipped rows without Jira's text (see redactForNonAdmin); an ADMIN sees everything.
            val shown = if (caller.isAdmin()) RedactedPreview(plan.rows.map { it.item }, plan.unmatchedTeams) else redactForNonAdmin(plan)
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
    }
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

/** A node the plan would touch: the [chain] to guard and how the `403` names it. */
private class Target(val chain: OwnerChain, val owned: String, val reason: String)

/**
 * The guard on the RESOLVED targets, after the kernel: the picked work stream when a program would be created, every existing node a
 * CREATE row lands under, and every node a BIND row binds to must be in a chain the caller owns (ADMIN owns all); the `403` names the
 * first one the caller does not own. A node created in the batch needs no guard: its chain contains a guarded node. A caller who owns
 * neither the stream nor any target ([guardedByName]: a named default counts) gets a `403` too, so an import that only skips rows
 * still proves ownership. The chains come from the snapshot (the picked stream's tree).
 */
private fun requireResolvedTargets(caller: CallerPrincipal, personId: UInt?, plan: ImportPlan, read: ImportRead, guardedByName: Boolean) {
    val targets = plan.rows.map { it.item }.mapNotNull { item -> targetOf(item, read) }
    for (target in targets) {
        try {
            requireOwnerOrAdmin(caller, personId, target.chain)
        } catch (_: ForbiddenException) {
            throw ForbiddenException("You do not own ${target.owned}, ${target.reason}")
        }
    }
    val ownsStream = personId != null && personId in read.streamChain.owners
    val proven = caller.isAdmin() || guardedByName || targets.isNotEmpty() || ownsStream
    if (!proven) throw ForbiddenException("Owner or admin role required")
}

/** The node [item] touches that needs a guard, or null (a skipped row, a program-less parent, a parent created in the batch). */
private fun targetOf(item: JiraImportItem, read: ImportRead): Target? {
    val created = "under which ${item.issueKey} would be created"
    return when {
        item.action == JiraImportAction.CREATE && item.level == JiraLevel.PROGRAM -> Target(read.streamChain, "the work stream", created)
        item.action == JiraImportAction.CREATE -> {
            val parent = item.parent
            val level = if (item.level == JiraLevel.MILESTONE) JiraLevel.PROJECT else JiraLevel.PROGRAM
            // A parent the snapshot has no chain for would be a hole in the guard: fail closed, never skip it.
            parent?.nodeId?.let { id ->
                Target(chainOf(read, level, id), "${level.label()} ${parent.nodeName}", created)
            }
        }
        item.action == JiraImportAction.BIND -> item.target?.let { target ->
            val what = "${item.level.label()} ${target.nodeName}"
            Target(chainOf(read, item.level, target.nodeId), what, "which ${item.issueKey} would be bound to")
        }
        else -> null
    }
}

private fun chainOf(read: ImportRead, level: JiraLevel, nodeId: UInt): OwnerChain =
    checkNotNull(read.chains[level to nodeId]) { "the snapshot has no owner chain for ${level.label()} $nodeId" }
