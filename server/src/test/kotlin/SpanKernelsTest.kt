package ch.nokillswit

import ch.nokillswit.infra.time.WorkingCalendar
import ch.nokillswit.planning.DaySpan
import ch.nokillswit.planning.Drift
import ch.nokillswit.planning.PlanMilestoneFact
import ch.nokillswit.planning.ProjectSpanChange
import ch.nokillswit.planning.SpanKernels
import java.time.LocalDate
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull

/** The pure span kernels (no server, no database): table-driven. */
class SpanKernelsTest {
    private fun span(start: String, end: String) = DaySpan(LocalDate.parse(start), LocalDate.parse(end))

    @Test
    fun `the derived span runs from the earliest start to the latest end`() {
        val cases = listOf(
            "none" to (emptyList<DaySpan>() to null),
            "one span is itself" to (listOf(span("2026-11-02", "2026-11-13")) to span("2026-11-02", "2026-11-13")),
            "one day" to (listOf(span("2026-11-03", "2026-11-03")) to span("2026-11-03", "2026-11-03")),
            "disjoint spans leave the gap inside" to
                (listOf(span("2026-11-02", "2026-11-04"), span("2026-12-01", "2026-12-04")) to span("2026-11-02", "2026-12-04")),
            "the earliest start and the latest end come from different spans" to
                (listOf(span("2026-11-10", "2026-12-31"), span("2026-11-02", "2026-11-05")) to span("2026-11-02", "2026-12-31")),
            "a span nested in another changes nothing" to
                (listOf(span("2026-11-02", "2026-12-31"), span("2026-11-10", "2026-11-12")) to span("2026-11-02", "2026-12-31")),
            "order does not matter" to
                (listOf(span("2026-12-01", "2026-12-04"), span("2026-11-02", "2026-11-04")) to span("2026-11-02", "2026-12-04")),
            "across a year boundary" to
                (listOf(span("2026-12-28", "2027-01-08"), span("2026-12-01", "2026-12-05")) to span("2026-12-01", "2027-01-08")),
        )
        for ((label, case) in cases) assertEquals(case.second, SpanKernels.derivedSpan(case.first), label)
    }

    @Test
    fun `drift is the signed day delta of the span against the target - positive is later`() {
        val target = span("2026-11-02", "2026-11-30")
        val cases = listOf(
            "on target" to (span("2026-11-02", "2026-11-30") to Drift(0, 0)),
            "ends 12 days late" to (span("2026-11-02", "2026-12-12") to Drift(0, 12)),
            "ahead by 3 days at both ends" to (span("2026-10-30", "2026-11-27") to Drift(-3, -3)),
            "starts late and ends early" to (span("2026-11-09", "2026-11-23") to Drift(7, -7)),
            "across a leap day (2028-02-29 counts)" to (span("2028-03-01", "2028-03-01") to Drift(485, 457)),
        )
        for ((label, case) in cases) assertEquals(case.second, SpanKernels.drift(case.first, target), label)
    }

    @Test
    fun `drift is null unless both the span and the target exist`() {
        assertNull(SpanKernels.drift(null, null))
        assertNull(SpanKernels.drift(null, span("2026-11-02", "2026-11-30")), "nothing scheduled")
        assertNull(SpanKernels.drift(span("2026-11-02", "2026-11-30"), null), "no target window")
    }

    /**
     * Hand-counted `projectSpanChanges`. 2027-02-01 is a Monday; teams 1 and 2 are in the run, team 3 is not. A milestone is
     * `fact(id, project, team, span)`; the run's answer is `after` (team -> milestone -> span; absent = no dates).
     */
    private fun fact(id: UInt, project: UInt, team: UInt, span: DaySpan?) = PlanMilestoneFact(id, project, team, span)

    private val plan = listOf(
        // Project 7 spans two run teams: 02-01..02-04 now.
        fact(1u, 7u, 1u, span("2027-02-01", "2027-02-03")),
        fact(2u, 7u, 2u, span("2027-02-02", "2027-02-04")),
        // Project 5: a run team's milestone and one of team 3 (outside the run), 02-01..02-19 now.
        fact(3u, 5u, 1u, span("2027-02-01", "2027-02-02")),
        fact(4u, 5u, 3u, span("2027-02-15", "2027-02-19")),
        // Project 9: nothing scheduled yet.
        fact(5u, 9u, 1u, null),
        // Project 3: unchanged. Project 4: a milestone the run leaves unplaced and without dates.
        fact(6u, 3u, 1u, span("2027-02-01", "2027-02-02")),
        fact(7u, 4u, 1u, null),
        // Project 6: a milestone moves INSIDE the span another one holds.
        fact(8u, 6u, 1u, span("2027-02-01", "2027-02-05")),
        fact(9u, 6u, 2u, span("2027-02-01", "2027-02-05")),
        // Project 10: moves earlier.
        fact(11u, 10u, 1u, span("2027-02-15", "2027-02-19")),
    )

    private val after = mapOf(
        1u to mapOf(
            1u to span("2027-02-08", "2027-02-10"),
            3u to span("2027-02-08", "2027-02-09"),
            5u to span("2027-02-03", "2027-02-05"),
            6u to span("2027-02-01", "2027-02-02"),
            8u to span("2027-02-02", "2027-02-03"),
            11u to span("2027-02-08", "2027-02-10"),
        ),
        2u to mapOf(2u to span("2027-02-15", "2027-02-17"), 9u to span("2027-02-01", "2027-02-05")),
    )

    @Test
    fun `projectSpanChanges lists only the projects whose derived span changes, ascending, over every milestone`() {
        val expected = listOf(
            // 5: the run moves 02-01..02-02 to 02-08..02-09, team 3's milestone keeps 02-15..02-19: start 02-08, end unchanged (shift 0).
            ProjectSpanChange(5u, span("2027-02-01", "2027-02-19"), span("2027-02-08", "2027-02-19"), 0),
            // 7: two run teams, 02-01..02-04 -> 02-08..02-17; Thu 02-04 to Wed 02-17 = 02-05, 02-08..02-12 (5), 02-15..02-17 (3) = 9.
            ProjectSpanChange(7u, span("2027-02-01", "2027-02-04"), span("2027-02-08", "2027-02-17"), 9),
            // 9: newly spanned, so no end to shift from.
            ProjectSpanChange(9u, null, span("2027-02-03", "2027-02-05"), null),
            // 10: Fri 02-19 back to Wed 02-10 = 02-18, 02-17, 02-16, 02-15, 02-12, 02-11, 02-10 = -7.
            ProjectSpanChange(10u, span("2027-02-15", "2027-02-19"), span("2027-02-08", "2027-02-10"), -7),
        )
        val actual = SpanKernels.projectSpanChanges(plan, after, WorkingCalendar.MON_FRI)
        assertEquals(expected, actual, "3 (unchanged), 4 (no dates either way) and 6 (a move inside the span) are absent")
    }

    @Test
    fun `projectSpanChanges does not depend on the order of the plan`() {
        val expected = SpanKernels.projectSpanChanges(plan, after, WorkingCalendar.MON_FRI)
        assertEquals(expected, SpanKernels.projectSpanChanges(plan.reversed(), after, WorkingCalendar.MON_FRI))
        assertEquals(expected, SpanKernels.projectSpanChanges(plan.shuffled(java.util.Random(7)), after, WorkingCalendar.MON_FRI))
    }

    @Test
    fun `projectSpanChanges counts working days, a holiday is not one`() {
        val milestones = listOf(fact(1u, 1u, 1u, span("2027-02-01", "2027-02-02")))
        val moved = mapOf(1u to mapOf(1u to span("2027-02-04", "2027-02-05")))
        val wednesdayOff = WorkingCalendar(mapOf(LocalDate.parse("2027-02-03") to "Day off"))
        assertEquals(3, SpanKernels.projectSpanChanges(milestones, moved, WorkingCalendar.MON_FRI).single().endShiftDays)
        assertEquals(2, SpanKernels.projectSpanChanges(milestones, moved, wednesdayOff).single().endShiftDays, "Tue 02-02 to Fri 02-05")
    }

    @Test
    fun `projectSpanChanges is empty for a run that moves nothing or an empty plan`() {
        assertEquals(emptyList(), SpanKernels.projectSpanChanges(emptyList(), emptyMap(), WorkingCalendar.MON_FRI))
        val same = mapOf(1u to mapOf(6u to span("2027-02-01", "2027-02-02")), 2u to emptyMap())
        assertEquals(emptyList(), SpanKernels.projectSpanChanges(plan.filter { it.projectId == 3u }, same, WorkingCalendar.MON_FRI))
    }
}
