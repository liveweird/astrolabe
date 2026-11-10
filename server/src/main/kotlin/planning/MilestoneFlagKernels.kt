package ch.nokillswit.planning

import ch.nokillswit.infra.time.WorkingCalendar

/**
 * The milestone rows' own flags as pure functions (no I/O, no clock), the idiom of [RoadmapKernels]. Decision D2 of v0.7: the schedule
 * PUT refuses a span without a working day ([NO_WORKING_DAY_MESSAGE]), but a holiday added later leaves such a milestone with its dates
 * (it loads nothing and splits no idle gap); the project and team views mark it.
 */
object MilestoneFlagKernels {
    /**
     * The [FlagKind.NO_WORKING_DAY] WARNING of a scheduled [span] that holds no working day of [calendar], else null (a null span is
     * an unscheduled milestone: nothing to flag).
     */
    fun noWorkingDay(span: DaySpan?, calendar: WorkingCalendar): PlanFlag? =
        if (span == null || calendar.containsWorkingDay(span.start, span.end)) {
            null
        } else {
            PlanFlag(FlagKind.NO_WORKING_DAY, FlagSeverity.WARNING, days = null, teamId = null, otherProjectId = null)
        }
}
