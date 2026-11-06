package ch.nokillswit.jira

import ch.nokillswit.infra.fetch.FetchException
import ch.nokillswit.infra.validation.parseIsoDate
import io.ktor.server.plugins.BadRequestException
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.doubleOrNull
import kotlinx.serialization.json.intOrNull

/** An issue's status category (Jira's `statusCategory.key` `new | indeterminate | done`, assumption A6); anything else is `UNKNOWN`. */
enum class JiraStatusCategory { TODO, IN_PROGRESS, DONE, UNKNOWN }

/** The system fields Peek always asks for; the mapped fields are appended ([JiraMapping.mappedFieldIds]). */
private const val PEEK_SYSTEM_FIELDS = "summary,issuetype,status,parent"
private const val MAX_SUMMARY = 255
private const val MAX_TEAM_NAME = 100
private const val ISSUE_ENDPOINT = "/rest/api/3/issue/{id}"

/** The system fields of the issue Peek read. */
@Serializable
data class JiraPeekIssue(
    val id: String,
    val key: String,
    val summary: String?,
    val typeName: String?,
    val hierarchyLevel: Int?,
    val statusCategory: JiraStatusCategory,
    val parentKey: String?,
)

/** What the mapping reads: the plan [level] the issue's hierarchy level maps to (null = unmapped) and that level's start, end, estimate. */
@Serializable
data class JiraPeekResolved(
    val level: JiraLevel?,
    val start: String?,
    val end: String?,
    val estimate: Double?,
    val unit: JiraEstimateUnit,
    val teamName: String?,
)

/** `GET …/{id}/peek`: [raw] holds ONLY the mapped fields' values as the site sent them - nothing else of the issue is ever returned. */
@Serializable
data class JiraPeekResponse(val issue: JiraPeekIssue, val resolved: JiraPeekResolved, val raw: Map<String, JsonElement>)

/**
 * One `GET /issue/{key}` (after the unauthenticated `tenant_info` the gateway path needs) for the mapped and the system fields; null when
 * Jira has no such issue. Any other failure is the [FetchException] the transport classified. Holds no database state.
 */
suspend fun JiraConnector.peek(target: JiraTestTarget, token: String, key: String, mapping: JiraMapping): JsonObject? {
    val client = clientFor(target, token)
    client.resolveCloudId()
    val fields = (listOf(PEEK_SYSTEM_FIELDS) + mapping.mappedFieldIds()).joinToString(",")
    return try {
        client.issue(key, fields)
    } catch (failure: FetchException) {
        if (failure.code == "NOT_FOUND") null else throw failure
    }
}

/**
 * The pure read of an issue document through [mapping] ([discovery] supplies a hierarchy level the issue itself did not carry). A missing
 * or malformed id/key is `INVALID_RESPONSE`; every other absent or odd member reads as null, never a failure. The `raw` map is built from
 * the mapped field ids only, so a site that answers more than was asked leaks nothing.
 */
fun peekResponse(issue: JsonObject, mapping: JiraMapping, discovery: JiraDiscovery): JiraPeekResponse {
    val id = issue["id"].text(MAX_ID) ?: throw invalidIssue()
    val key = issue["key"].text(MAX_ID)?.takeIf(ISSUE_KEY_PATTERN::matches) ?: throw invalidIssue()
    val fields = issue["fields"] as? JsonObject ?: JsonObject(emptyMap())
    val type = fields["issuetype"] as? JsonObject
    val hierarchyLevel = discovery.hierarchyLevelOf(type?.get("id").text(MAX_ID), type?.get("hierarchyLevel").int())
    val status = ((fields["status"] as? JsonObject)?.get("statusCategory") as? JsonObject)?.get("key").text(MAX_ID)
    val level = mapping.levelAt(hierarchyLevel)
    val mapped = level?.let { wanted -> mapping.mappedLevels().first { it.first == wanted }.second.fields }
    return JiraPeekResponse(
        issue = JiraPeekIssue(
            id = id,
            key = key,
            summary = fields["summary"].text(MAX_SUMMARY),
            typeName = type?.get("name").text(MAX_SUMMARY),
            hierarchyLevel = hierarchyLevel,
            statusCategory = statusCategoryOf(status),
            parentKey = ((fields["parent"] as? JsonObject)?.get("key")).text(MAX_ID),
        ),
        resolved = JiraPeekResolved(
            level = level,
            start = mapped?.start?.let { isoDateOrNull(fields[it]) },
            end = mapped?.end?.let { isoDateOrNull(fields[it]) },
            estimate = mapped?.estimate?.let { (fields[it] as? JsonPrimitive)?.takeIf { p -> !p.isString }?.doubleOrNull },
            unit = mapping.estimate.unit,
            teamName = mapping.teamFieldId?.let { teamNameOf(fields[it]) },
        ),
        raw = mapping.mappedFieldIds().filter { it in fields }.associateWith { fields.getValue(it) },
    )
}

/** Jira's `statusCategory.key` as the sync's category (assumption A6: anything but the three known keys is `UNKNOWN`). */
fun statusCategoryOf(key: String?): JiraStatusCategory = when (key) {
    "new" -> JiraStatusCategory.TODO
    "indeterminate" -> JiraStatusCategory.IN_PROGRESS
    "done" -> JiraStatusCategory.DONE
    else -> JiraStatusCategory.UNKNOWN
}

private const val MAX_ID = 64

private fun invalidIssue() = FetchException(JIRA_SOURCE, "INVALID_RESPONSE", null, ISSUE_ENDPOINT)

/** A string member clamped to [max], or null when absent, `null` or not a string - a malformed entry never throws. */
private fun JsonElement?.text(max: Int): String? = (this as? JsonPrimitive)?.takeIf { it.isString }?.content?.take(max)

private fun JsonElement?.int(): Int? = (this as? JsonPrimitive)?.takeIf { !it.isString }?.intOrNull

/** A plain `YYYY-MM-DD` date field's value; null for absence, a datetime or any other shape (the `raw` map shows what the site sent). */
private fun isoDateOrNull(value: JsonElement?): String? = value.text(MAX_ID)?.let {
    try {
        parseIsoDate(it, "date").toString()
    } catch (_: BadRequestException) {
        null
    }
}

/** The Team field is an object with a `name` (Atlassian Team) or, on some sites, plain text. */
private fun teamNameOf(value: JsonElement?): String? =
    if (value is JsonObject) value["name"].text(MAX_TEAM_NAME) else value.text(MAX_TEAM_NAME)
