package ch.nokillswit.jira

import ch.nokillswit.infra.fetch.FetchException
import ch.nokillswit.infra.maskedSecret
import ch.nokillswit.infra.outbound.isAllowedTenantHost
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonPrimitive

/** Builds the per-test client: the connection's site, account and token (the dev stub substituted for both hosts, `jira/Jira.kt`). */
typealias JiraClientFactory = (siteUrl: String, email: String, apiToken: String, authScheme: JiraAuthScheme) -> JiraClient

/**
 * What a Test connection probes. [apiToken] is null only when the STORED token could not be decrypted (a wrong or rotated
 * `DATA_ENCRYPTION_KEY`, a corrupt envelope): the connector then answers one typed row instead of calling anything. [expectedUpdatedAt] is
 * the stored row's `updated_at` at read time (null for an ad-hoc test), so a result is recorded only if the row was not edited meanwhile.
 */
class JiraTestTarget(
    val siteUrl: String,
    val email: String,
    val apiToken: String?,
    val authScheme: JiraAuthScheme,
    val projectKeys: List<String>,
    val expectedUpdatedAt: Long? = null,
    /** The stored mapping's milestone hierarchy level (null = no readable mapping): the `search` probe asks for the types at it. */
    val milestoneLevel: Int? = null,
) {
    /** The token is a secret: a default rendering must never reach a log line. */
    override fun toString(): String =
        "JiraTestTarget(siteUrl=$siteUrl, email=$email, apiToken=${maskedSecret(apiToken)}, " +
            "authScheme=$authScheme, projectKeys=$projectKeys)"
}

/** A Test connection's rows plus the discovery snapshot, present only when `field` AND `issuetype` answered. */
class JiraTestOutcome(val result: JiraTestResult, val discovery: JiraDiscovery?)

/**
 * The Jira connector, as far as 1.1's Test connection needs it. It never throws for an upstream or decrypt problem: every outcome is a
 * [ConnectionTestRow]. No database access happens here - the caller reads the target before and records the outcome after, so no DB
 * transaction ever spans one of these HTTP calls.
 */
class JiraConnector(
    private val newClient: JiraClientFactory,
    /** `jira.pageSize` (the run's search pages; `JiraObserver` uses it). */
    val pageSize: Int,
    /** `jira.incrementalOverlapMinutes` (added to the minutes since the last successful run). */
    val incrementalOverlapMinutes: Long,
    /** `jira.censusHours` (how often a run re-lists the child level as an id sweep; `JiraCensus`). */
    val censusHours: Int = DEFAULT_CENSUS_HOURS,
    private val now: () -> Long = System::currentTimeMillis,
) {
    suspend fun testConnection(target: JiraTestTarget): JiraTestOutcome {
        val run = ProbeRun(now)
        val token = target.apiToken
        if (token == null) {
            run.fail(STORED_TOKEN_ROW, "stored API token", required = true, code = TOKEN_UNREADABLE_CODE)
            return JiraTestOutcome(JiraTestResult(run.rows), null)
        }
        if (!hasGenuineSite(target)) {
            run.fail("tenant_info", "/_edge/tenant_info", required = true, code = BLOCKED_HOST_CODE)
            return JiraTestOutcome(JiraTestResult(run.rows), null)
        }
        return probe(newClient(target.siteUrl, target.email, token, target.authScheme), target, run)
    }

    /**
     * A client for [target] with its decrypted [token], for a read that is not the Test connection (Peek; the run later). The same defence
     * in depth as [testConnection]: a stored site that no longer has the genuine tenant shape is refused (`BLOCKED_HOST`) before any
     * client exists, so no request can name it.
     */
    internal fun clientFor(target: JiraTestTarget, token: String): JiraClient {
        if (!hasGenuineSite(target)) throw FetchException(JIRA_SOURCE, BLOCKED_HOST_CODE, null, "/_edge/tenant_info")
        return newClient(target.siteUrl, target.email, token, target.authScheme)
    }

    /**
     * Defence in depth: the site was validated when it was stored, but it is the one stored value that names a host. A row that no longer
     * has the genuine tenant shape is refused before any client is built, so no request can name it.
     */
    private fun hasGenuineSite(target: JiraTestTarget): Boolean =
        target.siteUrl.startsWith("https://") && isAllowedTenantHost(target.siteUrl.removePrefix("https://"))

    private class Probed {
        var cloudId: String? = null
        var milestoneTypeIds: List<String> = emptyList()
        var firstIssueId: String? = null
        var fields: DiscoveredFields? = null
        var issueTypes: List<DiscoveredIssueType>? = null
        var visibleProjectKeys: Set<String>? = null
    }

    @Suppress("LongMethod") // one probe per endpoint, in the order the rows are shown; each is two lines
    private suspend fun probe(client: JiraClient, target: JiraTestTarget, run: ProbeRun): JiraTestOutcome {
        val projectKeys = target.projectKeys
        val seen = Probed()
        run.probe("tenant_info", "/_edge/tenant_info", required = true) { seen.cloudId = client.resolveCloudId() }
        run.probe("myself", "/rest/api/3/myself", required = true, scopeHint = "read:jira-user") { client.myself() }
        // Before `search`: the search probe narrows its JQL by the issue-type ids at the milestone level (assumption A3), which
        // `issuetype` supplies.
        run.probe("issuetype", "/rest/api/3/issuetype", required = true, scopeHint = "read:issue-type:jira") {
            val types = client.issueTypes()
            seen.issueTypes = types
            // The mapped milestone level, else what JiraMappingDefaults would pick: Epic (1) if the site has one, else the work items (0).
            val hasEpics = types.any { !it.subtask && it.hierarchyLevel == EPIC_LEVEL }
            val level = target.milestoneLevel ?: if (hasEpics) EPIC_LEVEL else STORY_LEVEL
            seen.milestoneTypeIds = types.filter { !it.subtask && it.hierarchyLevel == level }.map { it.id }
        }
        run.probe("search", "/rest/api/3/search/jql", required = true, scopeHint = "read:jql:jira") {
            val jql = if (seen.milestoneTypeIds.isEmpty()) {
                JiraJql.scope(projectKeys)
            } else {
                JiraJql.scopeAndTypes(projectKeys, seen.milestoneTypeIds)
            }
            val page = client.searchJql(jql, fields = "id", maxResults = SEARCH_PROBE_MAX_RESULTS)
            seen.firstIssueId = (page.issues?.firstOrNull() as? JsonObject)?.get("id")?.jsonPrimitive?.contentOrNull
        }
        run.probe("field", "/rest/api/3/field", required = true, scopeHint = "read:field:jira") { seen.fields = client.fields() }
        run.probe("projects", "/rest/api/3/project/search", required = true, scopeHint = "read:project:jira") {
            seen.visibleProjectKeys = visibleProjectKeys(client, projectKeys)
        }
        seen.visibleProjectKeys?.let { visible ->
            projectKeys.forEach { key ->
                run.probe("project:$key", "/rest/api/3/project/search", required = true, scopeHint = "read:project:jira") {
                    if (key !in visible) throw ProbeFailure(PROJECT_NOT_VISIBLE_CODE)
                }
            }
        }
        seen.firstIssueId?.let { id ->
            run.probe("issue", "/rest/api/3/issue/{id}", required = true, scopeHint = "read:issue-details:jira") {
                client.issue(id, fields = "id")
            }
        }
        val fields = seen.fields
        val types = seen.issueTypes
        val discovery = if (fields != null && types != null) buildDiscovery(fields, types, now()) else null
        return JiraTestOutcome(JiraTestResult(run.rows, seen.cloudId), discovery)
    }

    /**
     * The configured keys the token can see: `project/search` asked for exactly those keys (assumption A8, `JiraClient.projectsSearch`),
     * never the whole site. Bounded: with at most 50 keys one page answers, so a few pages only guard a site that pages anyway.
     */
    private suspend fun visibleProjectKeys(client: JiraClient, configured: List<String>): Set<String> {
        val keys = mutableSetOf<String>()
        var startAt = 0
        repeat(MAX_PROJECT_PAGES) {
            val page = client.projectsSearch(configured, startAt)
            page.values.forEach { project ->
                (project as? JsonObject)?.get("key")?.jsonPrimitive?.contentOrNull?.takeIf(PROJECT_KEY_PATTERN::matches)?.let(keys::add)
            }
            startAt += page.values.size
            if (page.values.isEmpty() || page.isLast == true || (page.isLast == null && startAt >= page.total)) return keys
        }
        throw FetchException(JIRA_SOURCE, "LIMIT_EXCEEDED", null, "/rest/api/3/project/search", "more than $MAX_PROJECT_PAGES pages")
    }

    companion object {
        /** The row of a stored token that cannot be decrypted (`TOKEN_UNREADABLE`: re-enter it). */
        const val STORED_TOKEN_ROW = "stored_token"
        const val TOKEN_UNREADABLE_CODE = "TOKEN_UNREADABLE"
        const val PROJECT_NOT_VISIBLE_CODE = "PROJECT_NOT_VISIBLE"
        const val DEFAULT_CENSUS_HOURS = 24

        const val BLOCKED_HOST_CODE = "BLOCKED_HOST"

        /** The milestone level's defaults (`JiraMappingDefaults`): an Epic, else a Story/Task/Bug - used until a mapping names one. */
        private const val EPIC_LEVEL = 1
        private const val STORY_LEVEL = 0
        private const val SEARCH_PROBE_MAX_RESULTS = 1
        private const val MAX_PROJECT_PAGES = 5
    }
}
