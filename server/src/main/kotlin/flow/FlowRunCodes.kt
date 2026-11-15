package ch.nokillswit.flow

/**
 * The run failure code only Flow raises (the shared ones are `SyncErrorCodes`, the transport's `FetchCodes`). A run's code is stored in
 * `sync_runs.error_code`, so it is never renamed or removed; the declared list is the spec's `SyncFailureCode` (`SyncFailureCodeTest`).
 */
internal object FlowRunCodes {
    /** The connection's time zone is not known to this server. */
    const val TIME_ZONE_INVALID = "TIME_ZONE_INVALID"
}
