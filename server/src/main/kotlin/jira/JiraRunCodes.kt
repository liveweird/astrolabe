package ch.nokillswit.jira

/**
 * The failure codes only the Jira connector raises (a run's `RunProblem`, a probe's row, a search page that failed twice). The
 * transport's are `FetchCodes`, the ones every connector raises `SyncErrorCodes`; the declared list is the spec's `SyncFailureCode`
 * (`SyncFailureCodeTest`). A run's code is stored in `sync_runs.error_code`, so a value is never renamed or removed; a test row's code
 * is wire-only.
 */
internal object JiraRunCodes {
    /** The connection has never been tested, so there is no discovery snapshot to run against. */
    const val NOT_DISCOVERED = "NOT_DISCOVERED"

    /** The stored mapping cannot be read by this version. */
    const val MAPPING_UNREADABLE = "MAPPING_UNREADABLE"

    /** The stored mapping no longer fits the site (a mapped level has no issue type in the snapshot, or the mapping fails its rules). */
    const val MAPPING_INVALID = "MAPPING_INVALID"

    /** A probe row: a configured project key the token cannot see. */
    const val PROJECT_NOT_VISIBLE = "PROJECT_NOT_VISIBLE"

    /** A search page whose cursor expired (HTTP 400 or 410 once a page token was sent) and the one restart failed the same way. */
    const val CURSOR_EXPIRED = "CURSOR_EXPIRED"
}
