package ch.nokillswit.planning

/** The `type` of the 409 a stale `expectedRevision` answers (RFC 7807): the SPA tells it apart from a plain conflict and reloads. */
const val STALE_REVISION_PROBLEM = "urn:astrolabe:problem:stale-revision"

/**
 * The `type` of the 409 a dependency that would close a directed cycle answers (RFC 7807). The body carries the cycle as the
 * `cycle` extension member (`ProblemDetail.cycle`): the SPA renders the path in the UI language instead of sniffing the `detail`.
 */
const val DEPENDENCY_CYCLE_PROBLEM = "urn:astrolabe:problem:dependency-cycle"
