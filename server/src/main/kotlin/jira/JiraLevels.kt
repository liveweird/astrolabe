package ch.nokillswit.jira

/** The three plan levels that map to Jira (work streams are categories and never do). */
enum class JiraLevel { PROGRAM, PROJECT, MILESTONE }

// Pure helpers over the discovery's issue types and the mapping's hierarchy levels (Flow's `JiraReferenceRows` rule: a level is Jira's
// integer `hierarchyLevel` - Epic 1, never "the type is called Epic").

/** The ids of the non-sub-task issue types at [level], in the site's order (what a sweep's `issuetype in (...)` names). */
fun JiraDiscovery.typeIdsAtLevel(level: Int): List<String> =
    issueTypes.filter { !it.subtask && it.hierarchyLevel == level }.map { it.id }

/** Whether the site has a non-sub-task issue type at [level] (the grouping the snapshot stored, complete even if `issueTypes` was cut). */
fun JiraDiscovery.hasLevel(level: Int): Boolean = levels.any { it.level == level }

/**
 * An issue's hierarchy level: the one on its own issue-type object when the site sent it (authoritative), else the one the discovery
 * recorded for that type id; null when neither knows.
 */
fun JiraDiscovery.hierarchyLevelOf(typeId: String?, onIssue: Int?): Int? =
    onIssue ?: typeId?.let { id -> issueTypes.firstOrNull { it.id == id }?.hierarchyLevel }

/** The mapped plan levels, top down (program, project, milestone), each with its Jira hierarchy level and field mapping. */
fun JiraMapping.mappedLevels(): List<Pair<JiraLevel, JiraLevelMapping>> = listOfNotNull(
    levels.program?.let { JiraLevel.PROGRAM to it },
    levels.project?.let { JiraLevel.PROJECT to it },
    JiraLevel.MILESTONE to levels.milestone,
)

/** The plan level mapped to [hierarchyLevel], or null (the first one if two shared it, which the validator refuses). */
fun JiraMapping.levelAt(hierarchyLevel: Int?): JiraLevel? =
    hierarchyLevel?.let { wanted -> mappedLevels().firstOrNull { it.second.hierarchyLevel == wanted }?.first }

/** Every field id the mapping reads, once each, in a stable order: the dates and estimate of each level, then the Team field. */
fun JiraMapping.mappedFieldIds(): List<String> = (
    mappedLevels().flatMap { (_, level) -> listOf(level.fields.start, level.fields.end, level.fields.estimate) } + teamFieldId
    ).filterNotNull().distinct()
