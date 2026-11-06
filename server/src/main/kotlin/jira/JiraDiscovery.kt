package ch.nokillswit.jira

import ch.nokillswit.infra.json.canonicalJson
import kotlinx.serialization.SerializationException
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.encodeToJsonElement
import kotlinx.serialization.json.intOrNull

/** `409` problem type: a mapping needs the discovery, and no passing Test connection has stored one yet ("Test the connection first"). */
const val JIRA_NOT_DISCOVERED_PROBLEM = "urn:astrolabe:problem:jira-not-discovered"

/** The most field rows (assumption A7) and issue types the snapshot keeps; the counts of what the site reported ride along. */
const val MAX_DISCOVERED_FIELDS = 2_000
const val MAX_DISCOVERED_ISSUE_TYPES = 500

// The `schema.custom` fragments of the fields the sync recognises whatever their type (Flow's `FieldIdsCollector` rules): the Team field,
// the legacy Epic Link and Plans' legacy Parent Link (assumption A2).
internal const val TEAM_CUSTOM = "atlassian-team"
private const val EPIC_LINK_CUSTOM = "gh-epic-link"
private const val PARENT_LINK_CUSTOM = "jpo-custom-field-parent"
private val RECOGNISED_CUSTOMS = listOf(TEAM_CUSTOM, EPIC_LINK_CUSTOM, PARENT_LINK_CUSTOM)
private const val PLANS_START_CUSTOM = "jpo-custom-field-baseline-start"
private const val PLANS_END_CUSTOM = "jpo-custom-field-baseline-end"
private val KEPT_TYPES = setOf("date", "datetime", "number")

// What the snapshot keeps of a site-supplied string (a hostile or odd site cannot bloat the stored document).
private const val MAX_ID_LENGTH = 64
private const val MAX_NAME_LENGTH = 255

/** A field of the site (`GET /field`): its id, display name, `schema.type` and `schema.custom` (null for a system field). */
@Serializable
data class DiscoveredField(val id: String, val name: String, val type: String?, val custom: String?)

/** An issue type (`GET /issuetype`); [hierarchyLevel] is Jira's own level (Epic 1, sub-task -1), null when the site did not say. */
@Serializable
data class DiscoveredIssueType(val id: String, val name: String, val hierarchyLevel: Int?, val subtask: Boolean)

/** The non-sub-task issue types found at one hierarchy level, in the order the site listed them. */
@Serializable
data class DiscoveredLevel(val level: Int, val typeNames: List<String>)

/**
 * What the name and `schema.custom` rules resolved (Flow's `MetricsConfigDefaults`/`JiraReferenceRows` rules; the Plans names
 * "Target start"/"Target end" are assumption A1): the mapping defaults (C4) and the discovery report read these. A null is a "not found"
 * the report shows as an amber line.
 */
@Serializable
data class DiscoveryMarkers(
    val targetStart: DiscoveredField? = null,
    val targetEnd: DiscoveredField? = null,
    val startDate: DiscoveredField? = null,
    val dueDate: DiscoveredField? = null,
    val storyPoints: DiscoveredField? = null,
    val team: DiscoveredField? = null,
    val legacyEpicLink: DiscoveredField? = null,
    val legacyParentLink: DiscoveredField? = null,
)

/** The stored snapshot of a site's fields and issue types (`jira_connections.discovery`), also the body of `GET …/{id}/discovery`. */
@Serializable
data class JiraDiscovery(
    val discoveredAt: Long,
    val fieldCount: Int,
    val issueTypeCount: Int,
    /** True when the site had more usable fields than the snapshot keeps ([MAX_DISCOVERED_FIELDS]); the markers are kept first. */
    val fieldsTruncated: Boolean,
    val fields: List<DiscoveredField>,
    val issueTypes: List<DiscoveredIssueType>,
    val levels: List<DiscoveredLevel>,
    val markers: DiscoveryMarkers,
)

private val DISCOVERY_JSON = Json { ignoreUnknownKeys = true }

/** The canonical JSON the column stores (sorted keys; `infra/json/CanonicalJson.kt`). */
fun JiraDiscovery.toStoredJson(): String = canonicalJson(DISCOVERY_JSON.encodeToJsonElement(this))

fun parseStoredDiscovery(json: String): JiraDiscovery = DISCOVERY_JSON.decodeFromString(json)

/** The stored snapshot, or null when it cannot be decoded (an old shape): the next Test connection replaces it, a read never 500s. */
fun parseStoredDiscoveryOrNull(json: String): JiraDiscovery? = try {
    parseStoredDiscovery(json)
} catch (_: SerializationException) {
    null
} catch (_: IllegalArgumentException) {
    null
}

/**
 * `GET /field` as the snapshot keeps it: how many fields the site REPORTED ([reported]) and the well-formed ones the mapping can use
 * ([kept]: dates, numbers and the recognised customs), already copied out of the response tree (`JiraClient.fields`).
 */
data class DiscoveredFields(val reported: Int, val kept: List<DiscoveredField>)

/** The trim `JiraClient.fields` applies inside the transport's transform: a malformed entry is skipped, the unusable types are dropped. */
internal fun parseFields(fields: JsonArray): DiscoveredFields {
    val all = fields.mapNotNull { it.asField() }
    return DiscoveredFields(all.size, all.filter { it.type in KEPT_TYPES || it.isRecognised() })
}

/**
 * The pure snapshot builder: keeps at most [MAX_DISCOVERED_FIELDS] fields, the marker matches first (so a truncation never loses one), and
 * groups the non-sub-task issue types by hierarchy level. [fields] and [issueTypes] are what the Test connection's `field` and
 * `issuetype` probes returned.
 */
fun buildDiscovery(fields: DiscoveredFields, issueTypes: List<DiscoveredIssueType>, discoveredAt: Long): JiraDiscovery {
    val markers = resolveMarkers(fields.kept)
    val matched = listOfNotNull(
        markers.targetStart, markers.targetEnd, markers.startDate, markers.dueDate, markers.storyPoints, markers.team,
        markers.legacyEpicLink, markers.legacyParentLink,
    ).distinct()
    val ordered = matched + fields.kept.filter { it !in matched }
    val levels = issueTypes.filter { !it.subtask && it.hierarchyLevel != null }
        .groupBy { checkNotNull(it.hierarchyLevel) }
        .map { (level, group) -> DiscoveredLevel(level, group.map { it.name }.distinct()) }
        .sortedBy { it.level }
    return JiraDiscovery(
        discoveredAt = discoveredAt,
        fieldCount = fields.reported,
        issueTypeCount = issueTypes.size,
        fieldsTruncated = ordered.size > MAX_DISCOVERED_FIELDS,
        fields = ordered.take(MAX_DISCOVERED_FIELDS),
        issueTypes = issueTypes.take(MAX_DISCOVERED_ISSUE_TYPES),
        levels = levels,
        markers = markers,
    )
}

/** The well-formed entries of a `GET /issuetype` answer (a malformed one is skipped, never a failure). */
internal fun parseIssueTypes(issueTypes: JsonArray): List<DiscoveredIssueType> = issueTypes.mapNotNull { it.asIssueType() }

private fun DiscoveredField.isRecognised(): Boolean = custom != null && RECOGNISED_CUSTOMS.any { it in custom }

private fun String.folded() = trim().lowercase()

/**
 * The marker rules. A named DATE marker matches the trimmed display name case-insensitively AND `schema.type == "date"` (a text field
 * called "Start date" listed first must not win; A5); Plans' "Target start"/"Target end" fall back to their `schema.custom`
 * (`jpo-custom-field-baseline-start`/`-end`) when no field carries the name, so a renamed or localised site is still found (A1). The first
 * match in the site's order wins. "Story points" has no unique `schema.custom` on a real tenant (Flow), so it matches a `number` field
 * by NAME fragment.
 */
internal fun resolveMarkers(all: List<DiscoveredField>): DiscoveryMarkers {
    fun namedDate(name: String) = all.firstOrNull { it.type == "date" && it.name.folded() == name }
    fun customContaining(marker: String) = all.firstOrNull { it.custom?.contains(marker) == true }
    return DiscoveryMarkers(
        targetStart = namedDate("target start") ?: customContaining(PLANS_START_CUSTOM),
        targetEnd = namedDate("target end") ?: customContaining(PLANS_END_CUSTOM),
        startDate = namedDate("start date"),
        dueDate = all.firstOrNull { it.id == "duedate" },
        storyPoints = all.firstOrNull { it.type == "number" && "story point" in it.name.folded() },
        team = customContaining(TEAM_CUSTOM),
        legacyEpicLink = customContaining(EPIC_LINK_CUSTOM),
        legacyParentLink = customContaining(PARENT_LINK_CUSTOM),
    )
}

private fun JsonElement.asField(): DiscoveredField? {
    val obj = this as? JsonObject ?: return null
    val id = obj.text("id", MAX_ID_LENGTH) ?: return null
    val name = obj.text("name", MAX_NAME_LENGTH) ?: return null
    val schema = obj["schema"] as? JsonObject
    return DiscoveredField(id, name, schema?.text("type", MAX_ID_LENGTH), schema?.text("custom", MAX_ID_LENGTH))
}

private fun JsonElement.asIssueType(): DiscoveredIssueType? {
    val obj = this as? JsonObject ?: return null
    val id = obj.text("id", MAX_ID_LENGTH) ?: return null
    val name = obj.text("name", MAX_NAME_LENGTH) ?: return null
    val level = (obj["hierarchyLevel"] as? JsonPrimitive)?.intOrNull
    val subtask = (obj["subtask"] as? JsonPrimitive)?.booleanOrNull ?: false
    return DiscoveredIssueType(id, name, level, subtask)
}

/** A string member clamped to [max] characters, or null when absent, `null` or not a string - a malformed entry never throws. */
private fun JsonObject.text(key: String, max: Int): String? =
    (this[key] as? JsonPrimitive)?.takeIf { it.isString }?.contentOrNull?.take(max)
