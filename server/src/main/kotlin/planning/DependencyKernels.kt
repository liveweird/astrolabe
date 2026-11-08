package ch.nokillswit.planning

import ch.nokillswit.infra.time.WorkingCalendar
import kotlinx.serialization.Serializable
import java.time.LocalDate

/** Whether a link holds: [OK], [VIOLATED] (the successor is short of what the type requires) or [UNSCHEDULED] (an end has no dates). */
@Serializable
enum class DependencyStatus { OK, VIOLATED, UNSCHEDULED }

/**
 * The result of checking one link, the wire shape of the project view's `check`. [shortfallDays] is present only when [status] is
 * [DependencyStatus.VIOLATED] (then at least 1): how many WORKING days short the successor is. [requiredDate] and [actualDate] (ISO
 * dates) are answered for OK and VIOLATED alike — the working day the type requires and the successor's effective start or end —
 * and are all null while [status] is [DependencyStatus.UNSCHEDULED].
 *
 * [slackDays] is the link's OWN float in working days, `actual - required` (`-shortfall`): 0 or more when [status] is
 * [DependencyStatus.OK] (how far the successor's constrained side could slip before the link breaks), `-shortfallDays` when it is
 * [DependencyStatus.VIOLATED], null while [status] is [DependencyStatus.UNSCHEDULED]. It is the link's float only, not the critical
 * path's slack of a milestone, which is measured toward a project's end.
 */
@Serializable
data class DependencyCheck(
    val status: DependencyStatus,
    val shortfallDays: Int?,
    val slackDays: Int?,
    val requiredDate: String?,
    val actualDate: String?,
)

/**
 * The dependency check as a pure function (no I/O, no clock), the idiom of [SpanKernels]. It reads the working-day index of
 * the [WorkingCalendar] it is handed (`W`: Monday-Friday minus its holidays, flat over every non-working date). A span's EFFECTIVE
 * start is its first working day on or after
 * `start` and its EFFECTIVE end the last working day on or before `end`; with `A` the predecessor, `B` the successor and `lag` in
 * working days (negative = a lead):
 *
 * | Type | required (index)        | actual (index)  |
 * |------|-------------------------|-----------------|
 * | FS   | `W(A.effEnd) + 1 + lag` | `W(B.effStart)` |
 * | SS   | `W(A.effStart) + lag`   | `W(B.effStart)` |
 * | FF   | `W(A.effEnd) + lag`     | `W(B.effEnd)`   |
 * | SF   | `W(A.effStart) - 1 + lag` | `W(B.effEnd)` |
 *
 * Spans are half-open working intervals `[W(effStart), W(effEnd) + 1)`: FS compares the predecessor's exclusive end with the successor's
 * start, and SF the predecessor's start with the successor's exclusive end, so a successor ending the working day BEFORE the
 * predecessor starts satisfies SF at lag 0, as one starting the day after it ends satisfies FS.
 *
 * `shortfall = required - actual`; a positive one is a violation. A violation changes nothing but the view: no date ever moves.
 */
object DependencyKernels {
    /**
     * The check of a [type] link with [lagDays] between the spans [predecessor] and [successor] on [calendar]'s working days; a null
     * span is unscheduled.
     */
    fun check(
        type: DependencyType,
        lagDays: Int,
        predecessor: DaySpan?,
        successor: DaySpan?,
        calendar: WorkingCalendar,
    ): DependencyCheck {
        if (predecessor == null || successor == null) return DependencyCheck(DependencyStatus.UNSCHEDULED, null, null, null, null)
        val required = requiredIndex(type, lagDays, predecessor, calendar)
        val actualDate = actualDate(type, successor, calendar)
        val shortfall = required - calendar.workingDayIndex(actualDate)
        return DependencyCheck(
            status = if (shortfall > 0) DependencyStatus.VIOLATED else DependencyStatus.OK,
            shortfallDays = if (shortfall > 0) shortfall.toInt() else null,
            slackDays = Math.toIntExact(-shortfall),
            requiredDate = calendar.workingDayOfIndex(required).toString(),
            actualDate = actualDate.toString(),
        )
    }

    /** The working-day index the successor's constrained side must reach (the table's `required`); the scheduler's lower bound. */
    internal fun requiredIndex(type: DependencyType, lagDays: Int, predecessor: DaySpan, calendar: WorkingCalendar): Long = when (type) {
        DependencyType.FS -> calendar.workingDayIndex(effectiveEnd(predecessor, calendar)) + 1 + lagDays
        DependencyType.FF -> calendar.workingDayIndex(effectiveEnd(predecessor, calendar)) + lagDays
        DependencyType.SS -> calendar.workingDayIndex(effectiveStart(predecessor, calendar)) + lagDays
        DependencyType.SF -> calendar.workingDayIndex(effectiveStart(predecessor, calendar)) - 1 + lagDays
    }

    /** The successor's side the type constrains: its start for FS and SS, its end for FF and SF. */
    private fun actualDate(type: DependencyType, successor: DaySpan, calendar: WorkingCalendar): LocalDate = when (type) {
        DependencyType.FS, DependencyType.SS -> effectiveStart(successor, calendar)
        DependencyType.FF, DependencyType.SF -> effectiveEnd(successor, calendar)
    }

    private fun effectiveStart(span: DaySpan, calendar: WorkingCalendar): LocalDate = calendar.nextWorkingDayOnOrAfter(span.start)

    private fun effectiveEnd(span: DaySpan, calendar: WorkingCalendar): LocalDate = calendar.previousWorkingDayOnOrBefore(span.end)
}
