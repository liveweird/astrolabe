package ch.nokillswit

import ch.nokillswit.flow.CapacityAction
import ch.nokillswit.flow.CapacityDeviation
import ch.nokillswit.flow.CapacityDeviationDetail
import ch.nokillswit.flow.CapacityDeviationKernels
import ch.nokillswit.flow.CapacityDeviationKind
import ch.nokillswit.flow.CapacityImportKernels
import ch.nokillswit.flow.CapacityInfoCode
import ch.nokillswit.flow.CapacityPlan
import ch.nokillswit.flow.CapacitySkipReason
import ch.nokillswit.flow.FlowMirrorSprint
import ch.nokillswit.infra.time.WorkingCalendar
import ch.nokillswit.planning.DeviationSeverity
import ch.nokillswit.teams.CapacityPeriodRow
import ch.nokillswit.teams.CapacitySource
import java.math.BigDecimal
import java.time.LocalDate
import java.time.LocalDateTime
import java.time.ZoneId
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNotEquals
import kotlin.test.assertTrue

/**
 * The capacity deviation kernel (`CapacityDeviationKernels.deviations`) over the import's own plan, pure: every vector is counted by hand.
 * Calendar facts used below: 2047-01-07 is a Monday (the stub's "E2E Flow Team" starts there), so a Monday-to-second-Friday sprint has 10
 * working days (01-07..01-18, then 01-21..02-01, 02-04..02-15, 02-18..03-01, 03-04..03-15, 03-18..03-29), 2047-01-10 is a Thursday and
 * 01-12 a Saturday. `mdPerWeek = round2(5 x flowMd / workingDays)`; a day's capacity is `mdPerWeek / 5`, so a sprint of 10 working days at
 * a figure of m a week carries 2 m; `flowMd` of a row = `round2(mdPerWeek x workingDays / 5)`; `planMd` = the team view's sum of
 * `figure / 5` (scale 6) over the held working days, rounded once to two decimals. A deviation row is printed `id KIND SEVERITY
 * flow= total= plan= gap=` with `gap = plan - flow`.
 */
class CapacityDeviationKernelsTest {
    private companion object {
        val WARSAW: ZoneId = ZoneId.of("Europe/Warsaw")
        val TODAY: LocalDate = LocalDate.of(2046, 12, 1)
        val HOLIDAY_JAN_10 = WorkingCalendar(mapOf(LocalDate.of(2047, 1, 10) to "Holiday"))
    }

    private fun at(date: String, time: String = "09:00"): Long =
        LocalDateTime.parse("${date}T$time").atZone(WARSAW).toInstant().toEpochMilli()

    /** A Monday-09:00 .. Friday-17:00 style sprint (Warsaw) of the given source. */
    private fun sprint(
        id: Long,
        from: String,
        to: String,
        md: String?,
        source: String = "CALENDAR",
        name: String = "Sprint $id",
    ) = FlowMirrorSprint(id, 1, name, "future", at(from), at(to, "17:00"), null, true, md?.let(::BigDecimal), source)

    /** The stub's "E2E Flow Team": six sprints of 10 working days, 40 / 36 / 44 / 40 / 38 / 42 man-days (20 .. 21 a week). */
    private fun e2e(): List<FlowMirrorSprint> = listOf(
        Triple("2047-01-07", "2047-01-18", "40"),
        Triple("2047-01-21", "2047-02-01", "36"),
        Triple("2047-02-04", "2047-02-15", "44"),
        Triple("2047-02-18", "2047-03-01", "40"),
        Triple("2047-03-04", "2047-03-15", "38"),
        Triple("2047-03-18", "2047-03-29", "42"),
    ).mapIndexed { i, (from, to, md) -> sprint(90_001L + i, from, to, md, name = "E2E Flow Sprint ${i + 1}") }

    private fun period(id: Int, from: String, md: String, source: CapacitySource = CapacitySource.MANUAL, sprint: Long? = null) =
        CapacityPeriodRow(id.toUInt(), LocalDate.parse(from), BigDecimal(md), null, source, sprint, sprint?.let { "Sprint $it" })

    private fun planOf(
        sprints: List<FlowMirrorSprint>,
        periods: List<CapacityPeriodRow>,
        calendar: WorkingCalendar,
        today: LocalDate = TODAY,
    ): CapacityPlan = CapacityImportKernels.plan(sprints, WARSAW, calendar, today, periods, from = null, includeClosed = false)

    private fun deviations(
        sprints: List<FlowMirrorSprint>,
        periods: List<CapacityPeriodRow> = emptyList(),
        calendar: WorkingCalendar = WorkingCalendar.MON_FRI,
        today: LocalDate = TODAY,
    ): List<CapacityDeviation> =
        CapacityDeviationKernels.deviations(planOf(sprints, periods, calendar, today), periods, calendar, gone = false)

    private fun CapacityDeviation.row(): String =
        "${detail.sprintId} $kind $severity flow=${detail.flowMd} total=${detail.flowTotalMd} plan=${detail.planMd} gap=${detail.gapMd}"

    private fun rows(
        sprints: List<FlowMirrorSprint>,
        periods: List<CapacityPeriodRow> = emptyList(),
        calendar: WorkingCalendar = WorkingCalendar.MON_FRI,
        today: LocalDate = TODAY,
    ): List<String> = deviations(sprints, periods, calendar, today).map { it.row() }

    private fun missing(id: Long, flow: String) = "$id CAPACITY_MISSING INFO flow=$flow total=$flow plan=null gap=null"

    /** The periods a clean import writes: one FLOW period per planned row at its `effectiveFrom`. */
    private fun imported(sprints: List<FlowMirrorSprint>, calendar: WorkingCalendar): List<CapacityPeriodRow> =
        planOf(sprints, emptyList(), calendar).items.mapIndexed { i, item ->
            CapacityPeriodRow(
                (i + 1).toUInt(), LocalDate.parse(item.effectiveFrom), BigDecimal.valueOf(checkNotNull(item.mdPerWeek)), null,
                CapacitySource.FLOW, item.sprintId, item.name,
            )
        }

    @Test
    fun `a clean import leaves nothing - plain, and with a holiday inside the first sprint`() {
        // Plain: every sprint holds 10 working days; the import writes 20 / 18 / 22 / 20 / 19 / 21, the plan then carries 2 x that = flow.
        val plain = imported(e2e(), WorkingCalendar.MON_FRI)
        assertEquals(listOf("20.0", "18.0", "22.0", "20.0", "19.0", "21.0"), plain.map { it.mdPerWeek.toString() })
        assertEquals(emptyList(), rows(e2e(), plain))

        // Holiday 01-10 (a Thursday) in sprint 1: W 9, mdPerWeek round2(5 x 40 / 9) = 22.22; flowMd 22.22 x 9 / 5 = 39.996 -> 40.00 and the
        // plan 9 x (22.22 / 5 = 4.444) = 39.996 -> 40.00: no gap. Both sides read one calendar, so a holiday raises nothing by itself.
        val withHoliday = imported(e2e(), HOLIDAY_JAN_10)
        assertEquals(BigDecimal("22.22"), withHoliday.first().mdPerWeek)
        assertEquals(emptyList(), rows(e2e(), withHoliday, HOLIDAY_JAN_10))
    }

    @Test
    fun `a manual 20 a week against the E2E figures - gaps 0, +4 W, -4 I, 0, +2 W, -2 I`() {
        // One manual period from 01-07 stays in force over the six sprints: 10 working days x 20 / 5 = 40.00 each, against flow 40 / 36 /
        // 44 / 40 / 38 / 42. Gap = 40 - flow: 0, +4 (plan has more: WARNING), -4 (less: INFO), 0, +2 W, -2 I. Sprints 1 and 4 are silent.
        val periods = listOf(period(1, "2047-01-07", "20.00"))
        assertEquals(
            listOf(
                "90002 CAPACITY_DIFFERS WARNING flow=36.0 total=36.0 plan=40.0 gap=4.0",
                "90003 CAPACITY_DIFFERS INFO flow=44.0 total=44.0 plan=40.0 gap=-4.0",
                "90005 CAPACITY_DIFFERS WARNING flow=38.0 total=38.0 plan=40.0 gap=2.0",
                "90006 CAPACITY_DIFFERS INFO flow=42.0 total=42.0 plan=40.0 gap=-2.0",
            ),
            rows(e2e(), periods),
        )
        // The whole detail of one row: the sprint, its dates (the connection's zone), the days it holds, the figures.
        assertEquals(
            CapacityDeviationDetail(90_002L, "E2E Flow Sprint 2", "2047-01-21", "2047-02-01", "2047-01-21", 10, 36.0, 36.0, 40.0, 4.0),
            deviations(e2e(), periods).first().detail,
        )
    }

    private class ThresholdCase(val label: String, val md: String, val periods: List<CapacityPeriodRow>, val expected: List<String>)

    @Test
    fun `the threshold is 0 50 on the rounded two-decimal figures - 0 49 is silent, 0 50 deviates, on both sides`() {
        val cases = listOf(
            // Sprint 90001 is 01-07..01-18 (10 working days), flow 40 (mdPerWeek 20.00, flowMd 40.00) unless a case says otherwise.
            // 22.47 on Monday 01-07 + 20.00 from Tuesday: 22.47 / 5 = 4.494, nine days x 4.000 = 36 -> 40.494 -> 40.49; gap 0.49: silent.
            ThresholdCase(
                "plan 40.494", "40", listOf(period(1, "2047-01-07", "22.47"), period(2, "2047-01-08", "20.00")), emptyList(),
            ),
            // 22.48 / 5 = 4.496 + 36 = 40.496 -> 40.50 (the sum is rounded ONCE; 0.496 unrounded would be silent); gap 0.50: WARNING.
            ThresholdCase(
                "plan 40.496", "40", listOf(period(1, "2047-01-07", "22.48"), period(2, "2047-01-08", "20.00")),
                listOf("90001 CAPACITY_DIFFERS WARNING flow=40.0 total=40.0 plan=40.5 gap=0.5"),
            ),
            // 19.76 a week: 10 x 3.952 = 39.52, gap -0.48: silent. 19.75: 10 x 3.95 = 39.50, gap -0.50: INFO (the bound is inclusive).
            ThresholdCase("plan 39.52", "40", listOf(period(1, "2047-01-07", "19.76")), emptyList()),
            ThresholdCase(
                "plan 39.50", "40", listOf(period(1, "2047-01-07", "19.75")),
                listOf("90001 CAPACITY_DIFFERS INFO flow=40.0 total=40.0 plan=39.5 gap=-0.5"),
            ),
            // The flow side is the IMPORT's rounded figure: 40.48 -> 5 x 40.48 / 10 = 20.24 exactly -> flowMd 20.24 x 10 / 5 = 40.48, gap
            // 40.00 - 40.48 = -0.48: silent. 40.49 -> 20.245 -> HALF_UP 20.25 -> flowMd 40.50 (Flow's raw total stays 40.49): -0.50, INFO.
            ThresholdCase("flow 40.48", "40.48", listOf(period(1, "2047-01-07", "20.00")), emptyList()),
            ThresholdCase(
                "flow 40.49", "40.49", listOf(period(1, "2047-01-07", "20.00")),
                listOf("90001 CAPACITY_DIFFERS INFO flow=40.5 total=40.49 plan=40.0 gap=-0.5"),
            ),
        )
        for (case in cases) {
            assertEquals(case.expected, rows(listOf(sprint(90_001, "2047-01-07", "2047-01-18", case.md)), case.periods), case.label)
        }
    }

    @Test
    fun `no period in force on any day of a sprint is CAPACITY_MISSING INFO - one row per sprint, planMd and gapMd null`() {
        // No periods: all six sprints are uncovered; the rows carry Flow's figure only.
        val all = e2e().map { it.sprintId to "${it.capacityMd}" }
        assertEquals(all.map { (id, md) -> missing(id, "$md.0") }, rows(e2e()))
        // A first period after the last sprint (04-01) covers none of its days; one before the first sprint covers all of them.
        assertEquals(6, rows(e2e(), listOf(period(1, "2047-04-01", "20.00"))).count { "CAPACITY_MISSING" in it })
        assertEquals(emptyList(), rows(e2e(), listOf(period(1, "2046-01-01", "20.00"))).filter { "CAPACITY_MISSING" in it })
    }

    @Test
    fun `a first period that starts inside a sprint is DIFFERS, not MISSING - the uncovered days count 0`() {
        val one = listOf(sprint(90_001, "2047-01-07", "2047-01-18", "40"))
        // Manual 20.00 from Monday 01-14: it covers 01-14..01-18 = 5 working days x 4.00 = 20.00; 01-07..01-11 count 0. Gap 20 - 40 = -20.
        assertEquals(
            listOf("90001 CAPACITY_DIFFERS INFO flow=40.0 total=40.0 plan=20.0 gap=-20.0"),
            rows(one, listOf(period(1, "2047-01-14", "20.00"))),
        )
        // A Saturday start (01-12) needs no special case: it is in force from the next working day, Monday 01-14.
        assertEquals(
            listOf("90001 CAPACITY_DIFFERS INFO flow=40.0 total=40.0 plan=20.0 gap=-20.0"),
            rows(one, listOf(period(1, "2047-01-12", "20.00"))),
        )
        // From Saturday 01-19, after the sprint's last day: not a single day covered.
        assertEquals(listOf(missing(90_001, "40.0")), rows(one, listOf(period(1, "2047-01-19", "20.00"))))
    }

    @Test
    fun `a manual period inside a sprint - the sprint's plan is the sum over both figures, so only a different total deviates`() {
        val one = listOf(sprint(90_001, "2047-01-07", "2047-01-18", "40"))
        val flow = period(1, "2047-01-07", "20.00", CapacitySource.FLOW, 90_001)
        // 20 until Friday 01-11, then a manual 10 from 01-14: 5 x 4.00 + 5 x 2.00 = 30.00 against 40: gap -10, INFO.
        val short = listOf(flow, period(2, "2047-01-14", "10.00"))
        assertEquals(listOf("90001 CAPACITY_DIFFERS INFO flow=40.0 total=40.0 plan=30.0 gap=-10.0"), rows(one, short))
        val infos = planOf(one, short, WorkingCalendar.MON_FRI).items.single().infos
        assertTrue(infos.any { it.code == CapacityInfoCode.MANUAL_PERIOD_INSIDE })
        // 20 + 20: 40.00. 16 + 24: 5 x 3.20 + 5 x 4.80 = 16 + 24 = 40.00. Same total as Flow: nothing.
        assertEquals(emptyList(), rows(one, listOf(flow, period(2, "2047-01-14", "20.00"))))
        assertEquals(
            emptyList(),
            rows(one, listOf(period(1, "2047-01-07", "16.00", CapacitySource.FLOW, 90_001), period(2, "2047-01-14", "24.00"))),
        )
    }

    @Test
    fun `a holiday added after an import is an INFO the re-import clears, a holiday removed the WARNING mirror - the twin is clean`() {
        val one = listOf(sprint(90_001, "2047-01-07", "2047-01-18", "40"))
        val twenty = listOf(period(1, "2047-01-07", "20.00", CapacitySource.FLOW, 90_001))
        // Imported with no holiday (20.00); holiday 01-10 added: W 9, mdPerWeek 22.22 (UPDATE), flowMd 22.22 x 9 / 5 = 39.996 -> 40.00;
        // the plan loses a day: 9 x 4.00 = 36.00. Gap -4.00: INFO.
        assertEquals(
            listOf("90001 CAPACITY_DIFFERS INFO flow=40.0 total=40.0 plan=36.0 gap=-4.0"),
            rows(one, twenty, HOLIDAY_JAN_10),
        )
        // The holiday-free twin: 10 x 4.00 = 40.00 = flow.
        assertEquals(emptyList(), rows(one, twenty))
        // Imported WITH the holiday (22.22), holiday removed: W 10, mdPerWeek 20.00, flow 40.00; the plan keeps 10 x (22.22 / 5 = 4.444) =
        // 44.44. Gap +4.44: WARNING.
        val holiday = listOf(period(1, "2047-01-07", "22.22", CapacitySource.FLOW, 90_001))
        assertEquals(listOf("90001 CAPACITY_DIFFERS WARNING flow=40.0 total=40.0 plan=44.44 gap=4.44"), rows(one, holiday))
    }

    private class SkipCase(
        val reason: CapacitySkipReason,
        val sprints: List<FlowMirrorSprint>,
        val periods: List<CapacityPeriodRow>,
        val index: Int,
    )

    @Test
    fun `every SKIP reason is silent - no figure to compare`() {
        val startOnly = FlowMirrorSprint(1, 1, "S1", "future", at("2047-01-07"), null, null, true, BigDecimal(40), "CALENDAR")
        val cases = listOf(
            // A start and no end at all.
            SkipCase(CapacitySkipReason.NO_DATES, listOf(startOnly), emptyList(), 0),
            // Dated, Flow has no capacity.
            SkipCase(CapacitySkipReason.NO_CAPACITY, listOf(sprint(1, "2047-01-07", "2047-01-18", null)), emptyList(), 0),
            // 01-09..01-10 lies wholly inside 01-07..01-18: it holds no day. The outer sprint is made clean by 20 a week (10 x 4 = 40).
            SkipCase(
                CapacitySkipReason.OVERLAPS,
                listOf(sprint(1, "2047-01-07", "2047-01-18", "40"), sprint(2, "2047-01-09", "2047-01-10", "10")),
                listOf(period(1, "2047-01-07", "20.00")),
                1,
            ),
            // Saturday 01-12 to Sunday 01-13: it holds two days, no working one.
            SkipCase(CapacitySkipReason.NO_WORKING_DAY, listOf(sprint(1, "2047-01-12", "2047-01-13", "10")), emptyList(), 0),
            // One working day (01-07) with 300,000 man-days: 1,500,000 a week is beyond a period's bounds.
            SkipCase(CapacitySkipReason.OUT_OF_RANGE, listOf(sprint(1, "2047-01-07", "2047-01-07", "300000")), emptyList(), 0),
        )
        for (case in cases) {
            val item = planOf(case.sprints, case.periods, WorkingCalendar.MON_FRI).items[case.index]
            assertEquals(CapacityAction.SKIP, item.action, "${case.reason} is a SKIP row")
            assertEquals(case.reason, item.reason)
            assertEquals(emptyList(), rows(case.sprints, case.periods), "${case.reason} must be silent")
        }
    }

    @Test
    fun `a LONG_WINDOW row is silent while the sprints inside it are judged as if it were absent`() {
        // 01-07..03-15 is 68 calendar days (> 60): it claims last. Sprint 2 (01-21..02-01, 36 MD) keeps its own 10 days.
        val sprints = listOf(sprint(1, "2047-01-07", "2047-03-15", "100"), sprint(2, "2047-01-21", "2047-02-01", "36"))
        val items = planOf(sprints, emptyList(), WorkingCalendar.MON_FRI).items
        assertTrue(items[0].infos.any { it.code == CapacityInfoCode.LONG_WINDOW })
        assertEquals(CapacityAction.CREATE, items[0].action, "the long row is planned (not a SKIP): its silence is the LONG_WINDOW rule")
        assertEquals(listOf(missing(2, "36.0")), rows(sprints))
    }

    @Test
    fun `ZERO_CAPACITY - a plan above Flow's 0 is a WARNING, a plan on hold at 0 or no plan at all is nothing`() {
        val zero = listOf(sprint(90_001, "2047-01-07", "2047-01-18", "0"))
        val infos = planOf(zero, emptyList(), WorkingCalendar.MON_FRI).items.single().infos
        assertTrue(infos.any { it.code == CapacityInfoCode.ZERO_CAPACITY })
        // Manual 20 a week: 10 x 4.00 = 40.00 against Flow's 0.00: gap +40.
        assertEquals(
            listOf("90001 CAPACITY_DIFFERS WARNING flow=0.0 total=0.0 plan=40.0 gap=40.0"),
            rows(zero, listOf(period(1, "2047-01-07", "20.00"))),
        )
        // On hold (0 a week) is a period in force: 0.00 = 0.00.
        assertEquals(emptyList(), rows(zero, listOf(period(1, "2047-01-07", "0.00"))))
        // No period at all against Flow's 0: both sides say nobody, so no CAPACITY_MISSING either.
        assertEquals(emptyList(), rows(zero))
    }

    @Test
    fun `ZERO_CAPACITY - an earlier sprint's imported figure carried over a zero sprint stays a WARNING`() {
        // Sprint 1 (01-07..01-18, 40 MD) imported as 20.00 a week; sprint 2 (01-21..02-01, Flow 0) is never preselected, so sprint 1's
        // period stays in force over it: 10 x 4.00 = 40.00 against 0.00. The remedy is ticking sprint 2 by hand (or a 0.00 period).
        val sprints = listOf(sprint(1, "2047-01-07", "2047-01-18", "40"), sprint(2, "2047-01-21", "2047-02-01", "0"))
        val item = planOf(sprints, emptyList(), WorkingCalendar.MON_FRI).items[1]
        assertEquals(false, item.ticked, "the import never preselects a zero sprint")
        assertEquals(
            listOf("2 CAPACITY_DIFFERS WARNING flow=0.0 total=0.0 plan=40.0 gap=40.0"),
            rows(sprints, listOf(period(1, "2047-01-07", "20.00", CapacitySource.FLOW, 1))),
        )
        val withZeroPeriod = listOf(period(1, "2047-01-07", "20.00", CapacitySource.FLOW, 1), period(2, "2047-01-21", "0.00"))
        assertEquals(emptyList(), rows(sprints, withZeroPeriod))
    }

    @Test
    fun `a TEAM_DEFAULT sprint sharing a day - after the import nothing, flowMd pro-rated, flowTotalMd raw`() {
        // Sprint 1 holds 01-07..01-18. Sprint 2 (TEAM_DEFAULT, 44 MD) is 01-18..02-01: it holds 01-19..02-01 (10 working days, W) but its
        // own window has 11 (01-18, 01-21..01-25, 01-28..02-01): mdPerWeek = round2(5 x 44 / 11) = 20.00, flowMd = 20.00 x 10 / 5 = 40.00.
        val sprints = listOf(
            sprint(90_001, "2047-01-07", "2047-01-18", "40"),
            sprint(90_002, "2047-01-18", "2047-02-01", "44", source = "TEAM_DEFAULT"),
        )
        val item = planOf(sprints, emptyList(), WorkingCalendar.MON_FRI).items[1]
        assertEquals(listOf(10, 44.0, 20.0), listOf(item.workingDays, item.flowMd, item.mdPerWeek))
        assertTrue(item.infos.any { it.code == CapacityInfoCode.FIXED_FIGURE && it.days == 11 })
        // The import writes 20.00 from 01-07 and 20.00 from 01-19: 10 x 4.00 = 40.00 on each: no gap (the raw 44 would be a false -4 INFO).
        assertEquals(emptyList(), rows(sprints, imported(sprints, WorkingCalendar.MON_FRI)))
        // A manual 22.00 from 01-19 carries 10 x 4.40 = 44.00: +4.00 against the pro-rated 40.00; the row names both figures.
        assertEquals(
            listOf("90002 CAPACITY_DIFFERS WARNING flow=40.0 total=44.0 plan=44.0 gap=4.0"),
            rows(sprints, listOf(period(1, "2047-01-07", "20.00", CapacitySource.FLOW, 90_001), period(2, "2047-01-19", "22.00"))),
        )
    }

    @Test
    fun `a closed sprint is absent, a sprint ending today is current - the window is the import's, today in the zone`() {
        val sprints = listOf(sprint(90_000, "2046-12-24", "2047-01-04", "40"), sprint(90_001, "2047-01-07", "2047-01-18", "40"))
        // Sprint 90000 ends Friday 2047-01-04, sprint 90001 ends Friday 01-18; no periods, so every listed sprint is MISSING.
        fun ids(today: String) = deviations(sprints, today = LocalDate.parse(today)).map { it.detail.sprintId }
        assertEquals(listOf(90_000L, 90_001L), ids("2047-01-04"), "ending today is current")
        assertEquals(listOf(90_001L), ids("2047-01-05"), "ended yesterday is closed")
        assertEquals(listOf(90_001L), ids("2047-01-18"), "the last day of the second sprint is still current")
        assertEquals(emptyList(), ids("2047-01-19"))
    }

    @Test
    fun `a gone team is exactly one TEAM_GONE WARNING with no detail, whatever else was given`() {
        val periods = listOf(period(1, "2047-01-07", "20.00"))
        val noDetail = CapacityDeviationDetail(null, null, null, null, null, null, null, null, null, null)
        val expected = listOf(CapacityDeviation(CapacityDeviationKind.TEAM_GONE, DeviationSeverity.WARNING, noDetail))
        // The real service plans a gone team EMPTY; the flag alone decides, so a non-empty plan changes nothing.
        val calendar = WorkingCalendar.MON_FRI
        assertEquals(expected, CapacityDeviationKernels.deviations(CapacityPlan(emptyList(), emptyList()), periods, calendar, gone = true))
        assertEquals(expected, CapacityDeviationKernels.deviations(planOf(e2e(), periods, calendar), periods, calendar, gone = true))
    }

    @Test
    fun `the order is by effectiveFrom then sprint id, whatever order the plan lists`() {
        val plan = planOf(e2e(), emptyList(), WorkingCalendar.MON_FRI)
        val reversed = plan.copy(items = plan.items.reversed())
        assertNotEquals(plan.items.map { it.sprintId }, reversed.items.map { it.sprintId })
        val ordered = CapacityDeviationKernels.deviations(reversed, emptyList(), WorkingCalendar.MON_FRI, gone = false)
        assertEquals((90_001L..90_006L).toList(), ordered.map { it.detail.sprintId })
        assertEquals(ordered.map { it.detail.effectiveFrom }.sortedBy { it }, ordered.map { it.detail.effectiveFrom })
        // The input sprints in reverse give the same plan (the import sorts by start), hence the same rows.
        assertEquals(rows(e2e()), rows(e2e().reversed()))
    }
}
