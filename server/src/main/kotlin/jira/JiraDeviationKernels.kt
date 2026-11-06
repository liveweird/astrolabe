package ch.nokillswit.jira

import ch.nokillswit.infra.time.WorkingCalendar
import ch.nokillswit.planning.DaySpan
import ch.nokillswit.planning.MAX_PLAN_NAME_LENGTH
import ch.nokillswit.planning.endShiftInWorkingDays
import ch.nokillswit.planning.shiftInWorkingDays
import kotlinx.serialization.Serializable
import java.math.BigDecimal
import java.math.RoundingMode
import java.time.LocalDate
import java.util.Locale

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

/** Jira's side of a binding as last observed (a run or the bind wrote it). Dates are Jira's own, with no order check. */
data class ObservedIssue(
    val summary: String?,
    val hierarchyLevel: Int?,
    val statusCategory: JiraStatusCategory,
    val parentIssueId: String?,
    val parentIssueKey: String?,
    val startDate: LocalDate?,
    val endDate: LocalDate?,
    val estimate: BigDecimal?,
    val estimateUnit: JiraEstimateUnit?,
    val gone: Boolean,
    val goneReason: String?,
)

/** A plan node by level and id: the parent a binding's issue is expected under, or the node a parent issue is bound to. */
data class PlanRef(val level: JiraLevel, val id: UInt)

/** The expected parent of a project (its program) or a milestone (its project). */
data class PlanParent(val ref: PlanRef, val name: String)

/**
 * The plan's side of a binding. [start] and [end] are the dates the kernel COMPARES: a milestone's stored dates, a project's or
 * program's DERIVED span (null while nothing below is scheduled). [targetStart] and [targetEnd] are a project's target window.
 */
data class PlanSide(
    val name: String,
    val start: LocalDate?,
    val end: LocalDate?,
    val targetStart: LocalDate?,
    val targetEnd: LocalDate?,
    val estimateMd: BigDecimal?,
    val parent: PlanParent?,
)

/**
 * What the CURRENT effective mapping says about ONE plan level: the Jira hierarchy level it reads and the estimate's unit and optional
 * man-days per unit. Null where the kernel gets it (see [JiraDeviationKernels.deviations]) means no comparison can be made.
 */
data class DeviationMapping(val hierarchyLevel: Int, val estimateUnit: JiraEstimateUnit, val manDaysPerUnit: Double?)

private val ESTIMATE_TOLERANCE = BigDecimal("0.01")
private const val MD_SCALE = 2

/**
 * The deviation rules as ONE pure function (no I/O, no clock): the spec's `getDeviationsView` description is the table,
 * `JiraDeviationKernelsTest` the vectors. Dates compare in WORKING days on the caller's [WorkingCalendar] (holidays included) with
 * the baseline rule - a start snaps to the next working day, an end to the previous one - so two dates that land on the same working
 * day never deviate.
 */
object JiraDeviationKernels {
    /**
     * The deviations of the binding of [level] whose Jira side is [issue] (null = never observed: nothing to compare) against [plan].
     * [mapping] is null when no level comparison can be made - the connection's mapping is unset, stale or unreadable, or does not map
     * this level - and then neither `LEVEL_MISMATCH` nor any estimate deviation is raised. [parentBoundTo] is the plan node the observed
     * parent issue is bound to on the same connection (null = unbound: nothing is raised). A `gone` issue raises `GONE` ALONE: its dates
     * are stale. WARNING first, then the kind's declaration order.
     */
    fun deviations(
        level: JiraLevel,
        issue: ObservedIssue?,
        plan: PlanSide,
        mapping: DeviationMapping?,
        parentBoundTo: PlanRef?,
        calendar: WorkingCalendar,
        asOf: LocalDate,
    ): List<Deviation> {
        if (issue == null) return emptyList()
        if (issue.gone) {
            return listOf(Deviation(DeviationKind.GONE, DeviationSeverity.WARNING, DeviationDetail(issue.goneReason, null, null)))
        }
        val found = buildList {
            addAll(structural(level, issue, plan, mapping, parentBoundTo))
            addAll(dates(level, issue, plan, calendar))
            if (level == JiraLevel.MILESTONE) estimate(issue, plan, mapping)?.let(::add)
            progress(issue, plan, asOf)?.let(::add)
        }
        return found.sortedWith(compareBy<Deviation>({ it.severity }, { it.kind }))
    }

    private fun structural(
        level: JiraLevel,
        issue: ObservedIssue,
        plan: PlanSide,
        mapping: DeviationMapping?,
        parentBoundTo: PlanRef?,
    ): List<Deviation> = buildList {
        // A null observed level is a mismatch like the bind's own check (an issue whose type the site cannot place is not "at level 1").
        if (mapping != null && issue.hierarchyLevel != mapping.hierarchyLevel) {
            val detail = DeviationDetail(issue.hierarchyLevel?.toString() ?: "unknown", mapping.hierarchyLevel.toString(), null)
            add(Deviation(DeviationKind.LEVEL_MISMATCH, DeviationSeverity.WARNING, detail))
        }
        val parent = plan.parent
        if (level != JiraLevel.PROGRAM && parent != null && parentBoundTo != null && parentBoundTo != parent.ref) {
            val detail = DeviationDetail(issue.parentIssueKey ?: issue.parentIssueId, parent.name, null)
            add(Deviation(DeviationKind.PARENT_MISMATCH, DeviationSeverity.WARNING, detail))
        }
        val summary = issue.summary
        if (summary != null && !sameName(plan.name, summary)) {
            add(Deviation(DeviationKind.RENAMED, DeviationSeverity.INFO, DeviationDetail(summary, plan.name, null)))
        }
    }

    /**
     * Whether [name] and [summary] are the same text: trimmed and case-insensitive. A node name is cut at 100 characters (a summary
     * is at most 255, so the name is the only side that can be the cut one): a name at its cap (or one character under, for a cut
     * surrogate pair) that is a prefix of the longer summary was truncated, not renamed. A shorter name is a real difference.
     */
    private fun sameName(name: String, summary: String): Boolean {
        val n = name.trim().lowercase(Locale.ROOT)
        val s = summary.trim().lowercase(Locale.ROOT)
        if (n == s) return true
        return s.length > n.length && name.length >= MAX_PLAN_NAME_LENGTH - 1 && s.startsWith(n)
    }

    private fun dates(level: JiraLevel, issue: ObservedIssue, plan: PlanSide, calendar: WorkingCalendar): List<Deviation> {
        val jiraStart = issue.startDate
        val jiraEnd = issue.endDate
        val jiraDated = jiraStart != null || jiraEnd != null
        val planDated = plan.start != null && plan.end != null
        if (level == JiraLevel.MILESTONE) {
            if (jiraDated && !planDated) return listOf(info(DeviationKind.UNSCHEDULED_IN_PLAN))
            if (!jiraDated && planDated) return listOf(info(DeviationKind.UNSCHEDULED_IN_JIRA))
        }
        val endShift = if (jiraEnd != null && plan.end != null) endShift(jiraEnd, plan.end, calendar) else 0
        // The drift rule: the plan finishing LATER than Jira says is the bad news; either differing date inherits it.
        val severity = if (endShift > 0) DeviationSeverity.WARNING else DeviationSeverity.INFO
        return buildList {
            if (jiraStart != null && plan.start != null) {
                val shift = startShift(jiraStart, plan.start, calendar)
                if (shift != 0) {
                    val detail = DeviationDetail(jiraStart.toString(), plan.start.toString(), shift)
                    add(Deviation(DeviationKind.START_DIFFERS, severity, detail))
                }
            }
            if (jiraEnd != null && plan.end != null && endShift != 0) {
                add(Deviation(DeviationKind.END_DIFFERS, severity, DeviationDetail(jiraEnd.toString(), plan.end.toString(), endShift)))
            }
            if (level == JiraLevel.PROJECT) target(issue, plan, calendar)?.let(::add)
        }
    }

    /** The target window against Jira's project-level dates: both sides fully dated and either edge differs in working days. */
    private fun target(issue: ObservedIssue, plan: PlanSide, calendar: WorkingCalendar): Deviation? {
        val jiraStart = issue.startDate ?: return null
        val jiraEnd = issue.endDate ?: return null
        val targetStart = plan.targetStart ?: return null
        val targetEnd = plan.targetEnd ?: return null
        val start = startShift(jiraStart, targetStart, calendar)
        val end = endShift(jiraEnd, targetEnd, calendar)
        if (start == 0 && end == 0) return null
        return Deviation(DeviationKind.TARGET_DIFFERS, DeviationSeverity.INFO, DeviationDetail(null, null, if (end != 0) end else start))
    }

    private fun estimate(issue: ObservedIssue, plan: PlanSide, mapping: DeviationMapping?): Deviation? {
        val figure = issue.estimate ?: return null
        val md = plan.estimateMd ?: return null
        if (mapping == null) return null
        // A figure read under another unit than the mapping names now is stale (the next run re-reads in full): shown, never compared.
        // DAYS needs no factor and ignores a leftover one (a mapping saved under another unit); POINTS and HOURS convert only with one.
        val factor = if (mapping.estimateUnit == JiraEstimateUnit.DAYS) BigDecimal.ONE else mapping.manDaysPerUnit?.let(BigDecimal::valueOf)
        if (factor == null || issue.estimateUnit != mapping.estimateUnit) {
            val detail = DeviationDetail(figure.toPlainString(), md.setScale(MD_SCALE, RoundingMode.HALF_UP).toPlainString(), null)
            return Deviation(DeviationKind.ESTIMATE_NOT_COMPARABLE, DeviationSeverity.INFO, detail)
        }
        val converted = figure.multiply(factor)
        if (converted.subtract(md).abs() < ESTIMATE_TOLERANCE) return null
        val detail = DeviationDetail(
            converted.setScale(MD_SCALE, RoundingMode.HALF_UP).toPlainString(),
            md.setScale(MD_SCALE, RoundingMode.HALF_UP).toPlainString(),
            null,
        )
        return Deviation(DeviationKind.ESTIMATE_DIFFERS, DeviationSeverity.INFO, detail)
    }

    /** `DONE` while the plan ends after [asOf]; `TODO` while it starts before; `IN_PROGRESS` while it starts after. */
    private fun progress(issue: ObservedIssue, plan: PlanSide, asOf: LocalDate): Deviation? {
        val contradicting = when (issue.statusCategory) {
            JiraStatusCategory.DONE -> plan.end?.takeIf { it.isAfter(asOf) }
            JiraStatusCategory.TODO -> plan.start?.takeIf { it.isBefore(asOf) }
            JiraStatusCategory.IN_PROGRESS -> plan.start?.takeIf { it.isAfter(asOf) }
            JiraStatusCategory.UNKNOWN -> null
        } ?: return null
        val detail = DeviationDetail(issue.statusCategory.name, contradicting.toString(), null)
        return Deviation(DeviationKind.PROGRESS_MISMATCH, DeviationSeverity.INFO, detail)
    }

    private fun info(kind: DeviationKind) = Deviation(kind, DeviationSeverity.INFO, DeviationDetail(null, null, null))

    /** Working days from Jira's start to the plan's: POSITIVE = the plan starts later. */
    private fun startShift(jira: LocalDate, plan: LocalDate, calendar: WorkingCalendar): Int =
        shiftInWorkingDays(DaySpan(jira, jira), DaySpan(plan, plan), calendar)

    private fun endShift(jira: LocalDate, plan: LocalDate, calendar: WorkingCalendar): Int =
        endShiftInWorkingDays(DaySpan(jira, jira), DaySpan(plan, plan), calendar)
}
