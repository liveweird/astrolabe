package ch.nokillswit.jira

import ch.nokillswit.infra.fetch.FetchException
import ch.nokillswit.infra.fetch.PageCeiling
import ch.nokillswit.infra.fetch.PageTokenGuard
import kotlinx.serialization.json.JsonArray

private const val SEARCH_ENDPOINT = "/rest/api/3/search/jql"

/**
 * The search pages ONE read may follow (200 x `jira.pageSize` issues); more is `LIMIT_EXCEEDED`, never a silent truncation. It is per
 * read, not per run: the read and the sweep each get their own 200. A caller that makes several queries ONE read (the rooted import's
 * rounds, 1.14) passes one [newSearchCeiling] to all of them, so the 200 is shared.
 */
internal const val MAX_SEARCH_PAGES = 200
private const val CURSOR_EXPIRED = "CURSOR_EXPIRED"

/** A fresh page counter of [MAX_SEARCH_PAGES]: the default of [searchPages], one per query; shared when several queries are one read. */
internal fun newSearchCeiling() = PageCeiling(JIRA_SOURCE, SEARCH_ENDPOINT, MAX_SEARCH_PAGES)

/**
 * Pages through `search/jql` for [jql]/[fields] and hands each page's issues to [onPage]; shared by the sync run and the import. Bounded
 * by [MAX_SEARCH_PAGES] and a guard against a cycling `nextPageToken`. [jql] is asked for at every FIRST-page request, so a restart after
 * an expired cursor starts from the first page of a query rebuilt at that moment (the relative bound moves with the clock); a second
 * expiry fails `CURSOR_EXPIRED`. The restart re-delivers pages, which every caller tolerates (an upsert, a set). A `200` that is not a
 * listing - no `issues` member, or `isLast: false` with no token to continue from - is `INVALID_RESPONSE`, never an empty or a final
 * page: the sweep would otherwise read it as "nothing is in scope" and flag every bound issue.
 *
 * [beforePage] runs before EVERY page (the run's per-page stop: its connection deleted or disabled), [onRequest] once per search request
 * actually sent (the run's call tally; not for a page the ceiling refused). [ceiling] counts the pages: one of its own per call unless
 * the caller shares one across queries.
 */
internal suspend fun searchPages(
    client: JiraClient,
    jql: () -> String,
    fields: String,
    pageSize: Int,
    beforePage: suspend () -> Unit,
    onRequest: () -> Unit,
    ceiling: PageCeiling = newSearchCeiling(),
    onPage: suspend (JsonArray) -> Unit,
) {
    val tokens = PageTokenGuard(JIRA_SOURCE, SEARCH_ENDPOINT)
    var token: String? = null
    var restarted = false
    var query = ""
    while (true) {
        beforePage()
        ceiling.next()
        onRequest()
        if (token == null) query = jql()
        val page = try {
            client.searchJql(query, fields, token, pageSize)
        } catch (failure: FetchException) {
            if (failure.code != CURSOR_EXPIRED || restarted) throw failure
            restarted = true
            token = null
            tokens.restart()
            continue
        }
        val issues = page.issues ?: throw invalidPage("a search page without an issues member")
        if (page.isLast == false && page.nextPageToken == null) throw invalidPage("a search page that is not the last has no token")
        onPage(issues)
        tokens.accept(page.nextPageToken)
        token = page.nextPageToken ?: return
    }
}

private fun invalidPage(detail: String) = FetchException(JIRA_SOURCE, "INVALID_RESPONSE", null, SEARCH_ENDPOINT, detail)
