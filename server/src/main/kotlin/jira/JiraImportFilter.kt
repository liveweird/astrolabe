package ch.nokillswit.jira

import ch.nokillswit.infra.time.MILLIS_PER_DAY

// The import filter's rule (1.13.2), pure. The query narrows at the source (`JiraJql.importBrowse`); this is the server's own verdict on
// every entry the search returns, so a site that ignored a clause (and the stub, which evaluates none) cannot widen what is shown.

/** Whether the filter leaves anything out: absent, or both members off, reads everything and reads no parent by id. */
internal fun JiraImportFilter?.isActive(): Boolean = this != null && (excludeDone || updatedWithinDays != null)

/**
 * Whether the import's browse keeps [issue] at [now]: not done when [JiraImportFilter.excludeDone] is on, and updated within
 * [JiraImportFilter.updatedWithinDays] (the boundary included; a stamp in the future is recent). An unknown status category is not done
 * and an unreadable `updated` is admitted: an item that cannot be judged is shown, never silently dropped.
 */
internal fun JiraImportFilter.admits(issue: JiraObservation, now: Long): Boolean {
    if (excludeDone && issue.statusCategory == JiraStatusCategory.DONE) return false
    val days = updatedWithinDays ?: return true
    val updated = issue.jiraUpdatedAt ?: return true
    return updated >= now - days * MILLIS_PER_DAY
}
