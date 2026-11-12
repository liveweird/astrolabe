package ch.nokillswit.jira

import ch.nokillswit.authz.ConflictException
import ch.nokillswit.infra.fetch.FetchException
import kotlinx.coroutines.withTimeoutOrNull
import kotlinx.serialization.json.JsonObject

// The rooted import's browse (1.14): the read of what Jira lists UNDER one linked item, as the kernel's `ImportBrowse`. It calls Jira and
// reads nothing of the plan: the root's identity (its issue id, the level of its plan node) comes from the caller's stored link, every
// other id from Jira's own answers, and nothing of the request reaches a query but the filter's bounded day count. The token is only the
// client's `Authorization` header; no log line, exception text or problem detail carries an endpoint, a key list or the upstream's text
// (the `409` sentences name the plan node's level only). Not wired into a route yet: the preview and the apply will pick this over
// `browseScope`.

/** `409` problem type: the linked Jira item a rooted import starts from cannot be used (gone, moved, another level, link changed). */
internal const val JIRA_ROOT_UNUSABLE_PROBLEM = "urn:astrolabe:problem:jira-root-unusable"

/** The most parents one round-two query names ([JiraJql.MAX_CHILD_PARENTS]): 120 projects are three queries (50, 50, 20). */
internal const val CHILD_PARENT_CHUNK = JiraJql.MAX_CHILD_PARENTS

private const val SEARCH_ENDPOINT = "/rest/api/3/search/jql"

/**
 * The linked item a rooted import starts from: the plan node ([nodeId] of [level], a program or a project) and its ACTIVE binding
 * ([bindingId]) on this connection, whose Jira issue is [issueId] (the stored numeric id). The root is never a preview row.
 */
internal class ImportRoot(val level: JiraLevel, val nodeId: UInt, val bindingId: UInt, val issueId: String) {
    init {
        require(level != JiraLevel.MILESTONE) { "a milestone has no children to import" }
    }
}

/**
 * What a rooted browse is told: the [keys] its queries name (`project in (...)`), the connection's own [connectionKeys] (the root's key
 * must lie in them) and the [root]; the import's [filter] (null or inactive = no narrowing at all).
 */
internal class ChildBrowse(
    val keys: List<String>,
    val connectionKeys: List<String>,
    val root: ImportRoot,
    val filter: JiraImportFilter?,
)

/**
 * Reads the root by id, then everything Jira lists below it at the mapped levels, top down, and answers the root and its descendants as
 * the kernel's input (the root FIRST: the kernel reads it as a browsed, already-bound issue and lands its children under its node, so a
 * rooted import never depends on assumption A10). Inside ONE [deadlineMillis] (`TIMEOUT`, the route's `502`, as [browseScope]).
 *
 * [beforePage] (the connection's liveness) runs before the root read and before every search page. The root read: only a `404` is a
 * verdict (the `409`, [JIRA_ROOT_UNUSABLE_PROBLEM]: deleted or not visible); any other failure leaves as the [FetchException] the route
 * answers `502` (a `403` is the account's scope, never a verdict on this issue). The document must be the id asked for, parse, have its
 * key inside [ChildBrowse.connectionKeys] and sit at the Jira level the mapping gives the root's plan level: each miss is the `409`.
 *
 * Round one asks for the root's children at every mapped level below the root's; round two (a program root with the project level
 * mapped) asks for the leaf level under the projects round one held, ALL of them, in chunks of [CHILD_PARENT_CHUNK] ascending ids. The
 * server's own rule puts every entry to the verdict of [ChildWalk.hold], so a site (or the stub) that ignored a clause cannot widen the
 * scope. Every held row counts toward [cap], the root included: the first row beyond it ends the read `truncated`.
 */
internal suspend fun browseChildren(
    connector: JiraConnector,
    context: JiraBindContext,
    token: String,
    spec: ChildBrowse,
    mapping: JiraMapping,
    discovery: JiraDiscovery,
    now: Long,
    beforePage: suspend () -> Unit,
    cap: Int = MAX_IMPORT_ITEMS,
    deadlineMillis: Long = IMPORT_BROWSE_DEADLINE_MILLIS,
): ImportBrowse {
    requireSweepTypeIds(mapping, discovery)
    val walk = ChildWalk(connector.clientFor(context.target, token), connector.pageSize, spec, mapping, discovery, now, beforePage, cap)
    // `withTimeoutOrNull` handles ONLY its own deadline (null); a real cancellation of the caller, or another scope's timeout, propagates.
    return withTimeoutOrNull(deadlineMillis) { walk.run() }
        ?: throw FetchException(JIRA_SOURCE, "TIMEOUT", null, SEARCH_ENDPOINT, "the browse passed its deadline")
}

/** One rooted walk: the rows held so far, by id (a restart after an expired cursor re-delivers pages, and a repeat counts once). */
private class ChildWalk(
    private val client: JiraClient,
    private val pageSize: Int,
    private val spec: ChildBrowse,
    private val mapping: JiraMapping,
    private val discovery: JiraDiscovery,
    private val now: Long,
    private val beforePage: suspend () -> Unit,
    private val cap: Int,
) {
    private val root = spec.root
    private val filter = spec.filter?.takeIf { it.isActive() }
    private val rows = LinkedHashMap<String, ImportBrowsedIssue>()

    /** Project rows the filter does not admit: held because they are parents to walk, kept in the answer only with a kept child. */
    private val notAdmitted = HashSet<String>()
    private var truncated = false

    suspend fun run(): ImportBrowse {
        client.resolveCloudId()
        val rootIssue = readRoot()
        rows[rootIssue.observation.issueId] = rootIssue
        val below = mapping.mappedLevels().map { it.first }.filter { it.ordinal > root.level.ordinal }
        // Round one: the root's children at every mapped level below it, top down (`10005,10004`: projects, then milestones).
        val first = round(listOf(root.issueId), below)
        // Round two (only a program root with the project level mapped has one): the leaf level under every project round one held,
        // ALL of them (admitted or not, linked or not).
        if (!truncated && JiraLevel.PROJECT in below) {
            val projects = first.filter { levelOf(it) == JiraLevel.PROJECT }.map { it.observation.issueId }.sortedWith(ID_ORDER)
            for (chunk in projects.chunked(CHILD_PARENT_CHUNK)) {
                round(chunk, listOf(JiraLevel.MILESTONE))
                if (truncated) break
            }
        }
        if (filter != null && !truncated) pruneNotAdmitted()
        return ImportBrowse(rows.values.toList(), truncated)
    }

    private fun levelOf(issue: ImportBrowsedIssue): JiraLevel? = mapping.levelAt(issue.observation.hierarchyLevel)

    // ---- the root ---------------------------------------------------------------------------------------------------------------

    private suspend fun readRoot(): ImportBrowsedIssue {
        beforePage()
        val document = try {
            client.issue(root.issueId, observationFields(mapping))
        } catch (failure: FetchException) {
            // Only a 404 is a verdict on this one issue; a 403 (FORBIDDEN_SCOPE) says the account lacks the scope, as for the search.
            if (goneReasonFor(failure.code) != GONE_DELETED) throw failure
            throw unusable("is gone or no longer visible to the connection")
        }
        if (document["id"].text(MAX_ID) != root.issueId) throw unusable("could not be read as the item it was linked to")
        val issue = browsedIssue(document, mapping, discovery, now) ?: throw unusable("could not be read")
        val observation = issue.observation
        if (!isInScope(observation.issueKey, spec.connectionKeys)) throw unusable("moved outside the connection's projects")
        if (mapping.levelAt(observation.hierarchyLevel) != root.level) throw unusable("is no longer at the Jira level the mapping gives it")
        return issue
    }

    /** The `409` for a root that cannot be used; names the plan node's level only, never a key, a site or anything Jira said. */
    private fun unusable(why: String): ConflictException =
        ConflictException(
            "The Jira item this ${root.level.name.lowercase()} is linked to $why - the import cannot start from it. " +
                "See the Deviations page.",
            JIRA_ROOT_UNUSABLE_PROBLEM,
        )

    // ---- one query --------------------------------------------------------------------------------------------------------------

    /**
     * Reads the children of [parents] at [levels] (one query), holds what the server's rule admits and answers it. A round that reads
     * ONLY the leaf level carries the filter's clauses; a round that also reads a level with children to walk is unfiltered at the source.
     */
    private suspend fun round(parents: List<String>, levels: List<JiraLevel>): List<ImportBrowsedIssue> {
        val typeIds = levels.flatMap { level -> discovery.typeIdsAtLevel(hierarchyOf(level)) }.distinct()
        val narrowed = filter.takeIf { levels == listOf(JiraLevel.MILESTONE) }
        val jql = JiraJql.children(spec.keys, typeIds, parents, narrowed?.excludeDone ?: false, narrowed?.updatedWithinDays)
        val asked = parents.toSet()
        val held = ArrayList<ImportBrowsedIssue>()
        try {
            searchPages(client, { jql }, observationFields(mapping), pageSize, beforePage, {}) { page ->
                for (entry in page) {
                    val issue = (entry as? JsonObject)?.let { browsedIssue(it, mapping, discovery, now) } ?: continue
                    if (hold(issue, asked, levels)) held += issue
                }
            }
        } catch (_: BrowseCapReached) {
            truncated = true
        }
        return held
    }

    private fun hierarchyOf(level: JiraLevel): Int = mapping.mappedLevels().first { it.first == level }.second.hierarchyLevel

    /**
     * The server's own verdict on one entry (a site, or the stub, that ignored a clause cannot widen the scope). It is dropped unless it
     * names one of the [asked] parents of THIS query, its key lies in the import's keys, its mapped level is one of the [levels] this round
     * reads (every one strictly below its parents' level), and it is not a repeat; a leaf (milestone-level) entry the filter does not
     * admit is dropped at once. A project-level entry is always held (a parent to walk), remembered as not admitted when the filter says
     * so. Whether it was held.
     */
    private fun hold(issue: ImportBrowsedIssue, asked: Set<String>, levels: List<JiraLevel>): Boolean {
        val observation = issue.observation
        if (observation.issueId in rows) return false
        if (observation.parentIssueId !in asked) return false
        if (!isInScope(observation.issueKey, spec.keys)) return false
        val level = levelOf(issue)?.takeIf { it in levels } ?: return false
        val admitted = filter == null || filter.admits(observation, now)
        if (level == JiraLevel.MILESTONE && !admitted) return false
        if (rows.size >= cap) throw BrowseCapReached()
        rows[observation.issueId] = issue
        if (!admitted) notAdmitted += observation.issueId
        return true
    }

    /** After the walk (active filter): a not-admitted project no held row hangs under is left out, the others are kept as parents. */
    private fun pruneNotAdmitted() {
        val parents = rows.values.mapNotNullTo(HashSet()) { it.observation.parentIssueId }
        for (id in notAdmitted) {
            if (id in parents) rows[id] = rows.getValue(id).copy(keptAsParent = true) else rows.remove(id)
        }
    }
}

// ---- the plan side's two pure helpers -------------------------------------------------------------------------------------------

/**
 * The root's own row must be what the browse promised: the row of [root]'s issue is `ALREADY_BOUND` to the root's node (id AND kind: a
 * program's id 3 is not a project's id 3). Otherwise the link changed after the browse read it (or the plan side no longer holds it), the
 * `409` [JIRA_ROOT_UNUSABLE_PROBLEM]; nothing was written, so the caller just previews again.
 */
internal fun ImportPlan.requireRootRow(root: ImportRoot) {
    val item = rows.firstOrNull { it.item.jiraId == root.issueId }?.item
    val target = item?.target
    val bound = item != null && item.action == JiraImportAction.SKIP && item.reason == JiraImportReason.ALREADY_BOUND &&
        target != null && target.nodeId == root.nodeId && target.nodeKind == root.level
    if (!bound) {
        throw ConflictException(
            "The Jira link of this ${root.level.name.lowercase()} changed while the import was read - preview again",
            JIRA_ROOT_UNUSABLE_PROBLEM,
        )
    }
}

/** A copy of the plan without the row of [jiraId] (the root is never a preview row); `totals()` follows the rows left. */
internal fun ImportPlan.withoutRow(jiraId: String): ImportPlan =
    ImportPlan(asOf, rows.filterNot { it.item.jiraId == jiraId }, truncated, unmatchedTeams, vanished)
