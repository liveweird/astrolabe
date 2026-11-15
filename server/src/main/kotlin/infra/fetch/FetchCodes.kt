package ch.nokillswit.infra.fetch

/**
 * The failure codes the transport and the connection probes raise (a [FetchException] code, a probe row's `code`). The declared list of
 * every code a run or a test row can carry is the spec's `SyncFailureCode`; `SyncFailureCodeTest` pins the Kotlin objects (this one,
 * `SyncErrorCodes`, `JiraRunCodes`, `FlowRunCodes`) against it. A run's code is stored in `sync_runs.error_code`, so a value is never
 * renamed or removed; a test row's code is wire-only (a connection stores only whether its last test passed).
 */
internal object FetchCodes {
    const val AUTHENTICATION_FAILED = "AUTHENTICATION_FAILED"
    const val FORBIDDEN_SCOPE = "FORBIDDEN_SCOPE"
    const val NOT_FOUND = "NOT_FOUND"
    const val REDIRECT = "REDIRECT"
    const val INVALID_RESPONSE = "INVALID_RESPONSE"

    /** A response, an answer or a run past a ceiling; never retried by `SourceHttp`. */
    const val LIMIT_EXCEEDED = "LIMIT_EXCEEDED"
    const val BUSY = "BUSY"
    const val TIMEOUT = "TIMEOUT"
    const val RATE_LIMITED = "RATE_LIMITED"
    const val BLOCKED_HOST = "BLOCKED_HOST"
    const val UPSTREAM_UNAVAILABLE = "UPSTREAM_UNAVAILABLE"

    /** The row code of a probe that never ran because an earlier probe failed (`ok: false`, so a skipped REQUIRED row fails the test). */
    const val SKIPPED = "SKIPPED"
}
