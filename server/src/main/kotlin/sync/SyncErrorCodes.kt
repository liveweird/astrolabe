package ch.nokillswit.sync

/**
 * The run's own failure codes besides the connector's (a `FetchException` code or a connector-typed one), and the three both connectors
 * raise ([CONNECTION_GONE], [CONNECTION_DISABLED], [TOKEN_UNREADABLE]). A run's code is stored in `sync_runs.error_code`, so none is
 * renamed or removed; the declared list is the spec's `SyncFailureCode` (`SyncFailureCodeTest`). A test row's code is wire-only.
 */
object SyncErrorCodes {
    const val DEADLINE = "RUN_DEADLINE"
    const val SHUTDOWN = "SHUTDOWN"
    const val INTERNAL = "INTERNAL"
    const val ABANDONED = "ABANDONED"

    /** The connection was deleted before or during the run. */
    const val CONNECTION_GONE = "CONNECTION_GONE"

    /** The connection was disabled before or during the run. */
    const val CONNECTION_DISABLED = "CONNECTION_DISABLED"

    /** The stored token cannot be decrypted (a wrong or rotated key, a corrupt envelope); also a test row's code. */
    const val TOKEN_UNREADABLE = "TOKEN_UNREADABLE"
}
