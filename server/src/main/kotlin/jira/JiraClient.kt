package ch.nokillswit.jira

import ch.nokillswit.infra.fetch.FetchException
import ch.nokillswit.infra.fetch.SourceHttp
import ch.nokillswit.infra.outbound.ATLASSIAN_GATEWAY_HOST
import io.ktor.http.HttpMethod
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.decodeFromJsonElement
import kotlinx.serialization.json.jsonPrimitive

/**
 * `GET /search/jql`: one page of issues (as the JSON the site sent) and the token of the next, absent on the last page. [issues] is null
 * when the answer had no `issues` member at all, and [isLast] null when it carried no flag: a caller that must not mistake a malformed
 * `200` for an empty listing (the run's sweep) tells those apart from a genuine `issues: []`.
 */
@Serializable
data class JiraSearchPage(
    val issues: JsonArray? = null,
    val nextPageToken: String? = null,
    val isLast: Boolean? = null,
)

/** The common `startAt`/`maxResults`/`total` envelope of the `startAt`-paged endpoints (`GET /project/search`). */
@Serializable
data class JiraStartAtPage(
    val startAt: Int = 0,
    val maxResults: Int = 0,
    val total: Int = 0,
    val isLast: Boolean? = null,
    val values: JsonArray = JsonArray(emptyList()),
)

/**
 * The slice of the Jira Cloud REST surface the sync needs (Flow's `JiraClient`, trimmed to what a deviation sync reads: no changelog,
 * worklog, board, status or user endpoint). Every call goes through the gateway `https://api.atlassian.com/ex/jira/{cloudId}` (or, in
 * development, the single stub host substituted for both the tenant_info host and the gateway - `jira/Jira.kt`). Nothing here writes to
 * Jira. [resolveCloudId] must run before any other method; [HttpJiraClient] throws `IllegalStateException` otherwise.
 */
interface JiraClient {
    /** The most calls this client lets run at once (`jira.maxConcurrentRequests`, enforced by [SourceHttp]'s semaphore, not here). */
    val maxConcurrentRequests: Int

    /** `GET https://<site>/_edge/tenant_info` - the ONE unauthenticated endpoint. */
    suspend fun resolveCloudId(): String
    suspend fun myself(): JsonObject

    /**
     * `GET /search/jql`. Without [fields] Jira answers ONLY `id` per issue (Flow's first real sync failed on it): name every field
     * wanted.
     */
    suspend fun searchJql(
        jql: String,
        fields: String? = null,
        nextPageToken: String? = null,
        maxResults: Int = DEFAULT_SEARCH_PAGE_SIZE,
    ): JiraSearchPage

    /** `GET /issue/{idOrKey}`: a numeric id or a `PROJ-123` key, nothing else (it is spliced into the trusted gateway path). */
    suspend fun issue(idOrKey: String, fields: String? = null): JsonObject

    /**
     * `GET /field`, trimmed INSIDE the transport's transform (`SourceHttp.requestAs`): the parsed tree (a real tenant has ~1,300 fields)
     * is garbage before the next big body is decoded, and only the rows the mapping can use are returned.
     */
    suspend fun fields(): DiscoveredFields

    /** `GET /issuetype`, trimmed the same way. */
    suspend fun issueTypes(): List<DiscoveredIssueType>

    /**
     * `GET /project/search?keys=A&keys=B`: only the named projects, so a site with ~1,000 projects (~22 pages, Flow's real tenant) is
     * never paged through. Assumption A8: `project/search` accepts up to [MAX_PROJECT_KEYS_PER_SEARCH] repeated `keys` (the connection's
     * own limit); a real site settles it on the `projects` probe, and a refusal there is a 400 row, not a silent miss.
     */
    suspend fun projectsSearch(keys: List<String>, startAt: Int = 0): JiraStartAtPage
}

/** The most `keys` one `project/search` asks for: a connection's own project-key limit. */
const val MAX_PROJECT_KEYS_PER_SEARCH = MAX_PROJECT_KEYS

/**
 * Flow's verified page size (100 issues a page honoured on a real tenant, `jira-integration.md`); the raise is a measured follow-up
 * (A4).
 */
const val DEFAULT_SEARCH_PAGE_SIZE = 100

/** A genuine Atlassian `cloudId` - a UUID, matched case-insensitively then stored lowercase. */
private val CLOUD_ID_PATTERN = Regex("^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$", RegexOption.IGNORE_CASE)

/** A numeric Jira issue id, as `search`'s `id` field (never the display `key`) always is. */
internal val ISSUE_ID_PATTERN = Regex("^[0-9]{1,20}$")

/** The Jira Cloud issue-KEY shape (`PROJ-123`) - [JiraClient.issue] accepts either an id or a key. */
val ISSUE_KEY_PATTERN: Regex = Regex("^[A-Z][A-Z0-9_]{1,9}-[0-9]{1,10}$")

/**
 * [tenantInfoBaseUrl] is the connection's own site (or, in development, the stub host for a `stub-` site). [stubBaseUrl] non-null means
 * this connection is a `stub-` site in development mode ([JiraStubRouting]): the gateway HOST becomes the same stub instance - the
 * factory passes null for every other site, which therefore reaches Atlassian - but the gateway PATH SHAPE (`/ex/jira/{cloudId}/...`) is
 * unchanged either way, only the host is substituted. In production [stubBaseUrl] is null and the gateway host is
 * `https://api.atlassian.com`: a stored site URL can therefore never redirect the authenticated traffic anywhere but there (the site is
 * only asked for its unauthenticated `tenant_info`).
 * The `cloudId` path segment comes from [resolveCloudId], which must run before any other call. [email] and [apiToken] only build the
 * `Authorization` header (`jiraAuthHeader`) and are never kept anywhere else.
 */
class HttpJiraClient(
    private val http: SourceHttp,
    private val tenantInfoBaseUrl: String,
    private val stubBaseUrl: String?,
    email: String,
    apiToken: String,
    authScheme: JiraAuthScheme,
) : JiraClient {
    override val maxConcurrentRequests: Int get() = http.maxConcurrentRequests
    private val auth = jiraAuthHeader(email, apiToken, authScheme)
    private var gatewayBase: String = ""

    /**
     * `cloudId` comes straight from an UNAUTHENTICATED response and is then (a) persisted (`jira_connections.cloud_id`), (b) echoed back in
     * every connection response and (c) spliced into the trusted gateway URL every later call uses - an unvalidated value could inject a
     * path segment (or a `..`) into that URL. Validated against the UUID shape Atlassian always returns before it is used for ANY of the
     * three; never kept if invalid.
     */
    override suspend fun resolveCloudId(): String {
        val endpoint = "/_edge/tenant_info"
        val json = http.request(HttpMethod.Get, "$tenantInfoBaseUrl$endpoint", authHeader = null)
        val rawCloudId = decode<JsonObject>(json, endpoint).primitiveOrNull("cloudId", endpoint)?.contentOrNull
            ?: throw FetchException(JIRA_SOURCE, "INVALID_RESPONSE", null, endpoint)
        if (!CLOUD_ID_PATTERN.matches(rawCloudId)) throw FetchException(JIRA_SOURCE, "INVALID_RESPONSE", null, endpoint)
        val cloudId = rawCloudId.lowercase()
        val gatewayHost = stubBaseUrl ?: "https://$ATLASSIAN_GATEWAY_HOST"
        gatewayBase = "$gatewayHost/ex/jira/$cloudId"
        return cloudId
    }

    override suspend fun myself(): JsonObject {
        val endpoint = "/rest/api/3/myself"
        return decode(get(endpoint), endpoint)
    }

    override suspend fun searchJql(jql: String, fields: String?, nextPageToken: String?, maxResults: Int): JiraSearchPage {
        val query = buildMap {
            put("jql", jql)
            put("maxResults", maxResults.toString())
            fields?.let { put("fields", it) }
            nextPageToken?.let { put("nextPageToken", it) }
        }
        val endpoint = "/rest/api/3/search/jql"
        // CURSOR_EXPIRED (Flow's `jira-integration.md`): only meaningful once a page carries a `nextPageToken` - the FIRST page's own
        // 400/410 (a malformed or rejected JQL, say) is a genuine INVALID_RESPONSE, not an expired token that never existed.
        val overrides = if (nextPageToken != null) mapOf(400 to "CURSOR_EXPIRED", 410 to "CURSOR_EXPIRED") else emptyMap()
        val json = http.request(
            HttpMethod.Get, "${requireGateway()}$endpoint", query, null, auth, overrides, pauseKey = gatewayBase,
        )
        return decode(json, endpoint)
    }

    override suspend fun issue(idOrKey: String, fields: String?): JsonObject {
        val endpoint = "/rest/api/3/issue/{id}"
        val id = requireIssueIdOrKey(idOrKey, endpoint)
        val query = fields?.let { mapOf("fields" to it) } ?: emptyMap()
        return decode(get("/rest/api/3/issue/$id", query), endpoint)
    }

    override suspend fun fields(): DiscoveredFields {
        val endpoint = "/rest/api/3/field"
        return getTrimmed(endpoint) { parseFields(decode<JsonArray>(it, endpoint)) }
    }

    override suspend fun issueTypes(): List<DiscoveredIssueType> {
        val endpoint = "/rest/api/3/issuetype"
        return getTrimmed(endpoint) { parseIssueTypes(decode<JsonArray>(it, endpoint)) }
    }

    override suspend fun projectsSearch(keys: List<String>, startAt: Int): JiraStartAtPage {
        val endpoint = "/rest/api/3/project/search"
        require(keys.size in 1..MAX_PROJECT_KEYS_PER_SEARCH) { "keys must hold 1..$MAX_PROJECT_KEYS_PER_SEARCH project keys" }
        keys.forEach { require(PROJECT_KEY_PATTERN.matches(it)) { "invalid project key: $it" } }
        val json = http.request(
            HttpMethod.Get, "${requireGateway()}$endpoint", mapOf("startAt" to startAt.toString()), null, auth,
            repeatedQuery = keys.map { "keys" to it }, pauseKey = gatewayBase,
        )
        return decode(json, endpoint)
    }

    private fun requireGateway(): String =
        gatewayBase.ifBlank { throw IllegalStateException("resolveCloudId() must run before any gateway call") }

    private suspend fun get(path: String, query: Map<String, String> = emptyMap()): JsonElement =
        http.request(HttpMethod.Get, "${requireGateway()}$path", query, null, auth, pauseKey = gatewayBase)

    /** [get] whose tree is converted by [trim] under the transport's big-parse lock, so only [trim]'s (small) result outlives the call. */
    private suspend fun <T> getTrimmed(endpoint: String, trim: (JsonElement) -> T): T =
        http.requestAs(HttpMethod.Get, "${requireGateway()}$endpoint", emptyMap(), null, auth, pauseKey = gatewayBase, transform = trim)

    /**
     * Any Jira-supplied identifier spliced into a gateway PATH (the search probe's raw `id`, a key an admin typed): a malicious or
     * compromised response must never inject an extra path segment into the trusted gateway URL this way.
     */
    private fun requireIssueIdOrKey(idOrKey: String, endpoint: String): String {
        if (!ISSUE_ID_PATTERN.matches(idOrKey) && !ISSUE_KEY_PATTERN.matches(idOrKey)) {
            throw FetchException(JIRA_SOURCE, "INVALID_RESPONSE", null, endpoint)
        }
        return idOrKey
    }
}

// The real Jira response carries many members our envelopes don't declare (`warningMessages`, `expand`, `isLast`...) - ignore them
// rather than fail on a member this client never asked for.
private val LENIENT_JSON = Json { ignoreUnknownKeys = true }

/**
 * The ONE decode path for every Jira response shape, structured OR raw (`JsonObject`/`JsonArray`). kotlinx.serialization's
 * `JsonObject`/`JsonArray` serializers throw `SerializationException` (a `RuntimeException`) - not the `IllegalArgumentException` a raw
 * `.jsonObject`/`.jsonArray` postfix cast throws - on a shape mismatch (an HTML error page, a bare array where an object was expected);
 * routing every cast through here turns EVERY such mismatch into `INVALID_RESPONSE` instead of an uncaught exception.
 */
private inline fun <reified T> decode(json: JsonElement, endpoint: String? = null): T = try {
    LENIENT_JSON.decodeFromJsonElement(json)
} catch (cause: Exception) {
    throw FetchException(JIRA_SOURCE, "INVALID_RESPONSE", null, endpoint).also { it.initCause(cause) }
}

/** `JsonObject["key"]?.jsonPrimitive` also raw-casts on a non-primitive value - same mapping. */
private fun JsonObject.primitiveOrNull(key: String, endpoint: String): JsonPrimitive? = try {
    this[key]?.jsonPrimitive
} catch (cause: IllegalArgumentException) {
    throw FetchException(JIRA_SOURCE, "INVALID_RESPONSE", null, endpoint).also { it.initCause(cause) }
}
