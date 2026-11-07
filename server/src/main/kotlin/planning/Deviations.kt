package ch.nokillswit.planning

import kotlinx.serialization.Serializable

/*
 * The deviation vocabulary: how a plan node and the external item bound to it disagree. It lives in `planning` because the timeline
 * views carry it (`PlanFlag.deviation`) and `planning` may not name `jira` (`PackageBoundaryTest`); the Jira kernels, the deviations
 * view and the acknowledge import it. The serialized names are the wire contract and the acknowledgement fingerprint's input.
 */

/**
 * How the plan and Jira disagree about a bound node. The declaration order is the order of the kinds within one item.
 * `ESTIMATE_NOT_COMPARABLE` is the one kind the view lists only on request (`all=true`, or `kind=` naming it): it says "a figure
 * exists and cannot be compared".
 */
@Serializable
enum class DeviationKind {
    GONE,
    LEVEL_MISMATCH,
    PARENT_MISMATCH,
    RENAMED,
    START_DIFFERS,
    END_DIFFERS,
    TARGET_DIFFERS,
    UNSCHEDULED_IN_PLAN,
    UNSCHEDULED_IN_JIRA,
    ESTIMATE_DIFFERS,
    ESTIMATE_NOT_COMPARABLE,
    PROGRESS_MISMATCH,
}

/** WARNING sorts before INFO (the roadmap flags' vocabulary). */
@Serializable
enum class DeviationSeverity { WARNING, INFO }

/**
 * The evidence of one deviation, every member optional and a string so one shape serves every kind (the page phrases it per kind):
 * `GONE` jira = the gone reason; `LEVEL_MISMATCH` jira = the observed hierarchy level ("unknown" when none), plan = the mapped one;
 * `PARENT_MISMATCH` jira = the observed parent's key, plan = the plan parent's name; `RENAMED` jira = the summary, plan = the name;
 * `START_DIFFERS` / `END_DIFFERS` the two ISO dates and [days]; `TARGET_DIFFERS` [days] only (the end's shift, else the start's -
 * the item's `jira` and `plan` blocks hold the dates); `ESTIMATE_DIFFERS` jira = the figure converted to man-days, plan = the
 * milestone's; `ESTIMATE_NOT_COMPARABLE` jira = the raw figure, plan = the milestone's man-days; `PROGRESS_MISMATCH` jira = the status
 * category, plan = the plan date that contradicts it; `UNSCHEDULED_*` nothing. [days] is in WORKING days, POSITIVE = the plan is later.
 */
@Serializable
data class DeviationDetail(val jira: String?, val plan: String?, val days: Int?)

@Serializable
data class Deviation(val kind: DeviationKind, val severity: DeviationSeverity, val detail: DeviationDetail)
