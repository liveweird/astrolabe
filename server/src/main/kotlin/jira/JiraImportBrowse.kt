package ch.nokillswit.jira

import ch.nokillswit.authz.ConflictException
import ch.nokillswit.authz.NotFoundException
import ch.nokillswit.infra.fetch.FetchException
import ch.nokillswit.sync.RunnableState
import io.ktor.server.plugins.BadRequestException
import kotlinx.coroutines.withTimeoutOrNull
import kotlinx.serialization.json.JsonObject

// The Jira import's browse (1.2): ONE paged read of the connection's scope, with the run's own full-read JQL, outside any transaction,
// turned into the kernel's `ImportBrowse`. It reads and calls Jira only: nothing here touches the plan or stores anything.

private const val MAX_TYPE_ID = 20

/**
 * The whole browse's deadline, under the web client's 180 s abort (C6): any plan-node owner can start one, so it may not hold a request,
 * a permit queue slot and a parsed page for as long as the transport's per-call deadlines allow across 200 pages. A browse over it fails
 * `TIMEOUT`, the route's `502`.
 */
internal const val IMPORT_BROWSE_DEADLINE_MILLIS = 170_000L

/** The word for a connection that was switched off: shared by the pre-flight and the per-page stop. */
internal const val CONNECTION_DISABLED = "The Jira connection is disabled - enable it first"

/** Ends the browse once the cap is passed; carries no stack (it is control flow, caught in [browseScope]). */
private class BrowseCapReached : RuntimeException(null, null, false, false)

/**
 * The per-page stop of a browse (the run's, `JiraObserver`): a connection deleted meanwhile is the `404` of the route (its token is
 * destroyed, so a copy in memory must not authenticate one more read), one disabled meanwhile a `400`. Typed exceptions the error
 * handler maps, never a `500`.
 */
internal fun browseGuard(connections: JiraConnectionService, connectionId: UInt): suspend () -> Unit = {
    when (connections.runnableState(connectionId)) {
        RunnableState.RUNNABLE -> Unit
        RunnableState.GONE -> throw NotFoundException("Jira connection not found")
        RunnableState.DISABLED -> throw BadRequestException(CONNECTION_DISABLED)
    }
}

/**
 * Reads every issue of [keys] at the mapped levels' types (`JiraJql.full`, the `fields` of the run: the system fields and every mapped
 * date, estimate and Team id) and answers them as the kernel's input. Each issue is read through the mapping at its OWN plan level
 * (its dates and estimate come from that level's fields), and carries the issue type of its direct Jira parent
 * (`fields.parent.fields.issuetype`: `JiraObservation` does not keep it). Ordered by id ascending by the JQL, so what the cap keeps
 * is the lowest [cap] ids, as the kernel keeps them.
 *
 * It STOPS paging at [cap]: the first issue beyond it ends the read with `truncated = true` (a page boundary exactly at the cap costs
 * one more page to find out). [beforePage] runs before every page (the connection's liveness). `LIMIT_EXCEEDED` (200 pages), a failed
 * request, a browse past [deadlineMillis] (`TIMEOUT`) and the rest are the [ch.nokillswit.infra.fetch.FetchException] the route answers
 * `502`. The token is only ever the client's
 * `Authorization` value. A mapped level without a usable issue type id is a `409 jira-mapping-invalid` before any request.
 */
internal suspend fun browseScope(
    connector: JiraConnector,
    context: JiraBindContext,
    token: String,
    keys: List<String>,
    mapping: JiraMapping,
    discovery: JiraDiscovery,
    now: Long,
    beforePage: suspend () -> Unit,
    cap: Int = MAX_IMPORT_ITEMS,
    deadlineMillis: Long = IMPORT_BROWSE_DEADLINE_MILLIS,
): ImportBrowse {
    val typeIds = sweepTypeIds(mapping, discovery) ?: throw ConflictException(
        "The connection's mapping no longer fits the site (a mapped level has no issue type) - ask an administrator to update it",
        JIRA_MAPPING_INVALID_PROBLEM,
    )
    // `withTimeoutOrNull` handles ONLY its own deadline (null); a real cancellation of the caller, or another scope's timeout, propagates.
    return withTimeoutOrNull(deadlineMillis) { read(connector, context, token, keys, typeIds, mapping, discovery, now, beforePage, cap) }
        ?: throw FetchException(JIRA_SOURCE, "TIMEOUT", null, "/rest/api/3/search/jql", "the browse passed its deadline")
}

private suspend fun read(
    connector: JiraConnector,
    context: JiraBindContext,
    token: String,
    keys: List<String>,
    typeIds: List<String>,
    mapping: JiraMapping,
    discovery: JiraDiscovery,
    now: Long,
    beforePage: suspend () -> Unit,
    cap: Int,
): ImportBrowse {
    val client = connector.clientFor(context.target, token)
    client.resolveCloudId()
    // By id: a restart after an expired cursor re-delivers pages, and a repeat must not count toward the cap.
    val issues = LinkedHashMap<String, ImportBrowsedIssue>()
    var truncated = false
    try {
        searchPages(client, { JiraJql.full(keys, typeIds) }, observationFields(mapping), connector.pageSize, beforePage, {}) { page ->
            for (entry in page) {
                val browsed = (entry as? JsonObject)?.let { browsedIssue(it, mapping, discovery, now) } ?: continue
                if (browsed.observation.issueId in issues) continue
                if (issues.size >= cap) throw BrowseCapReached()
                issues[browsed.observation.issueId] = browsed
            }
        }
    } catch (_: BrowseCapReached) {
        truncated = true
    }
    return ImportBrowse(issues.values.toList(), truncated)
}

/** One search entry as the kernel's issue: read at its own plan level, plus its parent's type. Null without a usable id or key. */
private fun browsedIssue(issue: JsonObject, mapping: JiraMapping, discovery: JiraDiscovery, now: Long): ImportBrowsedIssue? {
    val first = JiraObservation.of(issue, mapping, discovery, JiraLevel.MILESTONE, now) ?: return null
    val own = mapping.levelAt(first.hierarchyLevel)
    val observation = when (own) {
        null, JiraLevel.MILESTONE -> first
        else -> JiraObservation.of(issue, mapping, discovery, own, now) ?: first
    }
    val parentType = ((issue["fields"] as? JsonObject)?.get("parent") as? JsonObject)
        ?.let { it["fields"] as? JsonObject }?.get("issuetype") as? JsonObject
    return ImportBrowsedIssue(observation, parentType?.get("id").text(MAX_TYPE_ID), parentType?.get("hierarchyLevel").int())
}
