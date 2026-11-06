package ch.nokillswit.jira

import ch.nokillswit.infra.json.canonicalJson
import ch.nokillswit.infra.json.sha256Hex
import kotlinx.serialization.SerializationException
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.encodeToJsonElement

/** `409` problem type: the stored API token cannot be decrypted (a changed `DATA_ENCRYPTION_KEY`); re-enter it. */
const val JIRA_TOKEN_UNREADABLE_PROBLEM = "urn:astrolabe:problem:jira-token-unreadable"

/** `502` problem type: Jira did not answer a Peek (the failure code rides in the detail; never a URL, a body or a token). */
const val JIRA_UPSTREAM_PROBLEM = "urn:astrolabe:problem:jira-upstream"

/** The stored value of a connection nobody mapped yet (`jira_connections.mapping` default). */
const val EMPTY_MAPPING = "{}"

/** What the Jira estimate field counts; with [JiraEstimateMapping.manDaysPerUnit] it converts to man-days (`DAYS` needs no factor). */
enum class JiraEstimateUnit { POINTS, HOURS, DAYS }

/** The Jira fields one Astrolabe level reads, by field id (`customfield_10015`, `duedate`); null = not mapped. */
@Serializable
data class JiraLevelFields(val start: String? = null, val end: String? = null, val estimate: String? = null)

/** One Astrolabe level mapped to ONE Jira hierarchy level (Epic is 1, a sub-task -1) and the fields read at it. */
@Serializable
data class JiraLevelMapping(val hierarchyLevel: Int, val fields: JiraLevelFields = JiraLevelFields())

/** The three plan levels below a work stream (work streams never live in Jira); [milestone] is required, the others optional. */
@Serializable
data class JiraMappingLevels(
    val program: JiraLevelMapping? = null,
    val project: JiraLevelMapping? = null,
    val milestone: JiraLevelMapping,
)

/** The estimate's unit and the optional man-days per unit; without a factor (and not `DAYS`) the figure is shown, never compared. */
@Serializable
data class JiraEstimateMapping(val unit: JiraEstimateUnit = JiraEstimateUnit.POINTS, val manDaysPerUnit: Double? = null)

/**
 * The per-connection mapping document (`jira_connections.mapping`, stored canonical through `infra/db/Jsonb.kt`): which Jira hierarchy
 * level each Astrolabe level reads, which fields carry its dates and estimate, the estimate's unit and the Team field. The defaults come
 * from the discovery ([JiraMappingDefaults]); [validateMapping] is the rule set a PUT must satisfy.
 */
@Serializable
data class JiraMapping(
    val levels: JiraMappingLevels,
    val estimate: JiraEstimateMapping = JiraEstimateMapping(),
    val teamFieldId: String? = null,
)

/**
 * `GET …/{id}/mapping`: the [mapping] stored (null = never saved or unreadable), the [defaults] the discovery resolves (null before any
 * discovery), the [effective] one a run would use (the stored one, else the defaults) and the [problems] of the stored one against the
 * discovery as it is NOW (a later Test connection can replace the snapshot under a saved mapping; nothing is ever rewritten).
 */
@Serializable
data class JiraMappingResponse(
    val mapping: JiraMapping?,
    val defaults: JiraMapping?,
    val effective: JiraMapping?,
    val discoveredAt: Long?,
    /** Why the stored [mapping] no longer fits the current discovery (or cannot be read); empty when it fits or none is stored. */
    val problems: List<String>,
)

private val MAPPING_JSON = Json {
    ignoreUnknownKeys = true
    encodeDefaults = true
    explicitNulls = false
}

/** The canonical JSON the column stores (sorted keys, no nulls; `infra/json/CanonicalJson.kt`). */
fun JiraMapping.toStoredJson(): String = canonicalJson(MAPPING_JSON.encodeToJsonElement(this))

/** The digest the `jira.mapping_changed` audit line carries: the SHA-256 of the canonical document. */
fun JiraMapping.sha256(): String = sha256Hex(toStoredJson())

/** What the `mapping` column holds: nothing (`{}`), a readable document, or a shape this build cannot decode (never a 500). */
sealed interface StoredMapping {
    data object Unset : StoredMapping

    data class Valid(val mapping: JiraMapping) : StoredMapping

    data object Unreadable : StoredMapping
}

fun parseStoredMapping(json: String): StoredMapping = try {
    if (canonicalJson(json) == EMPTY_MAPPING) StoredMapping.Unset else StoredMapping.Valid(MAPPING_JSON.decodeFromString<JiraMapping>(json))
} catch (_: SerializationException) {
    StoredMapping.Unreadable
} catch (_: IllegalArgumentException) {
    StoredMapping.Unreadable
}

/**
 * The stored mapping and the discovery snapshot (null = no test has stored one, or the stored one cannot be decoded - the next Test
 * connection replaces it) of a connection.
 */
class JiraMappingState(val stored: StoredMapping, val discovery: JiraDiscovery?) {
    /** The readable stored document, or null when none was saved or it cannot be read. */
    val mapping: JiraMapping? get() = (stored as? StoredMapping.Valid)?.mapping
}

/** `beforeSha256` is null for a connection that had no mapping; both are the SHA-256 of the canonical document (the audit fields). */
data class JiraMappingWriteOutcome(val beforeSha256: String?, val afterSha256: String)

/** What Peek needs, read in ONE short transaction before any HTTP call: the (decrypted-in-memory) target and the mapping state. */
class JiraPeekContext(val target: JiraTestTarget, val state: JiraMappingState)
