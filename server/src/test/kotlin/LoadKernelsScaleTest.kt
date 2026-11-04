package ch.nokillswit

import ch.nokillswit.infra.time.WorkingCalendar
import ch.nokillswit.planning.CapacityPeriod
import ch.nokillswit.planning.DaySpan
import ch.nokillswit.planning.LoadItem
import ch.nokillswit.planning.MAX_LOAD_WEEKS
import ch.nokillswit.planning.PolishHolidays
import ch.nokillswit.planning.weeklyLoad
import java.math.BigDecimal
import java.time.LocalDate
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

/**
 * `weeklyLoad` at the team view's cap: [MAX_LOAD_WEEKS] weeks (a ten-year window) by 300 items (Platform on the sample plan has 301),
 * once on the plain Monday-Friday calendar and once with the Polish public holidays of the whole window. Pure: no server, no database.
 * It prints the milliseconds per call (`ScaleFigures`) and asserts a loose tripwire - the bound is far above the measured figure, so
 * only an order-of-magnitude regression trips it (`timeline.md` "Measured figures (1.0.0)" records the figure and the margin).
 */
class LoadKernelsScaleTest {
    private val anchor = LocalDate.parse("2027-01-04") // a Monday
    private val window = DaySpan(anchor, anchor.plusWeeks(MAX_LOAD_WEEKS.toLong()).minusDays(1))

    /** 300 items spread over the whole window, 4 to 52 days long, 1.5 to 20.5 man-days: every week meets about 6 of them. */
    private val items = List(ITEMS) { i ->
        val start = anchor.plusDays(i * START_STEP_DAYS)
        val end = minOf(start.plusDays(4L + (i % LENGTH_STEPS) * LENGTH_STEP_DAYS), window.end)
        LoadItem(DaySpan(start, end), BigDecimal("${1 + i % MAX_MD}.50"))
    }

    private val periods = listOf(
        CapacityPeriod(anchor.minusWeeks(1), BigDecimal("40.00"), 8),
        CapacityPeriod(anchor.plusWeeks(150), BigDecimal("55.00"), null),
        CapacityPeriod(anchor.plusWeeks(300), BigDecimal("30.00"), 5),
    )

    private val polish = WorkingCalendar(
        (anchor.year..window.end.year).flatMap { PolishHolidays.of(it) }.toMap(),
    )

    private fun measure(label: String, calendar: WorkingCalendar) {
        val weeks = weeklyLoad(items, periods, window, calendar)
        assertEquals(MAX_LOAD_WEEKS, weeks.size)
        assertTrue(weeks.any { it.load.signum() > 0 } && weeks.all { it.capacity != null })
        val timings = ScaleFigures.series(WARMUPS, RUNS) { weeklyLoad(items, periods, window, calendar) }
        ScaleFigures.printSeries("weeklyLoad $MAX_LOAD_WEEKS weeks x $ITEMS items, $label", timings)
        assertTrue(ScaleFigures.median(timings) <= TRIPWIRE_MS, "weeklyLoad on $label took ${ScaleFigures.median(timings)} ms (median)")
    }

    @Test
    fun `weeklyLoad over the capped window and 300 items on the Monday-Friday calendar stays far inside the tripwire`() =
        measure("MON_FRI", WorkingCalendar.MON_FRI)

    @Test
    fun `weeklyLoad over the capped window and 300 items with the Polish holidays stays far inside the tripwire`() =
        measure("Polish holidays", polish)

    private companion object {
        const val ITEMS = 300
        const val START_STEP_DAYS = 12L
        const val LENGTH_STEPS = 7
        const val LENGTH_STEP_DAYS = 8L
        const val MAX_MD = 20
        const val WARMUPS = 3
        const val RUNS = 7
        const val TRIPWIRE_MS = 2_000.0
    }
}
