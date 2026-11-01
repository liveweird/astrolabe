package ch.nokillswit

import ch.nokillswit.infra.time.WorkingCalendar
import ch.nokillswit.planning.DaySpan
import ch.nokillswit.planning.IdleGap
import ch.nokillswit.planning.IdleGapView
import ch.nokillswit.planning.MIN_IDLE_GAP_DAYS
import ch.nokillswit.planning.idleGapViewsOf
import ch.nokillswit.planning.idleGaps
import java.time.LocalDate
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

/**
 * The idle-gap kernel (no server, no database), every figure counted by hand on 2027-02: 02-01 is a Monday, so Fridays are 02-05, 02-12
 * and 02-19 and the weekends 02-06/07 and 02-13/14. A gap is a maximal run of working days covered by no span, at least 3 long, inside
 * `within`; weekends and holidays neither count nor break a run. `planning-model.md` "Idle gaps".
 */
class IdleGapKernelsTest {
    private fun d(date: String) = LocalDate.parse(date)

    private fun span(start: String, end: String = start) = DaySpan(d(start), d(end))

    private fun calendar(vararg holidays: String) = WorkingCalendar(holidays.associate { d(it) to "Holiday" })

    private fun gap(start: String, end: String, days: Int) = IdleGap(d(start), d(end), days)

    /** The gaps of [spans] inside their own derived span (the shape both views use). */
    private fun gapsOf(calendar: WorkingCalendar, vararg spans: DaySpan): List<IdleGap> {
        val within = DaySpan(spans.minOf { it.start }, spans.maxOf { it.end })
        return idleGaps(spans.toList(), within, calendar)
    }

    private val monFri = WorkingCalendar.MON_FRI

    @Test
    fun `a 5-working-day hole is one gap and its dates are the first and last idle working day`() {
        // Tue 02-02..Mon 02-08 is Tue Wed Thu Fri Mon = 5 working days (the weekend between is not counted).
        assertEquals(listOf(gap("2027-02-02", "2027-02-08", 5)), gapsOf(monFri, span("2027-02-01"), span("2027-02-09")))
    }

    @Test
    fun `a hole shorter than 3 working days is no gap, 3 is`() {
        assertEquals(emptyList(), gapsOf(monFri, span("2027-02-01", "2027-02-02"), span("2027-02-05")), "Wed Thu = 2")
        assertEquals(listOf(gap("2027-02-03", "2027-02-05", 3)), gapsOf(monFri, span("2027-02-01", "2027-02-02"), span("2027-02-08")))
    }

    @Test
    fun `a weekend neither counts nor breaks a run`() {
        assertEquals(emptyList(), gapsOf(monFri, span("2027-02-01", "2027-02-04"), span("2027-02-09")), "Fri 05 + Mon 08 = 2")
        assertEquals(
            listOf(gap("2027-02-04", "2027-02-09", 4)),
            gapsOf(monFri, span("2027-02-01", "2027-02-03"), span("2027-02-10")),
            "Thu Fri Mon Tue = 4",
        )
    }

    @Test
    fun `a gap never starts or ends on a weekend`() {
        // The first span ends on a Friday and the second starts on a Monday: the gap is Mon 08..Fri 12, not Sat 06..Sun 14.
        assertEquals(listOf(gap("2027-02-08", "2027-02-12", 5)), gapsOf(monFri, span("2027-02-01", "2027-02-05"), span("2027-02-15")))
        // A span running through the weekend to Saturday leaves Mon 08 and Tue 09 before the next Wednesday: 2, no gap.
        assertEquals(emptyList(), gapsOf(monFri, span("2027-02-01", "2027-02-06"), span("2027-02-10")))
    }

    @Test
    fun `a holiday inside a hole is not counted, so it can shorten a gap away`() {
        val hole = arrayOf(span("2027-02-01"), span("2027-02-05"))
        assertEquals(listOf(gap("2027-02-02", "2027-02-04", 3)), gapsOf(monFri, *hole), "Tue Wed Thu")
        assertEquals(emptyList(), gapsOf(calendar("2027-02-03"), *hole), "Wed is a holiday: Tue Thu = 2")
    }

    @Test
    fun `a holiday at the edge of a gap moves its dates to the first and last working day`() {
        // Mon..Tue, then Fri 02-12: the hole is Wed 03, Thu 04, Fri 05, Mon 08, Tue 09, Wed 10, Thu 11 (7 working days).
        val spans = arrayOf(span("2027-02-01", "2027-02-02"), span("2027-02-12"))
        assertEquals(listOf(gap("2027-02-03", "2027-02-11", 7)), gapsOf(monFri, *spans))
        // With Wed 03 and Thu 11 holidays: Thu 04 .. Wed 10, 5 working days.
        assertEquals(listOf(gap("2027-02-04", "2027-02-10", 5)), gapsOf(calendar("2027-02-03", "2027-02-11"), *spans))
    }

    @Test
    fun `a holiday-only or weekend-only span covers nothing`() {
        // Wed 02-03 alone between Mon 01 and Mon 08 splits the hole into Tue (1) and Thu Fri (2): no gap.
        val middle = arrayOf(span("2027-02-01"), span("2027-02-03"), span("2027-02-08"))
        assertEquals(emptyList(), gapsOf(monFri, *middle))
        // Once Wed is a holiday the milestone covers no working day: Tue Thu Fri is one run of 3.
        assertEquals(listOf(gap("2027-02-02", "2027-02-05", 3)), gapsOf(calendar("2027-02-03"), *middle))
        // A weekend-only span is no work either.
        val weekend = arrayOf(span("2027-02-01"), span("2027-02-06", "2027-02-07"), span("2027-02-09"))
        assertEquals(listOf(gap("2027-02-02", "2027-02-08", 5)), gapsOf(monFri, *weekend))
    }

    @Test
    fun `overlapping, nested and back-to-back spans leave no gap, and a nested span does not pull the cursor back`() {
        val overlapping = arrayOf(span("2027-02-01", "2027-02-10"), span("2027-02-03", "2027-02-05"), span("2027-02-08", "2027-02-15"))
        assertEquals(emptyList(), gapsOf(monFri, *overlapping))
        assertEquals(emptyList(), gapsOf(monFri, span("2027-02-01", "2027-02-02"), span("2027-02-03", "2027-02-05")), "back to back")
        assertEquals(emptyList(), gapsOf(monFri, span("2027-02-01", "2027-02-05"), span("2027-02-08")), "back to back over a weekend")
        // A runs to Tue 09 and swallows B (Tue 02..Wed 03); the hole to C is Wed 10 Thu 11 Fri 12 Mon 15 = 4.
        assertEquals(
            listOf(gap("2027-02-10", "2027-02-15", 4)),
            gapsOf(monFri, span("2027-02-01", "2027-02-09"), span("2027-02-02", "2027-02-03"), span("2027-02-16")),
        )
    }

    @Test
    fun `several gaps come back in start order`() {
        assertEquals(
            listOf(gap("2027-02-02", "2027-02-04", 3), gap("2027-02-09", "2027-02-12", 4)),
            gapsOf(monFri, span("2027-02-01"), span("2027-02-05", "2027-02-08"), span("2027-02-15")),
        )
    }

    @Test
    fun `one span has no gap and no spans leave the whole window idle`() {
        assertEquals(emptyList(), gapsOf(monFri, span("2027-02-01", "2027-03-31")))
        // 02-01..02-26 is four Monday-Friday weeks.
        assertEquals(listOf(gap("2027-02-01", "2027-02-26", 20)), idleGaps(emptyList(), span("2027-02-01", "2027-02-26"), monFri))
        assertEquals(emptyList(), idleGapViewsOf(emptyList(), monFri), "the view helper derives its window from the spans: none, no gap")
    }

    @Test
    fun `the window bounds the gaps - a wider window adds leading and trailing runs, a span outside it covers nothing`() {
        val friday = listOf(span("2027-02-05"))
        val leading = idleGaps(friday, span("2027-02-01", "2027-02-05"), monFri)
        assertEquals(listOf(gap("2027-02-01", "2027-02-04", 4)), leading, "leading Mon..Thu")
        val saturdayStart = idleGaps(friday, span("2027-02-06", "2027-02-11"), monFri)
        assertEquals(listOf(gap("2027-02-08", "2027-02-11", 4)), saturdayStart, "a Saturday start")
        assertEquals(listOf(gap("2027-02-08", "2027-02-12", 5)), idleGaps(friday, span("2027-02-05", "2027-02-14"), monFri), "a Sunday end")
        assertEquals(
            listOf(gap("2027-02-01", "2027-02-05", 5)),
            idleGaps(listOf(span("2027-01-25", "2027-01-29"), span("2027-02-15")), span("2027-02-01", "2027-02-05"), monFri),
            "spans entirely outside the window",
        )
        assertEquals(emptyList(), idleGaps(friday, span("2027-02-06", "2027-02-07"), monFri), "a weekend-only window")
        assertEquals(emptyList(), idleGaps(friday, span("2027-02-03"), calendar("2027-02-03")), "a holiday-only window")
    }

    @Test
    fun `the threshold is a parameter and the default is 3`() {
        assertEquals(3, MIN_IDLE_GAP_DAYS)
        val spans = listOf(span("2027-02-01"), span("2027-02-04"))
        val within = span("2027-02-01", "2027-02-04")
        assertEquals(emptyList(), idleGaps(spans, within, monFri), "Tue Wed = 2")
        assertEquals(listOf(gap("2027-02-02", "2027-02-03", 2)), idleGaps(spans, within, monFri, minWorkingDays = 2))
    }

    @Test
    fun `the view form derives its window from the spans that hold a working day - a holiday-only milestone opens no leading gap`() {
        // A is only on Wed 02-03; B on Tue 02-09. Without the holiday the hole Thu 04..Mon 08 is inside the work: 3 working days.
        val spans = listOf(span("2027-02-03"), span("2027-02-09"))
        assertEquals(listOf(IdleGapView("2027-02-04", "2027-02-08", 3)), idleGapViewsOf(spans, monFri))
        // Wed 02-03 a holiday: A is no work, the window is B alone and nothing is idle before it.
        assertEquals(emptyList(), idleGapViewsOf(spans, calendar("2027-02-03")))
        // A weekend-only span is no work either, at either end of the schedule.
        val ends = listOf(span("2027-01-30", "2027-01-31"), span("2027-02-02"), span("2027-02-06", "2027-02-07"))
        assertEquals(emptyList(), idleGapViewsOf(ends, monFri))
        assertEquals(emptyList(), idleGapViewsOf(listOf(span("2027-02-03")), calendar("2027-02-03")), "only a holiday-only span")
    }

    @Test
    fun `the view form carries ISO dates and derives the window from the spans`() {
        val views = idleGapViewsOf(listOf(span("2027-02-01"), span("2027-02-09")), monFri)
        assertEquals(Triple("2027-02-02", "2027-02-08", 5), views.single().let { Triple(it.start, it.end, it.workingDays) })
        assertTrue(idleGapViewsOf(listOf(span("2027-02-01", "2027-02-02"), span("2027-02-03")), monFri).isEmpty())
    }
}
