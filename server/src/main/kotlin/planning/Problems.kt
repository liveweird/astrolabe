package ch.nokillswit.planning

/** The `type` of the 409 a stale `expectedRevision` answers (RFC 7807): the SPA tells it apart from a plain conflict and reloads. */
const val STALE_REVISION_PROBLEM = "urn:astrolabe:problem:stale-revision"

/**
 * The `type` of the 409 a dependency that would close a directed cycle answers (RFC 7807). The body carries the cycle as the
 * `cycle` extension member (`ProblemDetail.cycle`): the SPA renders the path in the UI language instead of sniffing the `detail`.
 */
const val DEPENDENCY_CYCLE_PROBLEM = "urn:astrolabe:problem:dependency-cycle"

/**
 * The `type` of the 409 a batch accept answers when the TEAM's plan changed since the proposal it carries (`scopeHash`): another
 * milestone of the team was rescheduled, or a capacity period, the team's order, a link or a holiday changed, or a predecessor in
 * another team moved. Nothing is written; the SPA proposes again at once.
 */
const val STALE_SCOPE_PROBLEM = "urn:astrolabe:problem:stale-scope"

/**
 * The `type` of the 409 a pin of an UNSCHEDULED milestone answers (RFC 7807): a pin needs dates (`ck_milestones_pinned_scheduled`), so
 * the SPA tells the manager to schedule the milestone first instead of sniffing the `detail`.
 */
const val MILESTONE_UNSCHEDULED_PROBLEM = "urn:astrolabe:problem:milestone-unscheduled"

/**
 * The `type` of the 409 a baseline create answers at the cap of [MAX_ACTIVE_BASELINES] active baselines (RFC 7807): delete one first.
 * A name clash is the plain unique-violation 409, not this problem.
 */
const val BASELINE_LIMIT_PROBLEM = "urn:astrolabe:problem:baseline-limit"

/**
 * The `type` of the 400 a view answers for `?baseline=N` when baseline N is unknown or soft-deleted (RFC 7807): the id is a query value
 * the client held (the picker's remembered pick), so the page clears its pick and reloads without it. The comparison view
 * `GET /views/baseline/{id}` addresses the baseline itself and answers a plain 404 instead.
 */
const val UNKNOWN_BASELINE_PROBLEM = "urn:astrolabe:problem:unknown-baseline"
