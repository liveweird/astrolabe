package ch.nokillswit.jira

import ch.nokillswit.infra.json.replaceNul
import java.math.BigDecimal
import java.math.RoundingMode
import java.time.DateTimeException
import java.time.LocalDate
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive

// The column widths of `jira_observations` (V21). An observation is built from a document the SITE sent, so every figure and string is
// fitted to its column HERE: a 22001 (string too long) or 22003 (numeric out of range) in an insert would fail the whole statement, and
// one over-long Team name would then fail every later run's chunk.
private const val MAX_SUMMARY = 255
private const val MAX_TYPE_ID = 20
private const val MAX_NAME = 100
private const val MAX_ESTIMATE_SCALE = 2
private const val MAX_UPDATED_TEXT = 40

/** `NUMERIC(12,2)` holds ten integer digits: an estimate at or beyond this is not a figure worth storing. */
private val ESTIMATE_LIMIT = BigDecimal("1E10")

private const val ISSUE_SYSTEM_FIELDS = "summary,issuetype,status,parent,updated"

/**
 * The `fields` an observation request names: the system fields it reads plus every mapped one. A real site answers only what was asked
 * (the stub returns a superset), so a field missing here would read null on a real site while every stub-backed test passed.
 */
fun observationFields(mapping: JiraMapping): String = (listOf(ISSUE_SYSTEM_FIELDS) + mapping.mappedFieldIds()).joinToString(",")

/**
 * The latest observed state of ONE bound issue (`jira_observations`, V21), as the pure read of an issue document through the mapping
 * ([of]). It carries Jira's dates and figures AS OBSERVED (no order check); every string is already fitted to its column. [gone] and
 * [goneReason] belong to the run's sweep, never to a fresh read.
 */
data class JiraObservation(
    val observedAt: Long,
    val issueId: String,
    val issueKey: String,
    val summary: String?,
    val typeId: String?,
    val typeName: String?,
    val hierarchyLevel: Int?,
    val statusName: String?,
    val statusCategory: JiraStatusCategory,
    val parentIssueId: String?,
    val parentIssueKey: String?,
    val startDate: LocalDate?,
    val endDate: LocalDate?,
    val estimate: BigDecimal?,
    val estimateUnit: JiraEstimateUnit?,
    val teamName: String?,
    val jiraUpdatedAt: Long?,
    val gone: Boolean = false,
    val goneReason: String? = null,
) {
    companion object {
        /**
         * Reads [issue] (`GET /issue/{id}` or one `search/jql` entry) as the observation of a binding at plan [level]: the dates and
         * estimate come from the fields mapped for THAT level, whatever hierarchy level the issue turns out to have (a mismatch is a
         * deviation to show, not a reason to read other fields). Null when the document has no usable numeric `id` or issue `key` (the
         * bind treats that as an invalid response, the run skips the entry); every other absent or odd member reads as null, never a
         * failure. [discovery] supplies a hierarchy level the issue's own type object did not carry.
         */
        fun of(issue: JsonObject, mapping: JiraMapping, discovery: JiraDiscovery, level: JiraLevel, observedAt: Long): JiraObservation? {
            val id = issue["id"].text(MAX_ID)?.takeIf(ISSUE_ID_PATTERN::matches) ?: return null
            val key = issue["key"].text(MAX_ID)?.takeIf(ISSUE_KEY_PATTERN::matches) ?: return null
            val fields = issue["fields"] as? JsonObject ?: JsonObject(emptyMap())
            val type = fields["issuetype"] as? JsonObject
            val typeId = type?.get("id").text(MAX_TYPE_ID)
            val mapped = mapping.mappedLevels().firstOrNull { it.first == level }?.second?.fields
            val estimate = mapped?.estimate?.let { estimateOf(fields[it]) }
            val status = fields["status"] as? JsonObject
            val parent = fields["parent"] as? JsonObject
            return JiraObservation(
                observedAt = observedAt,
                issueId = id,
                issueKey = key,
                summary = fields["summary"].text(MAX_SUMMARY)?.fitted(),
                typeId = typeId?.fitted(),
                typeName = type?.get("name").text(MAX_NAME)?.fitted(),
                hierarchyLevel = discovery.hierarchyLevelOf(typeId, type?.get("hierarchyLevel").int()),
                statusName = status?.get("name").text(MAX_NAME)?.fitted(),
                statusCategory = statusCategoryOf((status?.get("statusCategory") as? JsonObject)?.get("key").text(MAX_ID)),
                parentIssueId = parent?.get("id").text(MAX_ID)?.takeIf(ISSUE_ID_PATTERN::matches),
                parentIssueKey = parent?.get("key").text(MAX_ID)?.takeIf(ISSUE_KEY_PATTERN::matches),
                startDate = mapped?.start?.let { dateOf(fields[it]) },
                endDate = mapped?.end?.let { dateOf(fields[it]) },
                estimate = estimate,
                estimateUnit = mapping.estimate.unit.takeIf { estimate != null },
                teamName = mapping.teamFieldId?.let { teamNameOf(fields[it]) }?.fitted(),
                jiraUpdatedAt = instantOf(fields["updated"]),
            )
        }
    }
}

/** A string for a `VARCHAR` column: a NUL (which PostgreSQL cannot store) becomes U+FFFD and a cut never leaves half a surrogate pair. */
internal fun String.fitted(): String = replaceNul().let { if (it.isNotEmpty() && it.last().isHighSurrogate()) it.dropLast(1) else it }

private fun dateOf(value: JsonElement?): LocalDate? = isoDateOrNull(value)?.let { LocalDate.parse(it) }

/** The longest numeric literal and the largest exponent an estimate may have: a site's `1e30000000` must cost nothing to refuse. */
private const val MAX_ESTIMATE_LITERAL = 40
private const val MAX_ESTIMATE_EXPONENT = 64

/**
 * A numeric estimate at two decimals (half up), or null for a string, a non-number or an out-of-range one (`|x| >= 1E10` would be a
 * 22003 on `NUMERIC(12,2)`): a nonsense figure is not observed rather than clamped to a wrong one. The literal's length and exponent are
 * bounded BEFORE any scaling: `BigDecimal("1e999999999").setScale(2)` throws `ArithmeticException` and `1e30000000` burns seconds of
 * CPU building its 30-million-digit expansion, so a hostile or odd number never reaches the arithmetic.
 */
private fun estimateOf(value: JsonElement?): BigDecimal? {
    val primitive = (value as? JsonPrimitive)?.takeIf { !it.isString } ?: return null
    if (primitive.content.length > MAX_ESTIMATE_LITERAL) return null
    val number = try {
        BigDecimal(primitive.content)
    } catch (_: NumberFormatException) {
        return null
    }
    if (number.scale() !in -MAX_ESTIMATE_EXPONENT..MAX_ESTIMATE_EXPONENT) return null
    return number.setScale(MAX_ESTIMATE_SCALE, RoundingMode.HALF_UP).takeIf { it.abs() < ESTIMATE_LIMIT }
}

/**
 * `fields.updated` as epoch millis through [parseJiraInstantEpochMillis] (the `+0000` spelling included); null when absent or odd -
 * including an instant the parser accepts but `Instant.toEpochMilli` cannot hold (`+999999999-12-31T...`, an `ArithmeticException`).
 */
private fun instantOf(value: JsonElement?): Long? = value.text(MAX_UPDATED_TEXT)?.let {
    try {
        parseJiraInstantEpochMillis(it)
    } catch (_: DateTimeException) {
        null
    } catch (_: ArithmeticException) {
        null
    }
}
