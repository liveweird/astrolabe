package ch.nokillswit.jira

/**
 * JQL construction. Project keys are validated against the SAME [PROJECT_KEY_PATTERN] `JiraConnection.kt` enforces at create/update time,
 * and issue-type ids are digits, so by the time a value reaches here it cannot contain a quote, backslash or whitespace - no
 * quoting/escaping is ever needed. Absolute JQL dates are TZ-sensitive (Flow's spike fact sheet); every date-bounded query here uses
 * Jira's TZ-free RELATIVE syntax (`"-Nm"`) computed from the watermark plus an overlap instead.
 */
object JiraJql {
    private val TYPE_ID_PATTERN = Regex("^[0-9]{1,20}$")

    /** Whether [id] is an issue-type id [scopeAndTypes] accepts (digits only); a site's odd id is refused before a query is built. */
    fun isTypeId(id: String): Boolean = TYPE_ID_PATTERN.matches(id)

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

    /**
     * The full read: everything in scope OF THE GIVEN TYPES, oldest id first (the first run, and any run that cannot trust a watermark).
     * Limited to the mapped levels' types - epics and above are a small part of a real site - with the same clause the `search` probe
     * sends (assumption A3). It is the SAME text as the [sweep]; only the `fields` differ.
     */
    fun full(projectKeys: List<String>, issueTypeIds: List<String>): String = "${scopeAndTypes(projectKeys, issueTypeIds)} ORDER BY id ASC"

    /** The one clause that leaves done items out (assumption A16: JQL accepts it whatever language the account uses). */
    private const val NOT_DONE = "statusCategory != Done"

    /**
     * The import's filtered browse (1.13.2): the [full] read narrowed by [excludeDone] (a constant clause) and [updatedWithinDays] (a
     * window in MINUTES, the one relative form a real tenant has verified; no other client value is ever spliced). The day count is an
     * `Int` this builder bounds itself ([MIN_IMPORT_UPDATED_DAYS]..[MAX_IMPORT_UPDATED_DAYS], a second line of defence behind the request's
     * `400`); with neither narrowing it is no filtered read at all and is refused: the caller sends [full].
     */
    fun importBrowse(projectKeys: List<String>, issueTypeIds: List<String>, excludeDone: Boolean, updatedWithinDays: Int?): String {
        require(excludeDone || updatedWithinDays != null) { "a filtered browse needs excludeDone or updatedWithinDays" }
        return "${scopeAndTypes(projectKeys, issueTypeIds)}${narrowing(excludeDone, updatedWithinDays)} ORDER BY id ASC"
    }

    /**
     * The rooted import's read (1.14): the direct children of the given parent issues among the given types, oldest id first -
     * `project in ("A") AND issuetype in (10005,10004) AND parent in (99001) ORDER BY id ASC`. [parentIds] are numeric issue ids (1 to
     * [MAX_CHILD_PARENTS], each [TYPE_ID_PATTERN]-shaped: they come from the stored link and from Jira's own answers, and are checked here
     * all the same); ids, never keys, because a key moves with its issue (assumption A18 covers the clause itself). A round that reads
     * only the leaf level narrows it by [excludeDone] / [updatedWithinDays], exactly as [importBrowse] does (one shared [narrowing]); with
     * neither it is the plain read.
     */
    fun children(
        projectKeys: List<String>,
        issueTypeIds: List<String>,
        parentIds: List<String>,
        excludeDone: Boolean = false,
        updatedWithinDays: Int? = null,
    ): String {
        require(parentIds.size in 1..MAX_CHILD_PARENTS) { "parentIds must hold 1..$MAX_CHILD_PARENTS ids" }
        parentIds.forEach { require(TYPE_ID_PATTERN.matches(it)) { "invalid parent issue id for JQL: $it" } }
        return "${scopeAndTypes(projectKeys, issueTypeIds)} AND parent in (${parentIds.joinToString(",")})" +
            "${narrowing(excludeDone, updatedWithinDays)} ORDER BY id ASC"
    }

    /** The most parent issues one [children] query names (the rooted browse chunks its second round by this many). */
    const val MAX_CHILD_PARENTS = 50

    /**
     * The done / window clauses both import builders append (each with its leading ` AND `, empty when off). The day count is bounded
     * here ([MIN_IMPORT_UPDATED_DAYS]..[MAX_IMPORT_UPDATED_DAYS]) whatever the caller checked: the one client-influenced number that is
     * ever spliced, sent as minutes.
     */
    private fun narrowing(excludeDone: Boolean, updatedWithinDays: Int?): String {
        updatedWithinDays?.let {
            require(it in MIN_IMPORT_UPDATED_DAYS..MAX_IMPORT_UPDATED_DAYS) { "updatedWithinDays out of range" }
        }
        val done = if (excludeDone) " AND $NOT_DONE" else ""
        val window = updatedWithinDays?.let { " AND updated >= \"-${it * MINUTES_PER_DAY}m\"" }.orEmpty()
        return "$done$window"
    }

    private const val MINUTES_PER_DAY = 1_440L

    /** The sweep: the ids still in scope among the given issue types, oldest id first (read with `fields=id`). */
    fun sweep(projectKeys: List<String>, issueTypeIds: List<String>): String = "${scopeAndTypes(projectKeys, issueTypeIds)} ORDER BY id ASC"

    /** The incremental query: scope AND a relative `updated` bound, oldest first. */
    fun incremental(projectKeys: List<String>, sinceMinutes: Long): String {
        require(sinceMinutes >= 0) { "sinceMinutes must not be negative" }
        return "${scope(projectKeys)} AND updated >= \"-${sinceMinutes}m\" ORDER BY updated ASC"
    }
}
