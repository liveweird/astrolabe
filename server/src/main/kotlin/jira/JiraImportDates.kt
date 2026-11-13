package ch.nokillswit.jira

import ch.nokillswit.infra.time.WorkingCalendar
import ch.nokillswit.infra.validation.LAST_PLAN_DAY
import ch.nokillswit.planning.MilestoneSpan
import ch.nokillswit.planning.TargetWindow
import java.time.LocalDate

/** The first year a plan date may have (`parseIsoDate`'s calendar: 1900-2999). */
private const val FIRST_PLAN_YEAR = 1900

/** A milestone's dates after the rules: the span to write (null = unscheduled) and the one info that says why. */
internal class DatesVerdict(val span: MilestoneSpan?, val info: JiraImportInfo?)

/** A created project's window verdict (1.14): the [window] to write, else the [info] saying why not (none when Jira has no dates). */
internal class WindowVerdict(val window: TargetWindow?, val info: JiraImportInfo?)

/**
 * The import's date rules (split out of [ImportPlanner]): what a created milestone's dates and a created project's target window
 * become. [copyDates] is the request's switch; [milestoneHasDateFields] whether the mapping reads any milestone date at all.
 */
internal class ImportDateRules(
    private val copyDates: Boolean,
    private val milestoneHasDateFields: Boolean,
    private val calendar: WorkingCalendar,
) {
    fun datesFor(obs: JiraObservation, canSchedule: Boolean): DatesVerdict {
        if (!copyDates) return DatesVerdict(null, null)
        val start = obs.startDate
        val end = obs.endDate
        if (start == null || end == null) {
            return DatesVerdict(null, JiraImportInfo.DATES_INVALID.takeIf { milestoneHasDateFields })
        }
        return when {
            end.isBefore(start) || !inPlanYears(start) || !inPlanYears(end) -> DatesVerdict(null, JiraImportInfo.DATES_INVALID)
            !canSchedule -> DatesVerdict(null, JiraImportInfo.DATES_NOT_COPIED)
            !calendar.containsWorkingDay(start, end) -> DatesVerdict(null, JiraImportInfo.NO_WORKING_DAY)
            else -> DatesVerdict(MilestoneSpan(start, end), null)
        }
    }

    /**
     * A created project's target window from Jira's dates (1.14): BOTH dates, in order and inside the plan's years, else none and the
     * row is created all the same. A Jira item with no dates at all says nothing (a project often has none); a lone date or a
     * reversed pair says [JiraImportInfo.TARGET_NOT_COPIED]. Who may set it is not asked here: whoever may create the project is the
     * stream's or the program's owner (or ADMIN), the project chain's ancestors, which `requireTargetWindowEditorOrAdmin` admits.
     */
    fun windowFor(obs: JiraObservation): WindowVerdict {
        val start = obs.startDate
        val end = obs.endDate
        return when {
            !copyDates || (start == null && end == null) -> WindowVerdict(null, null)
            start == null || end == null || end.isBefore(start) || !inPlanYears(start) || !inPlanYears(end) ->
                WindowVerdict(null, JiraImportInfo.TARGET_NOT_COPIED)
            else -> WindowVerdict(TargetWindow(start, end), null)
        }
    }

    // Defence in depth: the observation's dates come from `isoDateOrNull`, which already reads an out-of-range or unparseable date as
    // missing, so real data never reaches this check; it keeps `windowFor` safe if a caller ever hands it a date the plan cannot hold.
    private fun inPlanYears(date: LocalDate): Boolean = date.year in FIRST_PLAN_YEAR..LAST_PLAN_DAY.year
}
