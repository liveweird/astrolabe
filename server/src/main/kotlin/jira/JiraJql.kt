package ch.nokillswit.jira

/**
 * JQL construction. Project keys are validated against the SAME [PROJECT_KEY_PATTERN] `JiraConnection.kt` enforces at create/update time,
 * and issue-type ids are digits, so by the time a value reaches here it cannot contain a quote, backslash or whitespace - no
 * quoting/escaping is ever needed. Absolute JQL dates are TZ-sensitive (Flow's spike fact sheet); every date-bounded query here uses
 * Jira's TZ-free RELATIVE syntax (`"-Nm"`) computed from the watermark plus an overlap instead.
 */
object JiraJql {
    private val TYPE_ID_PATTERN = Regex("^[0-9]{1,20}$")

    private fun requireValidKeys(projectKeys: List<String>) {
        require(projectKeys.isNotEmpty()) { "projectKeys must not be empty" }
        projectKeys.forEach {
            require(PROJECT_KEY_PATTERN.matches(it)) { "invalid project key for JQL: $it" }
        }
    }

    /** `project in ("A","B")` - the scope every other JQL builder here starts from. */
    fun scope(projectKeys: List<String>): String {
        requireValidKeys(projectKeys)
        return "project in (" + projectKeys.joinToString(",") { "\"$it\"" } + ")"
    }

    /**
     * The scope narrowed to the given issue-type IDS (`issuetype in (10001,10002)`; Atlassian's JQL field reference documents "name or
     * ID", which Flow never exercised - assumption A3, which the Test connection's `search` probe sends so a real site settles it).
     */
    fun scopeAndTypes(projectKeys: List<String>, issueTypeIds: List<String>): String {
        require(issueTypeIds.isNotEmpty()) { "issueTypeIds must not be empty" }
        issueTypeIds.forEach { require(TYPE_ID_PATTERN.matches(it)) { "invalid issue type id for JQL: $it" } }
        return "${scope(projectKeys)} AND issuetype in (${issueTypeIds.joinToString(",")})"
    }

    /** The incremental query: scope AND a relative `updated` bound, oldest first. */
    fun incremental(projectKeys: List<String>, sinceMinutes: Long): String {
        require(sinceMinutes >= 0) { "sinceMinutes must not be negative" }
        return "${scope(projectKeys)} AND updated >= \"-${sinceMinutes}m\" ORDER BY updated ASC"
    }
}
