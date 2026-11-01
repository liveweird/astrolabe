package ch.nokillswit

import ch.nokillswit.planning.CapacityPeriod
import ch.nokillswit.planning.DaySpan
import ch.nokillswit.planning.LoadItem
import ch.nokillswit.planning.MAX_LOAD_WEEKS
import ch.nokillswit.planning.WeekLoad
import ch.nokillswit.planning.capacityOn
import ch.nokillswit.planning.loadWindow
import ch.nokillswit.planning.periodOn
import ch.nokillswit.planning.weekCapacity
import ch.nokillswit.planning.weeklyLoad
import ch.nokillswit.planning.wipLimitOn
import ch.nokillswit.planning.wipOn
import ch.nokillswit.planning.workingDaysBetween
import java.math.BigDecimal
import java.time.LocalDate
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * The weekly load, capacity and WIP kernels (no server, no database), every figure counted by hand on the 2027 calendar: 2027-02-01
 * is a Monday, so the weeks of the cases are 02-01 and 02-08 (and 01-25 before them). `planning-model.md` "The team view" holds the
 * same tables.
 */
class LoadKernelsTest {
    private fun d(date: String) = LocalDate.parse(date)

    private fun md(value: String) = BigDecimal(value)

    private fun item(start: String, end: String, estimate: String) = LoadItem(DaySpan(d(start), d(end)), md(estimate))

    private fun period(from: String, mdPerWeek: String, wip: Int? = null) = CapacityPeriod(d(from), md(mdPerWeek), wip)

    private val firstTwoWeeks = DaySpan(d("2027-02-01"), d("2027-02-14"))

    private fun weeks(items: List<LoadItem>, periods: List<CapacityPeriod> = emptyList(), window: DaySpan = firstTwoWeeks): List<WeekLoad> =
        weeklyLoad(items, periods, window)

    // --- working days -------------------------------------------------------------------------------------------------------

    @Test
    fun `working days between - a week, a weekend, a weekend straddle, a Saturday start and an inverted span`() {
        assertEquals(5, workingDaysBetween(d("2027-02-01"), d("2027-02-05")), "Monday to Friday")
        assertEquals(0, workingDaysBetween(d("2027-02-06"), d("2027-02-07")), "Saturday to Sunday")
        assertEquals(2, workingDaysBetween(d("2027-02-05"), d("2027-02-08")), "Friday to Monday")
        assertEquals(1, workingDaysBetween(d("2027-02-06"), d("2027-02-08")), "a Saturday start counts from the Monday")
        assertEquals(1, workingDaysBetween(d("2027-02-08"), d("2027-02-08")), "one Monday")
        assertEquals(5, workingDaysBetween(d("2027-02-03"), d("2027-02-09")), "Wednesday to the next Tuesday")
        assertEquals(0, workingDaysBetween(d("2027-02-09"), d("2027-02-08")), "inverted")
    }

    // --- the spread ---------------------------------------------------------------------------------------------------------

    @Test
    fun `an estimate is spread evenly over its working days and a weekend costs nothing`() {
        // One week.
        assertEquals(listOf(md("10.00"), md("0.00")), weeks(listOf(item("2027-02-01", "2027-02-05", "10"))).map { it.load })
        // Straddling two weeks: Wednesday to the next Tuesday is 5 working days, 3 in the first week and 2 in the second.
        assertEquals(listOf(md("6.00"), md("4.00")), weeks(listOf(item("2027-02-03", "2027-02-09", "10"))).map { it.load })
        // A weekend inside: Friday to Monday, 2 working days.
        assertEquals(listOf(md("5.00"), md("5.00")), weeks(listOf(item("2027-02-05", "2027-02-08", "10"))).map { it.load })
        // Three weeks: Friday, a whole week and the Monday after (7 working days; 10/7 = 1.428571 a day).
        val three = weeks(listOf(item("2027-02-05", "2027-02-15", "10")), window = DaySpan(d("2027-02-01"), d("2027-02-21")))
        assertEquals(listOf(md("1.43"), md("7.14"), md("1.43")), three.map { it.load })
        // 10 over 3 working days (Friday, Monday, Tuesday): 3.333333 a day, rounded once per week figure.
        assertEquals(listOf(md("3.33"), md("6.67")), weeks(listOf(item("2027-02-05", "2027-02-09", "10"))).map { it.load })
        // Estimate 0, and a span with no working day at all.
        assertEquals(listOf(md("0.00"), md("0.00")), weeks(listOf(item("2027-02-01", "2027-02-05", "0"))).map { it.load })
        assertEquals(listOf(md("0.00"), md("0.00")), weeks(listOf(item("2027-02-06", "2027-02-07", "10"))).map { it.load })
    }

    @Test
    fun `two milestones in the same week are summed before the single rounding`() {
        // 1/3 + 1/3 a day over Mon-Wed would round to 0.33 twice if each were rounded; summed at scale 6 first the week reads 2.00.
        val rows = weeks(listOf(item("2027-02-01", "2027-02-03", "1"), item("2027-02-01", "2027-02-03", "1")))
        assertEquals(md("2.00"), rows[0].load)
        assertEquals(md("0.00"), rows[1].load)
    }

    @Test
    fun `the load is exact until its one rounding, so a true half rounds up`() {
        // 7.25 MD over Wed 02-03 .. Wed 02-10 (6 working days, 3 in each week): 3.625 a week. Dividing first (1.208333 a day) gave 3.62.
        assertEquals(listOf(md("3.63"), md("3.63")), weeks(listOf(item("2027-02-03", "2027-02-10", "7.25"))).map { it.load })
        // Three 0.01 MD milestones over Fri-Tue (1 working day of 3 in week 1) and one over Fri-Mon (1 of 2): 0.01 + 0.005 = 0.015.
        val mixed = listOf(
            item("2027-02-05", "2027-02-09", "0.01"), item("2027-02-05", "2027-02-09", "0.01"), item("2027-02-05", "2027-02-09", "0.01"),
            item("2027-02-05", "2027-02-08", "0.01"),
        )
        assertEquals(listOf(md("0.02"), md("0.03")), weeks(mixed).map { it.load }, "0.015 and 0.025, rounded half up once")
        // A per-milestone rounding would give 0.01 + 0.01 = 0.02 here: the SUM 0.005 + 0.005 = 0.01 is rounded, not each share.
        val pair = weeks(listOf(item("2027-02-05", "2027-02-08", "0.01"), item("2027-02-05", "2027-02-08", "0.01")))
        assertEquals(listOf(md("0.01"), md("0.01")), pair.map { it.load })
        // HALF_EVEN would give 0.00 for a lone 0.005.
        assertEquals(md("0.01"), weeks(listOf(item("2027-02-05", "2027-02-08", "0.01")))[0].load)
    }

    @Test
    fun `a one-day milestone loads its whole estimate into its week`() {
        val rows = weeks(listOf(item("2027-02-03", "2027-02-03", "3")))
        assertEquals(listOf(md("3.00"), md("0.00")), rows.map { it.load })
        assertEquals(1, wipOn(d("2027-02-03"), listOf(item("2027-02-03", "2027-02-03", "3"))))
    }

    @Test
    fun `a week across the year boundary is one ISO week keyed by its Monday`() {
        // 2026-12-28 is a Monday; the week runs to Sunday 2027-01-03 and the next starts 2027-01-04.
        val window = loadWindow(listOf(DaySpan(d("2026-12-30"), d("2027-01-05"))))!!
        assertEquals(DaySpan(d("2026-12-28"), d("2027-01-10")), window.span)
        val rows = weeklyLoad(
            listOf(item("2026-12-31", "2027-01-04", "4"), item("2026-12-28", "2027-01-03", "10")),
            listOf(period("2026-12-28", "10")),
            window.span,
        )
        assertEquals(listOf(d("2026-12-28"), d("2027-01-04")), rows.map { it.weekStart })
        // Thu 12-31 + Fri 01-01 + Mon 01-04 = 3 days of 4 MD: 2.67 into the first week, 1.33 into the second.
        assertEquals(listOf(md("12.67"), md("1.33")), rows.map { it.load })
        assertEquals(listOf(md("10.00"), md("10.00")), rows.map { it.capacity })
        assertTrue(rows[0].overloaded)
        assertEquals(md("2.67"), rows[0].overloadMd)
    }

    // --- the window ---------------------------------------------------------------------------------------------------------

    @Test
    fun `the window runs from the earliest start's Monday to the latest end's Sunday and is capped`() {
        assertNull(loadWindow(emptyList()), "nothing scheduled")
        val one = loadWindow(listOf(DaySpan(d("2027-02-03"), d("2027-02-04"))))!!
        assertEquals(DaySpan(d("2027-02-01"), d("2027-02-07")), one.span, "one week")
        assertFalse(one.truncated)
        val two = loadWindow(listOf(DaySpan(d("2027-02-03"), d("2027-02-04")), DaySpan(d("2027-02-08"), d("2027-02-09"))))!!
        assertEquals(DaySpan(d("2027-02-01"), d("2027-02-14")), two.span)
        assertEquals(2, weeks(emptyList(), window = two.span).size)

        val exactly = loadWindow(listOf(DaySpan(d("2027-02-01"), d("2027-02-01").plusWeeks(MAX_LOAD_WEEKS.toLong()).minusDays(1))))!!
        assertFalse(exactly.truncated, "520 weeks fit")
        val over = loadWindow(listOf(DaySpan(d("2027-02-01"), d("2027-02-01").plusWeeks(MAX_LOAD_WEEKS.toLong()))))!!
        assertTrue(over.truncated, "521 weeks do not")
        assertEquals(d("2027-02-01").plusWeeks(MAX_LOAD_WEEKS.toLong()).minusDays(1), over.span.end, "cut at 520 weeks from the start")
        assertEquals(MAX_LOAD_WEEKS, weeklyLoad(emptyList(), emptyList(), over.span).size)
        assertTrue(weeklyLoad(emptyList(), emptyList(), null).isEmpty())
    }

    // --- capacity -----------------------------------------------------------------------------------------------------------

    private fun capacityOfWeeks(vararg periods: CapacityPeriod): List<BigDecimal?> =
        listOf("2027-01-25", "2027-02-01", "2027-02-08").map { weekCapacity(d(it), periods.toList()) }

    @Test
    fun `a capacity change in the middle of a week is prorated by working days`() {
        // 3 x 10/5 + 2 x 20/5 = 14
        assertEquals(listOf(null, md("14.00"), md("20.00")), capacityOfWeeks(period("2027-02-01", "10"), period("2027-02-04", "20")))
    }

    @Test
    fun `a Monday boundary needs no proration`() {
        assertEquals(listOf(null, md("10.00"), md("20.00")), capacityOfWeeks(period("2027-02-01", "10"), period("2027-02-08", "20")))
    }

    @Test
    fun `a weekend boundary counts from the Monday after`() {
        assertEquals(listOf(null, md("10.00"), md("20.00")), capacityOfWeeks(period("2027-02-01", "10"), period("2027-02-06", "20")))
    }

    @Test
    fun `several changes in one week add up per day`() {
        // Mon 2 + Tue 4 + Wed 4 + Thu 1 + Fri 1
        val periods = arrayOf(period("2027-02-01", "10"), period("2027-02-02", "20"), period("2027-02-04", "5"))
        assertEquals(listOf(null, md("12.00"), md("5.00")), capacityOfWeeks(*periods))
    }

    @Test
    fun `a first period in the middle of a week covers only its own days and the week before has no capacity`() {
        // Wed, Thu, Fri at 10/5 = 6; the week of 01-25 is not covered at all
        assertEquals(listOf(null, md("6.00"), md("10.00")), capacityOfWeeks(period("2027-02-03", "10")))
    }

    @Test
    fun `a first period on a weekend leaves its own week without capacity`() {
        assertEquals(listOf(null, null, md("20.00")), capacityOfWeeks(period("2027-02-06", "20")))
    }

    @Test
    fun `the week's capacity rounds half up to two decimals`() {
        // 3 x 0.266 = 0.798 -> 0.80; then 0 from Thursday
        assertEquals(listOf(null, md("0.80"), md("0.00")), capacityOfWeeks(period("2027-02-01", "1.33"), period("2027-02-04", "0")))
    }

    @Test
    fun `the week's capacity rounds half up, not up - a Thursday start of 131 cents a week is 52 cents`() {
        // Thursday and Friday at 1.31/5 = 0.262: 0.524 -> 0.52 (UP or CEILING would say 0.53); nothing before the period.
        assertEquals(listOf(null, md("0.52"), md("1.31")), capacityOfWeeks(period("2027-02-04", "1.31")))
    }

    @Test
    fun `a period in the past covers every later week`() {
        assertEquals(listOf(md("10.00"), md("10.00"), md("10.00")), capacityOfWeeks(period("2020-01-06", "10")))
    }

    @Test
    fun `the period and the figures in force on a day are the latest one starting on or before it`() {
        val periods = listOf(period("2027-02-01", "10", wip = 2), period("2027-02-04", "20"))
        assertNull(periodOn(d("2027-01-31"), periods))
        assertNull(capacityOn(d("2027-01-31"), periods))
        assertEquals(md("10"), capacityOn(d("2027-02-03"), periods))
        assertEquals(md("20"), capacityOn(d("2027-02-04"), periods), "a period applies on its own first day")
        assertEquals(2, wipLimitOn(d("2027-02-03"), periods))
        assertNull(wipLimitOn(d("2027-02-04"), periods), "a period without a limit lifts the earlier one")
        assertNull(wipLimitOn(d("2027-01-31"), periods))
    }

    // --- overload -----------------------------------------------------------------------------------------------------------

    @Test
    fun `overload compares the rounded figures - equal is fine, one cent over is flagged, capacity zero flags, no capacity never does`() {
        val periods = listOf(period("2027-02-01", "1.33"), period("2027-02-04", "0")) // the week's capacity is 0.80
        val equal = weeks(listOf(item("2027-02-01", "2027-02-05", "0.80")), periods)[0]
        assertEquals(md("0.80"), equal.load)
        assertEquals(md("0.80"), equal.capacity)
        assertFalse(equal.overloaded)
        assertNull(equal.overloadMd)

        val over = weeks(listOf(item("2027-02-01", "2027-02-05", "0.81")), periods)[0]
        assertTrue(over.overloaded)
        assertEquals(md("0.01"), over.overloadMd)

        val onHold = weeks(listOf(item("2027-02-01", "2027-02-05", "1")), listOf(period("2027-02-01", "0")))[0]
        assertEquals(md("0.00"), onHold.capacity)
        assertTrue(onHold.overloaded)
        assertEquals(md("1.00"), onHold.overloadMd)

        val none = weeks(listOf(item("2027-02-01", "2027-02-05", "10")))[0]
        assertNull(none.capacity)
        assertFalse(none.overloaded, "no capacity is never flagged")
        assertNull(none.overloadMd)
    }

    // --- WIP ----------------------------------------------------------------------------------------------------------------

    // Daily WIP, week of 02-01: Mon 1, Tue 1, Wed 2, Thu 3, Fri 2; week of 02-08: Mon-Wed 1, Thu-Fri 0.
    private val a = item("2027-02-01", "2027-02-05", "5")
    private val b = item("2027-02-03", "2027-02-10", "5")
    private val c = item("2027-02-04", "2027-02-04", "1")
    private val base = listOf(a, b, c)

    private fun wip(rows: List<WeekLoad>) = rows.map { it.maxWip to it.wipExceeded }

    @Test
    fun `the WIP of a day counts the items whose effective span covers it`() {
        val daily = listOf("02-01", "02-02", "02-03", "02-04", "02-05", "02-08", "02-09", "02-10", "02-11", "02-12")
            .map { wipOn(d("2027-$it"), base) }
        assertEquals(listOf(1, 1, 2, 3, 2, 1, 1, 1, 0, 0), daily)
    }

    @Test
    fun `a flat limit flags the week whose peak day exceeds it`() {
        assertEquals(listOf(3 to true, 1 to false), wip(weeks(base, listOf(period("2027-02-01", "10", wip = 2)))))
    }

    @Test
    fun `a limit raised in the middle of the week is judged per day - Thursday's 3 is within the new 3`() {
        val raised = listOf(period("2027-02-01", "10", wip = 2), period("2027-02-04", "10", wip = 3))
        assertEquals(listOf(3 to false, 1 to false), wip(weeks(base, raised)))
    }

    @Test
    fun `a limit lowered in the middle of the week is exceeded on Thursday`() {
        val lowered = listOf(period("2027-02-01", "10", wip = 3), period("2027-02-04", "10", wip = 2))
        assertEquals(listOf(3 to true, 1 to false), wip(weeks(base, lowered)))
    }

    @Test
    fun `a first period on a weekend has no limit before it, and its limit judges the next week`() {
        val weekendLimit = listOf(period("2027-02-06", "10", wip = 1))
        assertEquals(listOf(3 to false, 1 to false), wip(weeks(base, weekendLimit)), "no limit on any day of the first week")
        val withD = base + item("2027-02-08", "2027-02-09", "2")
        assertEquals(listOf(3 to false, 2 to true), wip(weeks(withD, weekendLimit)), "Monday 2 > 1")
    }

    @Test
    fun `a period without a limit never warns but the peak is still reported`() {
        assertEquals(listOf(3 to false, 1 to false), wip(weeks(base, listOf(period("2027-02-01", "10", wip = null)))))
    }

    @Test
    fun `an item dated Saturday to the next Sunday counts only on its working days of the next week`() {
        val withE = base + item("2027-02-06", "2027-02-14", "5") // effective Monday 02-08 to Friday 02-12
        val limit1 = listOf(period("2027-02-01", "10", wip = 1))
        assertEquals(wip(weeks(base, limit1))[0], wip(weeks(withE, limit1))[0], "E counts on no day of the earlier week")
        assertEquals(2 to true, wip(weeks(withE, limit1))[1], "Monday: B and E")
        assertEquals(1, wipOn(d("2027-02-11"), withE), "Thursday: E alone")
        assertEquals(2, wipOn(d("2027-02-05"), withE), "the Friday before: A and B, E has not started")
    }

    @Test
    fun `an item dated Friday to Saturday counts on that Friday only`() {
        val withF = base + item("2027-02-05", "2027-02-06", "1")
        assertEquals(3, wipOn(d("2027-02-05"), withF), "Friday: A, B and F")
        assertEquals(2, wipOn(d("2027-02-05"), base))
        assertEquals(1, wipOn(d("2027-02-08"), withF), "F is gone on Monday")
        assertEquals(listOf(3 to true, 1 to false), wip(weeks(withF, listOf(period("2027-02-01", "10", wip = 2)))))
    }

    @Test
    fun `nothing scheduled has no peak and no warning`() {
        assertEquals(listOf(0 to false, 0 to false), wip(weeks(emptyList(), listOf(period("2027-02-01", "10", wip = 1)))))
    }
}
