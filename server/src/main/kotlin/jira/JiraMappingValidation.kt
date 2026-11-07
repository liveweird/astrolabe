package ch.nokillswit.jira

import io.ktor.server.plugins.BadRequestException
import java.math.BigDecimal

/** `0 < manDaysPerUnit <= 1000`, at most two decimals (the plan's man-day figures are two-decimal numbers). */
const val MAX_MAN_DAYS_PER_UNIT = 1_000.0
private const val MAX_FACTOR_DECIMALS = 2

/** A Jira field id: `duedate`, `customfield_10015` - the one shape that is safe to put in a `fields=` query and a stored document. */
internal val FIELD_ID_PATTERN = Regex("^[A-Za-z][A-Za-z0-9_]{0,63}$")

/** How much of a rejected field id a message quotes back. */
private const val MAX_ID_ECHO = 64

/**
 * The part of the mapping rules that needs no discovery - run by the route BEFORE any database read (a malformed document is a 400 whatever
 * the connection's state) and again by [validateMapping]. The milestone level is required (the type makes a missing one a decode failure,
 * a `400` before this runs); every hierarchy level is at least 0 (sub-tasks, level -1, are never a plan level); present levels are
 * strictly decreasing program > project > milestone (a skipped level is fine); every field id has the Jira shape; `manDaysPerUnit` is
 * finite, `0 < x <= 1000`, with at most two decimals.
 */
fun validateMappingShape(mapping: JiraMapping) {
    shapeProblems(mapping).firstOrNull()?.let { throw BadRequestException(it) }
}

/**
 * Every mapping rule against [discovery], as messages and without throwing: the shape rules, then each named level needs at least one
 * non-sub-task issue type, a date field must be a `date` field of the site (`duedate` qualifies; a `datetime` is refused because the date
 * it yields depends on a time zone, A5), the estimate field a `number` field and the Team field the site's `atlassian-team` one. Empty =
 * the mapping fits. [validateMapping] throws the first; the mapping GET lists them all for a stored mapping a later discovery outgrew.
 */
fun mappingProblems(mapping: JiraMapping, discovery: JiraDiscovery): List<String> {
    val shape = shapeProblems(mapping)
    if (shape.isNotEmpty()) return shape
    val fields = discovery.fields.associateBy { it.id }
    val levels = mapping.mappedLevels()
    val missingLevels = levels.filter { !discovery.hasLevel(it.second.hierarchyLevel) }
        .map { (level, mapped) -> "No issue type at hierarchy level ${mapped.hierarchyLevel} (the ${level.label()} level)" }
    val fieldProblems = levels.flatMap { (level, mapped) ->
        listOfNotNull(
            mapped.fields.start?.let { fieldProblem(fields, it, "date", "${level.label()} start") },
            mapped.fields.end?.let { fieldProblem(fields, it, "date", "${level.label()} end") },
            mapped.fields.estimate?.let { fieldProblem(fields, it, "number", "${level.label()} estimate") },
        )
    }
    val team = mapping.teamFieldId?.let { id ->
        val custom = fields[id]?.custom
        val shown = id.take(MAX_ID_ECHO)
        if (custom == null || TEAM_CUSTOM !in custom) "Field $shown (the Team field) is not this site's Team field" else null
    }
    return missingLevels + fieldProblems + listOfNotNull(team)
}

/** Every mapping rule, enforced by the route AND the service: the first of [mappingProblems] is a `400`. */
fun validateMapping(mapping: JiraMapping, discovery: JiraDiscovery) {
    mappingProblems(mapping, discovery).firstOrNull()?.let { throw BadRequestException(it) }
}

private fun shapeProblems(mapping: JiraMapping): List<String> {
    val levels = mapping.mappedLevels()
    val negative = levels.filter { it.second.hierarchyLevel < 0 }
        .map { (level, mapped) -> "The ${level.label()} level (${mapped.hierarchyLevel}) must be 0 or more (not a sub-task level)" }
    val order = levels.zipWithNext().filter { (upper, lower) -> upper.second.hierarchyLevel <= lower.second.hierarchyLevel }
        .map { (upper, lower) ->
            "The ${upper.first.label()} level (${upper.second.hierarchyLevel}) must sit above the ${lower.first.label()} level " +
                "(${lower.second.hierarchyLevel})"
        }
    val ids = (levels.flatMap { (_, level) -> listOf(level.fields.start, level.fields.end, level.fields.estimate) } + mapping.teamFieldId)
        .filterNotNull().filter { !FIELD_ID_PATTERN.matches(it) }.map { "Invalid Jira field id: ${it.take(MAX_ID_ECHO)}" }
    val factor = mapping.estimate.manDaysPerUnit?.takeIf { !validFactor(it) }
        ?.let { "manDaysPerUnit must be greater than 0 and at most 1000, with at most two decimals" }
    return negative + order + ids + listOfNotNull(factor)
}

private fun validFactor(factor: Double): Boolean = factor.isFinite() && factor > 0.0 && factor <= MAX_MAN_DAYS_PER_UNIT &&
    BigDecimal.valueOf(factor).stripTrailingZeros().scale() <= MAX_FACTOR_DECIMALS

private fun fieldProblem(fields: Map<String, DiscoveredField>, id: String, wanted: String, role: String): String? {
    val shown = id.take(MAX_ID_ECHO)
    val field = fields[id] ?: return "Field $shown ($role) is not a $wanted field of this site's discovery"
    return when {
        field.type == wanted -> null
        field.type == "datetime" && wanted == "date" ->
            "Field $shown ($role) is a datetime field; only date fields can be mapped " +
                "(a date read from a datetime depends on a time zone)"
        else -> "Field $shown ($role) is a ${field.type ?: "untyped"} field; a $wanted field is needed"
    }
}

/** `program`, `project`, `milestone`: the lowercase name of a level in a message. */
internal fun JiraLevel.label(): String = name.lowercase()
