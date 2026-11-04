package ch.nokillswit

import ch.nokillswit.infra.time.WorkingCalendar
import ch.nokillswit.planning.CapacityPeriod
import ch.nokillswit.planning.DaySpan
import ch.nokillswit.planning.MAX_LOAD_WEEKS
import ch.nokillswit.planning.OrderKey
import ch.nokillswit.planning.PlanMilestoneFact
import ch.nokillswit.planning.PolishHolidays
import ch.nokillswit.planning.ScheduleInputs
import ch.nokillswit.planning.ScheduleKernels
import ch.nokillswit.planning.TeamScheduleItem
import java.math.BigDecimal
import java.time.LocalDate
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

/**
 * The auto-proposal kernel on a team of 300 scheduled, movable milestones that CASCADES: a capacity cliff (a period at 0 MD/week from
 * week 80, about the middle of the stored dates) and stored dates that fill the capacity (two 5-MD milestones start every week
 * against 10 MD/week), correlated with the team's order. Every pass that leaves milestones unplaced PINS them at
 * their stored dates (a fixed load before the cliff), which squeezes the milestones placed before them out in the next pass; the
 * fixed point takes about 20 passes (measured; the sample plan's one - its capacity never ends) and ends with the whole team pinned.
 * Pure: no server, no database. It prints the milliseconds for `propose` and for `postCheck` (`ScaleFigures`) and asserts a loose
 * tripwire.
 */
class ScheduleKernelsScaleTest {
    private val anchor = LocalDate.parse("2027-01-04") // a Monday
    private val asOf = LocalDate.parse("2027-01-03") // the Sunday before: every milestone is movable
    private val cliff = anchor.plusWeeks(CLIFF_WEEK)

    private val periods = listOf(
        CapacityPeriod(anchor, BigDecimal("10.00"), null),
        CapacityPeriod(cliff, BigDecimal("0.00"), null),
    )

    private val team = List(ITEMS) { i ->
        val start = anchor.plusWeeks((i / PER_WEEK).toLong())
        val projectId = (1 + i / PER_PROJECT).toUInt()
        TeamScheduleItem(
            id = (i + 1).toUInt(),
            projectId = projectId,
            span = DaySpan(start, start.plusDays(4)),
            estimateMd = BigDecimal("5.00"),
            key = OrderKey(i + 1, null, "P$projectId", projectId, start, start.plusDays(4), "m%03d".format(i), (i + 1).toUInt()),
        )
    }

    private fun inputs(calendar: WorkingCalendar) = ScheduleInputs(
        asOf = asOf,
        teamId = 1u,
        team = team,
        periods = periods,
        plan = team.map { PlanMilestoneFact(it.id, it.projectId, 1u, it.span) },
        links = emptyList(),
        calendar = calendar,
        horizonWeeks = MAX_LOAD_WEEKS,
    )

    private fun measure(label: String, calendar: WorkingCalendar) {
        val input = inputs(calendar)
        val result = ScheduleKernels.propose(input)
        assertEquals(ITEMS, result.placements.size + result.unplaced.size, "every movable milestone is placed or listed unplaced")
        assertTrue(result.unplaced.size > ITEMS / 2, "the cliff leaves most of the team unplaced: ${result.unplaced.size}")
        assertTrue(result.placements.all { it.to.end < cliff }, "nothing is placed on or after the zero-capacity cliff")
        val propose = ScaleFigures.series(WARMUPS, RUNS) { ScheduleKernels.propose(input) }
        ScaleFigures.printSeries("propose $ITEMS cascading milestones, $label", propose)
        val check = ScaleFigures.series(WARMUPS, RUNS) { ScheduleKernels.postCheck(input, result) }
        ScaleFigures.printSeries("postCheck $ITEMS cascading milestones, $label", check)
        assertTrue(ScaleFigures.median(propose) <= TRIPWIRE_MS, "propose on $label took ${ScaleFigures.median(propose)} ms (median)")
    }

    @Test
    fun `300 movable milestones against a capacity cliff cascade through the fixed point inside the tripwire`() =
        measure("MON_FRI", WorkingCalendar.MON_FRI)

    @Test
    fun `the same cascade with the Polish holidays stays inside the tripwire`() {
        val holidays = (anchor.year..anchor.plusWeeks(MAX_LOAD_WEEKS.toLong()).year).flatMap { PolishHolidays.of(it) }.toMap()
        measure("Polish holidays", WorkingCalendar(holidays))
    }

    private companion object {
        const val ITEMS = 300
        const val PER_WEEK = 2
        const val PER_PROJECT = 10
        const val CLIFF_WEEK = 80L
        const val WARMUPS = 2
        const val RUNS = 5
        const val TRIPWIRE_MS = 5_000.0
    }
}
