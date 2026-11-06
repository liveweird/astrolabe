package ch.nokillswit

import ch.nokillswit.infra.time.WorkingCalendar
import ch.nokillswit.jira.Deviation
import ch.nokillswit.jira.DeviationKind
import ch.nokillswit.jira.DeviationMapping
import ch.nokillswit.jira.DeviationSeverity
import ch.nokillswit.jira.JiraDeviationKernels
import ch.nokillswit.jira.JiraEstimateUnit
import ch.nokillswit.jira.JiraLevel
import ch.nokillswit.jira.JiraStatusCategory
import ch.nokillswit.jira.ObservedIssue
import ch.nokillswit.jira.PlanParent
import ch.nokillswit.jira.PlanRef
import ch.nokillswit.jira.PlanSide
import java.math.BigDecimal
import java.time.LocalDate
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * The deviation rules as pure vectors (the table in the spec's `getDeviationsView` description). 2027-02-01 is a MONDAY: the week is
 * Mon 02-01 .. Fri 02-05, the weekend 02-06/07, the next week Mon 02-08 .. Fri 02-12. Every date kind has a holiday case.
 */
class JiraDeviationKernelsTest {
    private fun d(text: String) = LocalDate.parse(text)

    private val monFri = WorkingCalendar.MON_FRI
    private fun holidays(vararg dates: String) = WorkingCalendar(dates.associate { d(it) to "holiday" })

    private val milestoneMapping = DeviationMapping(1, JiraEstimateUnit.POINTS, null)

    private fun issue(
        summary: String? = "Alpha",
        level: Int? = 1,
        status: JiraStatusCategory = JiraStatusCategory.UNKNOWN,
        parentId: String? = null,
        parentKey: String? = null,
        start: String? = null,
        end: String? = null,
        estimate: String? = null,
        unit: JiraEstimateUnit? = null,
        gone: Boolean = false,
        goneReason: String? = null,
    ) = ObservedIssue(
        summary, level, status, parentId, parentKey, start?.let(::d), end?.let(::d), estimate?.let(::BigDecimal), unit, gone, goneReason,
    )

    private fun plan(
        name: String = "Alpha",
        start: String? = null,
        end: String? = null,
        targetStart: String? = null,
        targetEnd: String? = null,
        estimate: String? = null,
        parent: PlanParent? = null,
    ) = PlanSide(name, start?.let(::d), end?.let(::d), targetStart?.let(::d), targetEnd?.let(::d), estimate?.let(::BigDecimal), parent)

    private fun run(
        issue: ObservedIssue?,
        plan: PlanSide,
        level: JiraLevel = JiraLevel.MILESTONE,
        mapping: DeviationMapping? = milestoneMapping,
        parentBoundTo: PlanRef? = null,
        calendar: WorkingCalendar = monFri,
        asOf: String = "2027-02-01",
    ): List<Deviation> = JiraDeviationKernels.deviations(level, issue, plan, mapping, parentBoundTo, calendar, d(asOf))

    private fun List<Deviation>.kinds() = map { it.kind }

    private fun List<Deviation>.one(kind: DeviationKind): Deviation = single { it.kind == kind }

    @Test
    fun `a binding never observed deviates from nothing`() {
        assertEquals(emptyList(), run(null, plan(start = "2027-02-01", end = "2027-02-05")))
    }

    @Test
    fun `a gone issue raises GONE alone even when its stale dates, level and name all differ`() {
        val stale = issue(
            summary = "Beta", level = 0, status = JiraStatusCategory.DONE, start = "2027-03-01", end = "2027-03-05", gone = true,
            goneReason = "OUT_OF_SCOPE",
        )
        val found = run(stale, plan(start = "2027-02-01", end = "2027-02-05"))
        assertEquals(listOf(DeviationKind.GONE), found.kinds())
        assertEquals(DeviationSeverity.WARNING, found.single().severity)
        assertEquals("OUT_OF_SCOPE", found.single().detail.jira)
    }

    @Test
    fun `an aligned binding deviates from nothing`() {
        val aligned = issue(start = "2027-02-01", end = "2027-02-05", status = JiraStatusCategory.IN_PROGRESS)
        assertEquals(emptyList(), run(aligned, plan(start = "2027-02-01", end = "2027-02-05")))
    }

    // --- LEVEL_MISMATCH --------------------------------------------------------------------------------------------------------------

    @Test
    fun `a level other than the mapping's is a WARNING, an unknown one counts as a mismatch, no mapping compares nothing`() {
        val wrong = run(issue(level = 0), plan()).one(DeviationKind.LEVEL_MISMATCH)
        assertEquals(DeviationSeverity.WARNING, wrong.severity)
        assertEquals("0", wrong.detail.jira)
        assertEquals("1", wrong.detail.plan)
        assertEquals("unknown", run(issue(level = null), plan()).one(DeviationKind.LEVEL_MISMATCH).detail.jira)
        assertFalse(DeviationKind.LEVEL_MISMATCH in run(issue(level = 1), plan()).kinds())
        assertEquals(
            emptyList(), run(issue(level = 0), plan(), mapping = null), "an unset, stale or unreadable mapping: nothing to compare",
        )
    }

    // --- PARENT_MISMATCH -------------------------------------------------------------------------------------------------------------

    @Test
    fun `a parent bound to another node is a WARNING, an unbound parent or the right one raises nothing, a program has no parent rule`() {
        val parent = PlanParent(PlanRef(JiraLevel.PROJECT, 7u), "Gamma")
        val child = issue(parentId = "9001", parentKey = "ABC-1")
        val other = PlanRef(JiraLevel.PROJECT, 8u)
        val found = run(child, plan(parent = parent), parentBoundTo = other).one(DeviationKind.PARENT_MISMATCH)
        assertEquals(DeviationSeverity.WARNING, found.severity)
        assertEquals("ABC-1", found.detail.jira)
        assertEquals("Gamma", found.detail.plan)
        // A parent issue bound to a node of ANOTHER LEVEL than the plan parent is a mismatch too (ids chosen apart: no coincidence).
        val otherLevel = PlanRef(JiraLevel.MILESTONE, 9u)
        assertEquals(DeviationKind.PARENT_MISMATCH, run(child, plan(parent = parent), parentBoundTo = otherLevel).single().kind)
        assertEquals(emptyList(), run(child, plan(parent = parent), parentBoundTo = parent.ref), "bound to the live parent")
        assertEquals(emptyList(), run(child, plan(parent = parent), parentBoundTo = null), "an unbound parent raises nothing")
        assertEquals(emptyList(), run(child, plan(parent = null), parentBoundTo = other), "no plan parent to compare")
        assertEquals(emptyList(), run(child, plan(parent = parent), JiraLevel.PROGRAM, parentBoundTo = other))
    }

    // --- RENAMED ---------------------------------------------------------------------------------------------------------------------

    @Test
    fun `a rename is INFO, trimmed and case-insensitive, and a name cut at 100 characters compares as a prefix`() {
        val renamed = run(issue(summary = "Beta"), plan(name = "Alpha")).one(DeviationKind.RENAMED)
        assertEquals(DeviationSeverity.INFO, renamed.severity)
        assertEquals("Beta", renamed.detail.jira)
        assertEquals("Alpha", renamed.detail.plan)
        assertEquals(emptyList(), run(issue(summary = "  ALPHA  "), plan(name = "alpha")))

        val long = "a".repeat(255)
        val cut = long.take(100)
        assertEquals(emptyList(), run(issue(summary = long), plan(name = cut)), "the 100-character name is the summary's prefix")
        assertEquals(emptyList(), run(issue(summary = long), plan(name = cut.dropLast(1))), "a pair cut leaves 99")
        assertEquals(
            DeviationKind.RENAMED, run(issue(summary = long), plan(name = "a".repeat(50))).single().kind, "a SHORT prefix is a rename",
        )
        assertEquals(DeviationKind.RENAMED, run(issue(summary = long.replaceRange(60, 61, "b")), plan(name = cut)).single().kind)
    }

    // --- START_DIFFERS / END_DIFFERS -------------------------------------------------------------------------------------------------

    @Test
    fun `dates on the same working day never deviate - the shift is 0 across a weekend`() {
        // Saturday 02-06 and Monday 02-08 both snap to Monday 02-08 as a start; Sunday 02-07 and Friday 02-05 both snap to Friday as an
        // end.
        val found = run(issue(start = "2027-02-08", end = "2027-02-05"), plan(start = "2027-02-06", end = "2027-02-07"))
        assertEquals(emptyList(), found)
    }

    @Test
    fun `a shift is in working days and POSITIVE when the plan is later`() {
        val found = run(issue(start = "2027-02-01", end = "2027-02-05"), plan(start = "2027-02-02", end = "2027-02-08"))
        val start = found.one(DeviationKind.START_DIFFERS)
        assertEquals(1, start.detail.days)
        assertEquals("2027-02-01", start.detail.jira)
        assertEquals("2027-02-02", start.detail.plan)
        assertEquals(1, found.one(DeviationKind.END_DIFFERS).detail.days, "Fri -> Mon is ONE working day, not three")
        val earlier = run(issue(start = "2027-02-08", end = "2027-02-12"), plan(start = "2027-02-05", end = "2027-02-11"))
        assertEquals(-1, earlier.one(DeviationKind.START_DIFFERS).detail.days)
        assertEquals(-1, earlier.one(DeviationKind.END_DIFFERS).detail.days)
    }

    @Test
    fun `the severity is WARNING exactly when the plan's end is later than Jira's end, and flips at the boundary`() {
        val jira = issue(start = "2027-02-01", end = "2027-02-05")
        val later = run(jira, plan(start = "2027-02-02", end = "2027-02-08"))
        assertEquals(DeviationSeverity.WARNING, later.one(DeviationKind.END_DIFFERS).severity)
        assertEquals(
            DeviationSeverity.WARNING, later.one(DeviationKind.START_DIFFERS).severity, "a differing start inherits the end's verdict",
        )
        val earlier = run(jira, plan(start = "2027-02-01", end = "2027-02-04"))
        assertEquals(DeviationSeverity.INFO, earlier.one(DeviationKind.END_DIFFERS).severity)
        val startOnly = run(jira, plan(start = "2027-02-02", end = "2027-02-05"))
        assertEquals(DeviationSeverity.INFO, startOnly.single().severity, "the ends agree: nothing is later")
        assertEquals(listOf(DeviationKind.START_DIFFERS), startOnly.kinds())
    }

    @Test
    fun `each side compares only a date both have`() {
        assertEquals(emptyList(), run(issue(start = "2027-02-01"), plan(start = "2027-02-01", end = "2027-02-05")))
        val endOnly = run(issue(end = "2027-02-04"), plan(start = "2027-02-01", end = "2027-02-05"))
        assertEquals(listOf(DeviationKind.END_DIFFERS), endOnly.kinds())
        assertEquals(DeviationSeverity.WARNING, endOnly.single().severity)
    }

    @Test
    fun `a holiday moves a start - the shift counts it as off`() {
        val tuesdayOff = holidays("2027-02-02")
        val jira = issue(start = "2027-02-01", end = "2027-02-05")
        // Mon -> Wed is 2 working days on Mon-Fri and ONE with Tuesday off.
        assertEquals(2, run(jira, plan(start = "2027-02-03", end = "2027-02-05")).one(DeviationKind.START_DIFFERS).detail.days)
        assertEquals(
            1,
            run(jira, plan(start = "2027-02-03", end = "2027-02-05"), calendar = tuesdayOff).one(DeviationKind.START_DIFFERS).detail.days,
        )
        // A start ON the holiday snaps to Wednesday, so it equals a Wednesday start.
        assertEquals(
            emptyList(),
            run(issue(start = "2027-02-03", end = "2027-02-05"), plan(start = "2027-02-02", end = "2027-02-05"), calendar = tuesdayOff),
        )
        assertEquals(
            DeviationKind.START_DIFFERS,
            run(issue(start = "2027-02-03", end = "2027-02-05"), plan(start = "2027-02-02", end = "2027-02-05")).single().kind,
        )
    }

    @Test
    fun `a holiday moves an end - an end ON the holiday snaps back to the working day before it`() {
        val mondayOff = holidays("2027-02-08")
        val jira = issue(start = "2027-02-01", end = "2027-02-05")
        assertEquals(DeviationKind.END_DIFFERS, run(jira, plan(start = "2027-02-01", end = "2027-02-08")).single().kind)
        assertEquals(
            emptyList(), run(jira, plan(start = "2027-02-01", end = "2027-02-08"), calendar = mondayOff),
            "Mon 02-08 is off: Fri is the effective end",
        )
        // Fri -> Tue across the off Monday is ONE working day.
        assertEquals(
            1, run(jira, plan(start = "2027-02-01", end = "2027-02-09"), calendar = mondayOff).one(DeviationKind.END_DIFFERS).detail.days,
        )
    }

    // --- TARGET_DIFFERS --------------------------------------------------------------------------------------------------------------

    @Test
    fun `a project's target window differing from Jira's dates is INFO, with the end's shift else the start's`() {
        val jira = issue(level = 2, start = "2027-02-01", end = "2027-02-05")
        val mapping = DeviationMapping(2, JiraEstimateUnit.POINTS, null)
        fun target(start: String, end: String) =
            run(jira, plan(targetStart = start, targetEnd = end), JiraLevel.PROJECT, mapping)
        assertEquals(emptyList(), target("2027-02-01", "2027-02-05"))
        val both = target("2027-02-02", "2027-02-09").single()
        assertEquals(DeviationKind.TARGET_DIFFERS, both.kind)
        assertEquals(DeviationSeverity.INFO, both.severity)
        assertEquals(2, both.detail.days, "the END's shift (Fri -> Tue)")
        assertEquals(1, target("2027-02-02", "2027-02-05").single().detail.days, "only the start differs")
        val weekendWindow = run(
            issue(level = 2, start = "2027-02-08", end = "2027-02-05"), plan(targetStart = "2027-02-06", targetEnd = "2027-02-07"),
            JiraLevel.PROJECT, mapping,
        )
        assertEquals(emptyList(), weekendWindow, "a Saturday start is Monday's, a Sunday end is Friday's")
        // Not a project: a milestone has no target window rule; a missing side compares nothing.
        assertFalse(DeviationKind.TARGET_DIFFERS in run(jira, plan(targetStart = "2027-02-02", targetEnd = "2027-02-09")).kinds())
        assertFalse(DeviationKind.TARGET_DIFFERS in run(
            issue(level = 2, end = "2027-02-05"), plan(targetStart = "2027-02-02", targetEnd = "2027-02-09"), JiraLevel.PROJECT, mapping,
        ).kinds())
        assertFalse(DeviationKind.TARGET_DIFFERS in run(jira, plan(targetStart = "2027-02-02"), JiraLevel.PROJECT, mapping).kinds())
    }

    @Test
    fun `the target window follows the working calendar - a holiday start equals the next working day, a weekend end the previous`() {
        val mapping = DeviationMapping(2, JiraEstimateUnit.POINTS, null)
        val jira = issue(level = 2, start = "2027-02-03", end = "2027-02-05")
        val window = plan(targetStart = "2027-02-02", targetEnd = "2027-02-07")
        assertEquals(DeviationKind.TARGET_DIFFERS, run(jira, window, JiraLevel.PROJECT, mapping).single().kind)
        assertEquals(emptyList(), run(jira, window, JiraLevel.PROJECT, mapping, calendar = holidays("2027-02-02")))
    }

    // --- UNSCHEDULED_* ---------------------------------------------------------------------------------------------------------------

    @Test
    fun `a milestone dated on one side only is INFO, whichever side`() {
        val inPlan = run(issue(end = "2027-02-05"), plan())
        assertEquals(listOf(DeviationKind.UNSCHEDULED_IN_PLAN), inPlan.kinds())
        assertEquals(DeviationSeverity.INFO, inPlan.single().severity)
        val inJira = run(issue(), plan(start = "2027-02-01", end = "2027-02-05"))
        assertEquals(listOf(DeviationKind.UNSCHEDULED_IN_JIRA), inJira.kinds())
        assertEquals(emptyList(), run(issue(), plan()), "neither dated")
        // The table lists these for milestones only.
        assertEquals(emptyList(), run(issue(level = 2), plan(), JiraLevel.PROJECT, DeviationMapping(2, JiraEstimateUnit.POINTS, null)))
        assertEquals(
            emptyList(),
            run(
                issue(level = 2), plan(start = "2027-02-01", end = "2027-02-05"), JiraLevel.PROJECT,
                DeviationMapping(2, JiraEstimateUnit.POINTS, null),
            ),
        )
    }

    // --- estimates -------------------------------------------------------------------------------------------------------------------

    @Test
    fun `DAYS compares as-is and the tolerance is 0_01 man-days`() {
        val days = DeviationMapping(1, JiraEstimateUnit.DAYS, null)
        fun check(figure: String, md: String) =
            run(issue(estimate = figure, unit = JiraEstimateUnit.DAYS), plan(estimate = md), mapping = days)
        assertEquals(emptyList(), check("8.00", "8.00"))
        val off = check("8.01", "8.00").single()
        assertEquals(DeviationKind.ESTIMATE_DIFFERS, off.kind)
        assertEquals(DeviationSeverity.INFO, off.severity)
        assertEquals("8.01", off.detail.jira)
        assertEquals("8.00", off.detail.plan)
        assertEquals(DeviationKind.ESTIMATE_DIFFERS, check("7.99", "8.00").single().kind)
    }

    @Test
    fun `DAYS ignores a leftover factor - the mapping needs none`() {
        val days = DeviationMapping(1, JiraEstimateUnit.DAYS, 0.5)
        val aligned = run(issue(estimate = "8.00", unit = JiraEstimateUnit.DAYS), plan(estimate = "8.00"), mapping = days)
        assertEquals(emptyList(), aligned, "8 days is 8 man-days, not 4")
        val off = run(issue(estimate = "8.00", unit = JiraEstimateUnit.DAYS), plan(estimate = "4.00"), mapping = days).single()
        assertEquals(DeviationKind.ESTIMATE_DIFFERS, off.kind)
        assertEquals("8.00", off.detail.jira)
    }

    @Test
    fun `a factor converts the figure - 21 points at 0_5 is 10_5 man-days - and a sub-tolerance difference is none`() {
        val points = DeviationMapping(1, JiraEstimateUnit.POINTS, 0.5)
        fun check(figure: String, md: String) =
            run(issue(estimate = figure, unit = JiraEstimateUnit.POINTS), plan(estimate = md), mapping = points)
        val found = check("21.00", "8.00").single()
        assertEquals(DeviationKind.ESTIMATE_DIFFERS, found.kind)
        assertEquals("10.50", found.detail.jira)
        assertEquals("8.00", found.detail.plan)
        assertEquals(emptyList(), check("21.00", "10.50"))
        assertEquals(emptyList(), check("2.01", "1.00"), "1.005 vs 1.00 is 0.005 apart: under the tolerance")
        assertEquals(DeviationKind.ESTIMATE_DIFFERS, check("2.02", "1.00").single().kind, "1.01 vs 1.00 is exactly 0.01 apart")
    }

    @Test
    fun `a figure with no factor, or read under another unit than the mapping names now, is NOT_COMPARABLE and shown as is`() {
        val noFactor = run(issue(estimate = "21.00", unit = JiraEstimateUnit.POINTS), plan(estimate = "8.00")).single()
        assertEquals(DeviationKind.ESTIMATE_NOT_COMPARABLE, noFactor.kind)
        assertEquals(DeviationSeverity.INFO, noFactor.severity)
        assertEquals("21.00", noFactor.detail.jira)
        assertEquals("8.00", noFactor.detail.plan)
        val stale = run(
            issue(estimate = "21.00", unit = JiraEstimateUnit.POINTS), plan(estimate = "8.00"),
            mapping = DeviationMapping(1, JiraEstimateUnit.DAYS, null),
        )
        assertEquals(listOf(DeviationKind.ESTIMATE_NOT_COMPARABLE), stale.kinds(), "the mapping changed since the observation")
    }

    @Test
    fun `estimates need a milestone, a mapping, an observed figure and a plan estimate`() {
        val figure = issue(estimate = "8.00", unit = JiraEstimateUnit.DAYS, level = 2)
        val days = DeviationMapping(2, JiraEstimateUnit.DAYS, null)
        assertEquals(emptyList(), run(figure, plan(estimate = "1.00"), JiraLevel.PROJECT, days))
        assertEquals(emptyList(), run(issue(estimate = "8.00", unit = JiraEstimateUnit.DAYS), plan(estimate = "1.00"), mapping = null))
        assertEquals(emptyList(), run(issue(), plan(estimate = "1.00"), mapping = DeviationMapping(1, JiraEstimateUnit.DAYS, null)))
        assertEquals(
            emptyList(),
            run(issue(estimate = "8.00", unit = JiraEstimateUnit.DAYS), plan(), mapping = DeviationMapping(1, JiraEstimateUnit.DAYS, null)),
        )
    }

    // --- PROGRESS_MISMATCH -----------------------------------------------------------------------------------------------------------

    @Test
    fun `DONE while the plan ends after today, TODO while it started before, IN_PROGRESS while it starts after - today is clean`() {
        val window = plan(start = "2027-02-02", end = "2027-02-05")
        fun status(category: JiraStatusCategory, asOf: String) =
            run(issue(status = category), window, asOf = asOf).filter { it.kind == DeviationKind.PROGRESS_MISMATCH }

        val done = status(JiraStatusCategory.DONE, "2027-02-04").single()
        assertEquals(DeviationSeverity.INFO, done.severity)
        assertEquals("DONE", done.detail.jira)
        assertEquals("2027-02-05", done.detail.plan)
        assertTrue(status(JiraStatusCategory.DONE, "2027-02-05").isEmpty(), "ending today is not after today")
        assertEquals("2027-02-02", status(JiraStatusCategory.TODO, "2027-02-03").single().detail.plan)
        assertTrue(status(JiraStatusCategory.TODO, "2027-02-02").isEmpty(), "starting today is not before today")
        assertEquals("2027-02-02", status(JiraStatusCategory.IN_PROGRESS, "2027-02-01").single().detail.plan)
        assertTrue(status(JiraStatusCategory.IN_PROGRESS, "2027-02-02").isEmpty())
        assertTrue(status(JiraStatusCategory.UNKNOWN, "2027-02-01").isEmpty())
        assertNull(run(
            issue(status = JiraStatusCategory.DONE), plan(), asOf = "2027-02-01",
        ).firstOrNull { it.kind == DeviationKind.PROGRESS_MISMATCH })
    }

    // --- order -----------------------------------------------------------------------------------------------------------------------

    @Test
    fun `an item's deviations come WARNING first, then in the kind's declaration order`() {
        val found = run(
            issue(
                summary = "Beta", level = 0, start = "2027-02-01", end = "2027-02-05", estimate = "21.00", unit = JiraEstimateUnit.POINTS,
            ),
            plan(start = "2027-02-02", end = "2027-02-08", estimate = "8.00"),
        )
        assertEquals(
            listOf(
                DeviationKind.LEVEL_MISMATCH, DeviationKind.START_DIFFERS, DeviationKind.END_DIFFERS,
                DeviationKind.RENAMED, DeviationKind.ESTIMATE_NOT_COMPARABLE,
            ),
            found.kinds(),
        )
        assertEquals(DeviationSeverity.WARNING, found.first().severity)
    }
}
