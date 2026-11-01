package ch.nokillswit

import ch.nokillswit.infra.time.WorkingCalendar
import ch.nokillswit.planning.DaySpan
import ch.nokillswit.planning.DependencyCheck
import ch.nokillswit.planning.DependencyKernels
import ch.nokillswit.planning.DependencyStatus
import ch.nokillswit.planning.DependencyType
import java.time.LocalDate
import kotlin.test.Test
import kotlin.test.assertEquals

/**
 * The pure dependency check (no server, no database): table-driven, every figure counted by hand on the 2027 calendar.
 * 2027-02-01 is a Monday, so the reference predecessor `A` = 02-01..02-05 is a whole working week; 01-25 and 02-08 are the Mondays
 * before and after it, and 01-29 / 02-12 the Fridays. 2027-02-06 is a Saturday, 02-07 a Sunday.
 */
class DependencyKernelsTest {
    private fun span(start: String, end: String) = DaySpan(LocalDate.parse(start), LocalDate.parse(end))

    private val weekA = span("2027-02-01", "2027-02-05")

    private class Case(
        val label: String,
        val type: DependencyType,
        val lag: Int,
        val predecessor: DaySpan?,
        val successor: DaySpan?,
        val status: DependencyStatus,
        val shortfall: Int?,
        val required: String?,
        val actual: String?,
    )

    private fun ok(label: String, type: DependencyType, lag: Int, pred: DaySpan, succ: DaySpan, required: String, actual: String) =
        Case(label, type, lag, pred, succ, DependencyStatus.OK, null, required, actual)

    private fun violated(
        label: String,
        type: DependencyType,
        lag: Int,
        pred: DaySpan,
        succ: DaySpan,
        shortfall: Int,
        required: String,
        actual: String,
    ) = Case(label, type, lag, pred, succ, DependencyStatus.VIOLATED, shortfall, required, actual)

    private val fs = DependencyType.FS
    private val ss = DependencyType.SS
    private val ff = DependencyType.FF
    private val sf = DependencyType.SF

    private val cases = listOf(
        // Finish-to-start: the successor starts the working day after the predecessor's end, plus the lag.
        ok("FS: Friday end, Monday start", fs, 0, weekA, span("2027-02-08", "2027-02-12"), "2027-02-08", "2027-02-08"),
        violated("FS: starts on the predecessor's last day", fs, 0, weekA, span("2027-02-05", "2027-02-12"), 1, "2027-02-08", "2027-02-05"),
        ok("FS: a Saturday-dated start is the Monday", fs, 0, weekA, span("2027-02-06", "2027-02-12"), "2027-02-08", "2027-02-08"),
        ok("FS: a Sunday-dated start is the Monday", fs, 0, weekA, span("2027-02-07", "2027-02-12"), "2027-02-08", "2027-02-08"),
        ok(
            "FS: a Saturday-dated end is the Friday",
            fs,
            0,
            span("2027-02-01", "2027-02-06"),
            span("2027-02-08", "2027-02-12"),
            "2027-02-08",
            "2027-02-08",
        ),
        violated("FS: a positive lag, 2 days short", fs, 2, weekA, span("2027-02-08", "2027-02-12"), 2, "2027-02-10", "2027-02-08"),
        ok("FS: a positive lag, met", fs, 2, weekA, span("2027-02-10", "2027-02-12"), "2027-02-10", "2027-02-10"),
        ok(
            "FS: a lead lets the successor start before the end",
            fs,
            -2,
            weekA,
            span("2027-02-04", "2027-02-12"),
            "2027-02-04",
            "2027-02-04",
        ),
        violated("FS: a lead, 1 day short", fs, -2, weekA, span("2027-02-03", "2027-02-12"), 1, "2027-02-04", "2027-02-03"),
        violated("FS: two whole working weeks early", fs, 0, weekA, span("2027-01-25", "2027-01-29"), 10, "2027-02-08", "2027-01-25"),
        violated(
            "FS: across the year boundary",
            fs,
            1,
            span("2027-12-27", "2027-12-31"),
            span("2028-01-03", "2028-01-07"),
            1,
            "2028-01-04",
            "2028-01-03",
        ),
        ok(
            "FS: a multi-week (project) span",
            fs,
            0,
            span("2027-02-01", "2027-02-26"),
            span("2027-03-01", "2027-03-05"),
            "2027-03-01",
            "2027-03-01",
        ),
        // Start-to-start: the successor starts no earlier than the predecessor's start, plus the lag.
        ok("SS: the same start", ss, 0, weekA, span("2027-02-01", "2027-02-12"), "2027-02-01", "2027-02-01"),
        violated("SS: starts the Friday before", ss, 0, weekA, span("2027-01-29", "2027-02-12"), 1, "2027-02-01", "2027-01-29"),
        violated("SS: a positive lag, 1 day short", ss, 3, weekA, span("2027-02-03", "2027-02-12"), 1, "2027-02-04", "2027-02-03"),
        ok(
            "SS: a Saturday-dated predecessor start is the Monday",
            ss,
            0,
            span("2027-01-30", "2027-02-05"),
            span("2027-02-01", "2027-02-05"),
            "2027-02-01",
            "2027-02-01",
        ),
        ok("SS: a lead of one day", ss, -1, weekA, span("2027-01-29", "2027-02-05"), "2027-01-29", "2027-01-29"),
        // Finish-to-finish: the successor ends no earlier than the predecessor's end, plus the lag.
        ok("FF: the same end", ff, 0, weekA, span("2027-02-02", "2027-02-05"), "2027-02-05", "2027-02-05"),
        violated("FF: ends the day before", ff, 0, weekA, span("2027-02-02", "2027-02-04"), 1, "2027-02-05", "2027-02-04"),
        ok("FF: a Saturday-dated end is the Friday", ff, 0, weekA, span("2027-02-02", "2027-02-06"), "2027-02-05", "2027-02-05"),
        ok("FF: a lead of one day", ff, -1, weekA, span("2027-02-02", "2027-02-04"), "2027-02-04", "2027-02-04"),
        violated("FF: a lag of a week", ff, 5, weekA, span("2027-02-02", "2027-02-05"), 5, "2027-02-12", "2027-02-05"),
        // Start-to-finish: the successor ends no earlier than the working day before the predecessor's start, plus the lag
        // (the mirror of FS).
        ok("SF: ends the day the predecessor starts", sf, 0, weekA, span("2027-01-25", "2027-02-01"), "2027-01-29", "2027-02-01"),
        ok("SF: ends the Friday before", sf, 0, weekA, span("2027-01-25", "2027-01-29"), "2027-01-29", "2027-01-29"),
        violated("SF: ends the Thursday before", sf, 0, weekA, span("2027-01-25", "2027-01-28"), 1, "2027-01-29", "2027-01-28"),
        ok("SF: a lag of a week, met", sf, 5, weekA, span("2027-02-01", "2027-02-05"), "2027-02-05", "2027-02-05"),
        violated("SF: a lag of a week, 1 day short", sf, 5, weekA, span("2027-02-01", "2027-02-04"), 1, "2027-02-05", "2027-02-04"),
        ok("SF: a Sunday-dated end is the Friday", sf, 0, weekA, span("2027-01-25", "2027-01-31"), "2027-01-29", "2027-01-29"),
        ok("SF: a lead of one day, met", sf, -1, weekA, span("2027-01-25", "2027-01-28"), "2027-01-28", "2027-01-28"),
        violated("SF: a lead of one day, 1 day short", sf, -1, weekA, span("2027-01-25", "2027-01-27"), 1, "2027-01-28", "2027-01-27"),
        // An end without dates is not evaluated: no warning, no dates, whichever end and whichever type.
        *DependencyType.entries.flatMap { type ->
            listOf(
                Case("$type: predecessor unscheduled", type, 0, null, weekA, DependencyStatus.UNSCHEDULED, null, null, null),
                Case("$type: successor unscheduled", type, 3, weekA, null, DependencyStatus.UNSCHEDULED, null, null, null),
                Case("$type: both unscheduled", type, -1, null, null, DependencyStatus.UNSCHEDULED, null, null, null),
            )
        }.toTypedArray(),
    )

    @Test
    fun `the check per type, lag, weekend and calendar edge`() {
        for (case in cases) {
            val expected = DependencyCheck(case.status, case.shortfall, case.required, case.actual)
            val actual = DependencyKernels.check(case.type, case.lag, case.predecessor, case.successor, WorkingCalendar.MON_FRI)
            assertEquals(expected, actual, case.label)
        }
    }

    @Test
    fun `FS and SF are mirrors - a Friday end then a Monday start, and a Friday end before a Monday start`() {
        val fsCheck = DependencyKernels.check(fs, 0, weekA, span("2027-02-08", "2027-02-12"), WorkingCalendar.MON_FRI)
        val sfCheck = DependencyKernels.check(sf, 0, span("2027-02-08", "2027-02-12"), weekA, WorkingCalendar.MON_FRI)
        assertEquals(DependencyStatus.OK, fsCheck.status)
        assertEquals(DependencyStatus.OK, sfCheck.status)
        assertEquals("2027-02-08" to "2027-02-08", fsCheck.requiredDate to fsCheck.actualDate)
        assertEquals("2027-02-05" to "2027-02-05", sfCheck.requiredDate to sfCheck.actualDate)
    }

    @Test
    fun `a satisfied link has no shortfall and a violated one at least 1`() {
        for (case in cases.filter { it.predecessor != null && it.successor != null }) {
            val check = DependencyKernels.check(case.type, case.lag, case.predecessor, case.successor, WorkingCalendar.MON_FRI)
            when (check.status) {
                DependencyStatus.OK -> assertEquals(null, check.shortfallDays, case.label)
                DependencyStatus.VIOLATED -> assertEquals(true, (check.shortfallDays ?: 0) >= 1, case.label)
                DependencyStatus.UNSCHEDULED -> error("${case.label}: both ends are scheduled")
            }
        }
    }

    @Test
    fun `a holiday is not a working day - a lag of one working day is pushed past it`() {
        // 2027-01-06 (a Wednesday) is a holiday. FS with lag 1 after Mon 01-04..Tue 01-05 needs the second working day after the end:
        // Mon-Fri that is Thu 01-07; with the holiday it is Fri 01-08.
        val holiday = WorkingCalendar(mapOf(LocalDate.parse("2027-01-06") to "Epiphany"))
        val predecessor = span("2027-01-04", "2027-01-05")
        val successor = span("2027-01-07", "2027-01-08")
        val plain = DependencyKernels.check(fs, 1, predecessor, successor, WorkingCalendar.MON_FRI)
        assertEquals(DependencyCheck(DependencyStatus.OK, null, "2027-01-07", "2027-01-07"), plain)
        val withHoliday = DependencyKernels.check(fs, 1, predecessor, successor, holiday)
        assertEquals(DependencyCheck(DependencyStatus.VIOLATED, 1, "2027-01-08", "2027-01-07"), withHoliday)
        // A successor starting ON the holiday starts on the next working day.
        val onHoliday = DependencyKernels.check(fs, 0, predecessor, span("2027-01-06", "2027-01-08"), holiday)
        assertEquals(DependencyCheck(DependencyStatus.OK, null, "2027-01-07", "2027-01-07"), onHoliday)
    }
}
