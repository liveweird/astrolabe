package ch.nokillswit

import ch.nokillswit.flow.CapacityAction
import ch.nokillswit.flow.CapacityImportItem
import ch.nokillswit.flow.CapacityImportKernels
import ch.nokillswit.flow.CapacityInfoCode
import ch.nokillswit.flow.CapacityPlan
import ch.nokillswit.flow.CapacitySkipReason
import ch.nokillswit.flow.FlowMirrorSprint
import ch.nokillswit.infra.time.WorkingCalendar
import ch.nokillswit.planning.CapacityPeriod
import ch.nokillswit.planning.weekCapacity
import ch.nokillswit.teams.CapacityPeriodRow
import ch.nokillswit.teams.CapacitySource
import java.math.BigDecimal
import java.time.LocalDate
import java.time.LocalDateTime
import java.time.ZoneId
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * The capacity import kernel (`CapacityImportKernels.plan`), pure: every vector is counted by hand. Calendar facts used below: 2026-11-02
 * is a Monday, so a Monday-to-second-Friday sprint (11-02..11-13) has 10 working days, 11-16..11-27 and 11-30..12-11 likewise;
 * 2026-11-11 (Independence Day) is a Wednesday. `mdPerWeek = round2(5 x flowMd / workingDays)`.
 */
class CapacityImportKernelsTest {
    private companion object {
        val WARSAW: ZoneId = ZoneId.of("Europe/Warsaw")
        val EARLY: LocalDate = LocalDate.of(2026, 10, 1)
        val HOLIDAY_NOV_11 = WorkingCalendar(mapOf(LocalDate.of(2026, 11, 11) to "Independence Day"))
    }

    private fun at(date: String, time: String = "09:00", zone: ZoneId = WARSAW): Long =
        LocalDateTime.parse("${date}T$time").atZone(zone).toInstant().toEpochMilli()

    private fun sprint(
        id: Long,
        start: Long?,
        end: Long?,
        md: String?,
        name: String = "Sprint $id",
        completeAt: Long? = null,
    ) = FlowMirrorSprint(id, 1, name, "future", start, end, completeAt, true, md?.let(::BigDecimal), "CALENDAR")

    /** A sprint from a Monday 09:00 to a Friday 17:00 (Warsaw). */
    private fun span(id: Long, from: String, to: String, md: String?, name: String = "Sprint $id") =
        sprint(id, at(from), at(to, "17:00"), md, name)

    /** A closed sprint from 11-02 (20 MD) with both an `endAt` and a `completeAt`. */
    private fun completed(id: Long, endAt: Long, completeAt: Long) =
        FlowMirrorSprint(id, 1, "Sprint $id", "closed", at("2026-11-02"), endAt, completeAt, true, BigDecimal("20"), "CALENDAR")

    private fun period(
        id: Int,
        from: String,
        md: String,
        source: CapacitySource,
        sprintId: Long? = null,
        sprintName: String? = null,
        wip: Int? = null,
    ) = CapacityPeriodRow(id.toUInt(), LocalDate.parse(from), BigDecimal(md), wip, source, sprintId, sprintName)

    @Suppress("LongParameterList") // the kernel's own seven inputs, defaulted for the common case
    private fun plan(
        sprints: List<FlowMirrorSprint>,
        existing: List<CapacityPeriodRow> = emptyList(),
        calendar: WorkingCalendar = WorkingCalendar.MON_FRI,
        today: LocalDate = EARLY,
        from: LocalDate? = null,
        includeClosed: Boolean = false,
        zone: ZoneId = WARSAW,
    ): CapacityPlan = CapacityImportKernels.plan(sprints, zone, calendar, today, existing, from, includeClosed)

    private fun CapacityPlan.only(): CapacityImportItem = items.single()

    @Test
    fun `plain sprints - the man-days spread over ten working days, one CREATE per start, ticked`() {
        val result = plan(
            listOf(
                span(1, "2026-11-02", "2026-11-13", "40"),
                span(2, "2026-11-16", "2026-11-27", "36"),
                span(3, "2026-11-30", "2026-12-11", "44"),
            ),
        )

        assertEquals(listOf(20.0, 18.0, 22.0), result.items.map { it.mdPerWeek })
        assertEquals(listOf("2026-11-02", "2026-11-16", "2026-11-30"), result.items.map { it.start })
        assertEquals(listOf("2026-11-13", "2026-11-27", "2026-12-11"), result.items.map { it.end })
        assertEquals(result.items.map { it.start }, result.items.map { it.effectiveFrom }, "no shared day: a sprint holds from its start")
        assertTrue(result.items.all { it.action == CapacityAction.CREATE && it.ticked && it.workingDays == 10 && it.reason == null })
        assertEquals(listOf(40.0, 36.0, 44.0), result.items.map { it.flowMd })
        assertEquals("Sprint 1", result.items.first().name)
        assertEquals(listOf(3, 0, 0, 0, 0), result.totals().let { listOf(it.create, it.update, it.unchanged, it.skip, it.removals) })
    }

    @Test
    fun `a holiday inside - 40 MD over nine working days is 22 22, and the weekly capacity sums back to 40`() {
        val item = plan(listOf(span(1, "2026-11-02", "2026-11-13", "40")), calendar = HOLIDAY_NOV_11).only()

        assertEquals(9, item.workingDays)
        assertEquals(22.22, item.mdPerWeek)
        assertEquals(CapacityAction.CREATE, item.action)

        // The round trip through the load kernel: the figure in force over the two weeks, closed by a zero period after the sprint.
        val periods = listOf(
            CapacityPeriod(LocalDate.of(2026, 11, 2), BigDecimal("22.22"), null),
            CapacityPeriod(LocalDate.of(2026, 11, 14), BigDecimal.ZERO, null),
        )
        val mondays = listOf(LocalDate.of(2026, 11, 2), LocalDate.of(2026, 11, 9))
        val weeks = mondays.map { checkNotNull(weekCapacity(it, periods, HOLIDAY_NOV_11)) }
        assertEquals(BigDecimal("22.22"), weeks[0])
        assertEquals(BigDecimal("17.78"), weeks[1], "four working days after the holiday: 4 x 22.22 / 5")
        val total = weeks.fold(BigDecimal.ZERO, BigDecimal::add)
        assertTrue((total - BigDecimal("40.00")).abs() <= BigDecimal("0.05"), "the weeks add up to $total, Flow said 40")
    }

    @Test
    fun `rounding is half up on the exact quotient - a tie rounds away from zero`() {
        // 5 x 0.45 / 10 = 0.225 exactly: HALF_UP is 0.23 (HALF_EVEN would say 0.22).
        assertEquals(0.23, plan(listOf(span(1, "2026-11-02", "2026-11-13", "0.45"))).only().mdPerWeek)
        // 5 x 37 / 9 = 20.5555...: no tie, 20.56.
        assertEquals(20.56, plan(listOf(span(1, "2026-11-02", "2026-11-13", "37")), calendar = HOLIDAY_NOV_11).only().mdPerWeek)
    }

    @Test
    fun `a genuine overlap skips the later sprint - the earlier start wins, the next free sprint is kept`() {
        val result = plan(
            listOf(
                span(3, "2026-11-16", "2026-11-27", "36"),
                span(2, "2026-11-09", "2026-11-20", "30"),
                span(1, "2026-11-02", "2026-11-13", "40"),
                sprint(4, at("2026-11-12", "12:30"), at("2026-11-24", "17:00"), "20"),
            ),
        )

        // In start order: 1 (kept, ends 11-13), 2 starts 11-09 < 11-13 (overlaps), 4 starts 11-12 < 11-13 (overlaps),
        // 3 starts 11-16 (kept).
        assertEquals(listOf(1L, 2L, 4L, 3L), result.items.map { it.sprintId })
        assertEquals(listOf(null, CapacitySkipReason.OVERLAPS, CapacitySkipReason.OVERLAPS, null), result.items.map { it.reason })
        assertEquals(listOf(true, false, false, true), result.items.map { it.ticked })
        assertEquals(listOf("2026-11-02", null, null, "2026-11-16"), result.items.map { it.effectiveFrom })
        assertNull(result.items[1].mdPerWeek, "a skipped sprint carries no figure")
        assertNull(result.items[1].workingDays)
    }

    @Test
    fun `Monday to Monday series - each sprint ends on the day the next starts, nothing is skipped, W is 11 then 10 and 10`() {
        fun monday(date: String, to: String, id: Long, md: String) = sprint(id, at(date, "10:00"), at(to, "10:00"), md)
        val result = plan(
            listOf(
                monday("2026-11-02", "2026-11-16", 1, "44"),
                monday("2026-11-16", "2026-11-30", 2, "40"),
                monday("2026-11-30", "2026-12-14", 3, "50"),
            ),
        )

        // S1 holds 11-02..11-16 (Mon to Mon: 11 working days); S2 starts on S1's last day, so it holds 11-17..11-30 (10);
        // S3 holds 12-01..12-14 (10).
        assertEquals(listOf("2026-11-02", "2026-11-17", "2026-12-01"), result.items.map { it.effectiveFrom })
        assertEquals(listOf("2026-11-02", "2026-11-16", "2026-11-30"), result.items.map { it.start })
        assertEquals(listOf("2026-11-16", "2026-11-30", "2026-12-14"), result.items.map { it.end })
        assertEquals(listOf(11, 10, 10), result.items.map { it.workingDays })
        assertEquals(listOf(20.0, 20.0, 25.0), result.items.map { it.mdPerWeek })
        assertTrue(result.items.all { it.action == CapacityAction.CREATE && it.ticked && it.reason == null })

        // The weekly capacity over the series adds up to Flow's 44 + 40 + 50 = 134.
        val periods = result.items.map { CapacityPeriod(LocalDate.parse(it.effectiveFrom), BigDecimal(it.mdPerWeek.toString()), null) } +
            CapacityPeriod(LocalDate.of(2026, 12, 15), BigDecimal.ZERO, null)
        val mondays = generateSequence(LocalDate.of(2026, 11, 2)) { it.plusWeeks(1) }.take(7).toList()
        val total = mondays.sumOf { checkNotNull(weekCapacity(it, periods, WorkingCalendar.MON_FRI)) }
        assertTrue((total - BigDecimal("134.00")).abs() <= BigDecimal("0.05"), "the weeks add up to $total")
    }

    @Test
    fun `same-day sprints at different times, and a boundary on a Friday - the earlier sprint keeps the shared day`() {
        // A ends Wednesday 11-04 12:00, B starts that Wednesday 12:30: B holds from Thursday 11-05 (7 working days to Friday 11-13).
        val wednesday = plan(
            listOf(
                sprint(1, at("2026-11-02"), at("2026-11-04", "12:00"), "12"),
                sprint(2, at("2026-11-04", "12:30"), at("2026-11-13", "17:00"), "14"),
            ),
        )
        assertEquals(listOf(3, 7), wednesday.items.map { it.workingDays })
        assertEquals(listOf("2026-11-04", "2026-11-13"), wednesday.items.map { it.end })
        assertEquals(listOf("2026-11-02", "2026-11-05"), wednesday.items.map { it.effectiveFrom })
        assertEquals(listOf(20.0, 10.0), wednesday.items.map { it.mdPerWeek })

        // A ends Friday 11-06 and B starts that Friday: B holds from Saturday 11-07 (any date may start a period), W = 5.
        val friday = plan(
            listOf(
                sprint(1, at("2026-11-02"), at("2026-11-06", "12:00"), "20"),
                sprint(2, at("2026-11-06", "12:30"), at("2026-11-13", "17:00"), "15"),
            ),
        )
        assertEquals(listOf("2026-11-02", "2026-11-07"), friday.items.map { it.effectiveFrom })
        assertEquals(listOf(5, 5), friday.items.map { it.workingDays })
        assertEquals(listOf(20.0, 15.0), friday.items.map { it.mdPerWeek })
        assertTrue(friday.items.all { it.action == CapacityAction.CREATE })
    }

    @Test
    fun `the existing-period lookup, the info and the removals use effectiveFrom - not the raw start`() {
        val sprints = listOf(
            sprint(1, at("2026-11-02"), at("2026-11-04", "12:00"), "12"),
            sprint(2, at("2026-11-04", "12:30"), at("2026-11-13", "17:00"), "14"),
        )

        // A manual period on B's raw start (11-04, A's last day) is inside A, and is nothing of B's.
        val onStart = plan(sprints, listOf(period(1, "2026-11-04", "9", CapacitySource.MANUAL)))
        assertEquals(CapacityAction.CREATE, onStart.items[1].action)
        assertEquals(listOf("2026-11-04"), onStart.items[0].infos.map { it.date })
        assertTrue(onStart.items[1].infos.isEmpty())
        // On B's effectiveFrom it is B's: MANUAL_PERIOD.
        val onEffective = plan(sprints, listOf(period(1, "2026-11-05", "9", CapacitySource.MANUAL)))
        assertEquals(CapacityAction.MANUAL_PERIOD, onEffective.items[1].action)
        assertEquals(1u, onEffective.items[1].existing?.periodId)
        // A Flow period on effectiveFrom is reused (UNCHANGED), one on the shared day inside A is A's to cut short: a removal.
        val flow = plan(
            sprints,
            listOf(
                period(2, "2026-11-04", "5", CapacitySource.FLOW, 1, "Sprint 1"),
                period(3, "2026-11-05", "10.00", CapacitySource.FLOW, 2, "Sprint 2"),
            ),
        )
        assertEquals(CapacityAction.UNCHANGED, flow.items[1].action)
        assertEquals(listOf(2u), flow.removals.map { it.periodId })
        // B holds from 11-05, so a Flow period on 11-06 lies inside B (11-05, 11-13].
        val insideB = plan(sprints, listOf(period(4, "2026-11-06", "5", CapacitySource.FLOW, 2, "Sprint 2")))
        assertEquals(listOf(4u), insideB.removals.map { it.periodId })
    }

    @Test
    fun `an end at local midnight adds no day - and a zero-length sprint is one day`() {
        // Friday 11-13 00:00 ends the sprint on Thursday: 11-02..11-12 is 9 working days.
        val midnight = plan(listOf(sprint(1, at("2026-11-02"), at("2026-11-13", "00:00"), "45"))).only()
        assertEquals("2026-11-12", midnight.end)
        assertEquals(9, midnight.workingDays)
        assertEquals(25.0, midnight.mdPerWeek)

        val instant = plan(listOf(sprint(2, at("2026-11-02"), at("2026-11-02"), "5"))).only()
        assertEquals(listOf("2026-11-02", "2026-11-02", "1"), listOf(instant.start, instant.end, instant.workingDays.toString()))
        assertEquals(25.0, instant.mdPerWeek)
    }

    @Test
    fun `a sprint wholly on the previous sprint's last day is an overlap, a partial one too`() {
        val result = plan(
            listOf(
                span(1, "2026-11-02", "2026-11-13", "40"),
                sprint(2, at("2026-11-13", "09:30"), at("2026-11-13", "16:00"), "5"),
                sprint(3, at("2026-11-12"), at("2026-11-20", "17:00"), "30"),
            ),
        )

        // In start order 1, 3 (starts 11-12 < 11-13: genuine overlap), 2 (starts on 11-13, effectiveFrom 11-14 > its end 11-13).
        assertEquals(listOf(1L, 3L, 2L), result.items.map { it.sprintId })
        assertEquals(listOf(null, CapacitySkipReason.OVERLAPS, CapacitySkipReason.OVERLAPS), result.items.map { it.reason })
    }

    @Test
    fun `early completion - the sprint ends when it was completed and the next one is live from that day`() {
        // A: planned to 11-13 but completed on Friday 11-06 17:00; B starts that day. Neither is skipped.
        val a = completed(1, endAt = at("2026-11-13", "17:00"), completeAt = at("2026-11-06", "17:00"))
        val b = sprint(2, at("2026-11-06", "17:30"), at("2026-11-20", "17:00"), "40")
        val result = plan(listOf(a, b))

        assertEquals(listOf("2026-11-06", "2026-11-20"), result.items.map { it.end })
        assertEquals(listOf("2026-11-02", "2026-11-07"), result.items.map { it.effectiveFrom })
        assertEquals(listOf(5, 10), result.items.map { it.workingDays })
        assertEquals(listOf(20.0, 20.0), result.items.map { it.mdPerWeek })
        assertTrue(result.items.all { it.reason == null })
        // completeAt later than endAt does not stretch the sprint; completeAt alone stands in for a missing endAt.
        val late = completed(3, endAt = at("2026-11-06", "17:00"), completeAt = at("2026-11-13", "17:00"))
        assertEquals("2026-11-06", plan(listOf(late)).only().end)
    }

    @Test
    fun `a sprint with 0 man-days is planned but never preselected - and says so`() {
        val item = plan(listOf(span(1, "2026-11-02", "2026-11-13", "0"))).only()

        assertEquals(CapacityAction.CREATE, item.action)
        assertFalse(item.ticked)
        assertEquals(0.0, item.mdPerWeek)
        assertEquals(listOf(CapacityInfoCode.ZERO_CAPACITY), item.infos.map { it.code })
        assertNull(item.infos.single().date)
        val flowPeriod = period(1, "2026-11-02", "5", CapacitySource.FLOW, 1, "Sprint 1")
        val update = plan(listOf(span(1, "2026-11-02", "2026-11-13", "0")), listOf(flowPeriod)).only()
        assertEquals(CapacityAction.UPDATE, update.action)
        assertFalse(update.ticked)
    }

    @Test
    fun `a Flow period of a covered sprint that the sprint does not reuse is removed - a sprint moved later`() {
        val sprints = listOf(span(1, "2026-11-16", "2026-11-27", "36"))
        val old = listOf(period(1, "2026-11-02", "18", CapacitySource.FLOW, 1, "Sprint 1"))

        val moved = plan(sprints, old)
        assertEquals(CapacityAction.CREATE, moved.only().action)
        assertEquals(listOf(1u), moved.removals.map { it.periodId })
        assertEquals(1L, moved.removals.single().flowSprintId)
        // A sprint the import does not cover (no capacity, closed) leaves its period alone.
        assertEquals(emptyList(), plan(listOf(span(1, "2026-11-16", "2026-11-27", null)), old).removals)
        assertEquals(emptyList(), plan(sprints, old, today = LocalDate.of(2026, 12, 20)).removals)
    }

    @Test
    fun `no dates - a missing start or end, an end before the start - completeAt stands in for a missing endAt`() {
        val result = plan(
            listOf(
                sprint(1, null, at("2026-11-13"), "40"),
                sprint(2, at("2026-11-02"), null, "40"),
                sprint(3, at("2026-11-13"), at("2026-11-02"), "40"),
                sprint(4, null, null, null),
                sprint(5, at("2026-11-02"), null, "40", completeAt = at("2026-11-13", "17:00")),
            ),
        )

        val byId = result.items.associateBy { it.sprintId }
        listOf(1L, 2L, 3L, 4L).forEach { id ->
            assertEquals(CapacityAction.SKIP, byId.getValue(id).action, "sprint $id")
            assertEquals(CapacitySkipReason.NO_DATES, byId.getValue(id).reason, "sprint $id: dates are asked before the capacity")
            assertNull(byId.getValue(id).workingDays)
        }
        assertNull(byId.getValue(4L).start)
        assertNull(byId.getValue(1L).end, "the end is `max(start, spanEnd - 1 ms)`: no start, no end")
        // An end before the start stays NO_DATES (never a ticked CREATE at 5 x the capacity), shown with its dates as sent.
        val inverted = byId.getValue(3L)
        assertEquals("2026-11-13" to "2026-11-02", inverted.start to inverted.end)
        assertEquals(CapacityAction.CREATE, byId.getValue(5L).action)
        assertEquals("2026-11-13", byId.getValue(5L).end)
        assertEquals(20.0, byId.getValue(5L).mdPerWeek)
        assertEquals(5, result.items.size)
        assertEquals(4, result.totals().skip)
        assertEquals(listOf(1L, 4L), result.items.takeLast(2).map { it.sprintId }, "sprints without a start come last")
    }

    @Test
    fun `no capacity - Flow has no figure - the working days are still counted`() {
        val item = plan(listOf(span(1, "2026-11-02", "2026-11-13", null))).only()

        assertEquals(CapacityAction.SKIP, item.action)
        assertEquals(CapacitySkipReason.NO_CAPACITY, item.reason)
        assertEquals(10, item.workingDays)
        assertNull(item.flowMd)
        assertNull(item.mdPerWeek)
        assertFalse(item.ticked)
    }

    @Test
    fun `no working day - a weekend, or a span wholly on holidays`() {
        val weekend = plan(listOf(sprint(1, at("2026-11-07"), at("2026-11-08", "17:00"), "10"))).only()
        assertEquals(CapacitySkipReason.NO_WORKING_DAY, weekend.reason)
        assertEquals(0, weekend.workingDays)

        val holiday = plan(listOf(sprint(2, at("2026-11-11"), at("2026-11-11", "17:00"), "10")), calendar = HOLIDAY_NOV_11).only()
        assertEquals(CapacitySkipReason.NO_WORKING_DAY, holiday.reason)
        assertEquals(CapacityAction.SKIP, holiday.action)
    }

    @Test
    fun `out of range - a figure past the man-day bounds is skipped, one just inside is kept`() {
        // One working day: 5 x 300,000 = 1,500,000 >= 1,000,000. 5 x 199,999.99 = 999,999.95 is inside.
        val result = plan(
            listOf(
                sprint(1, at("2026-11-02"), at("2026-11-02", "17:00"), "300000"),
                sprint(2, at("2026-11-03"), at("2026-11-03", "17:00"), "199999.99"),
            ),
        )

        assertEquals(CapacitySkipReason.OUT_OF_RANGE, result.items[0].reason)
        assertNull(result.items[0].mdPerWeek)
        assertEquals(1, result.items[0].workingDays)
        assertEquals(CapacityAction.CREATE, result.items[1].action)
        assertEquals(999_999.95, result.items[1].mdPerWeek)
    }

    @Test
    fun `a manual period on the start date is never changed - the sprint is MANUAL_PERIOD and nothing is removed`() {
        val manual = period(7, "2026-11-02", "50", CapacitySource.MANUAL)
        val result = plan(listOf(span(1, "2026-11-02", "2026-11-13", "40")), listOf(manual))

        val item = result.only()
        assertEquals(CapacityAction.MANUAL_PERIOD, item.action)
        assertNull(item.reason)
        assertEquals(20.0, item.mdPerWeek, "the figure it would have shown is still reported")
        assertFalse(item.ticked)
        assertEquals(7u, item.existing?.periodId)
        assertEquals(CapacitySource.MANUAL, item.existing?.source)
        assertEquals(50.0, item.existing?.mdPerWeek)
        assertTrue(item.infos.isEmpty(), "the period sits ON the start, not inside")
        assertEquals(emptyList(), result.removals)
        assertEquals(1, result.totals().skip)
    }

    @Test
    fun `a manual period inside the sprint adds the info with its date - the last day counts, the day after does not`() {
        val result = plan(
            listOf(span(1, "2026-11-02", "2026-11-13", "40")),
            listOf(
                period(1, "2026-11-09", "30", CapacitySource.MANUAL),
                period(2, "2026-11-13", "31", CapacitySource.MANUAL),
                period(3, "2026-11-14", "32", CapacitySource.MANUAL),
                period(4, "2026-10-26", "33", CapacitySource.MANUAL),
            ),
        )

        val item = result.only()
        assertEquals(CapacityAction.CREATE, item.action)
        assertTrue(item.ticked)
        assertEquals(listOf("2026-11-09", "2026-11-13"), item.infos.map { it.date })
        assertTrue(item.infos.all { it.code == CapacityInfoCode.MANUAL_PERIOD_INSIDE })
    }

    @Test
    fun `a Flow-sourced period is updated when the figure, the name or the sprint changed - and left when nothing did`() {
        val sprints = listOf(span(1, "2026-11-02", "2026-11-13", "40", name = "Alpha"))
        fun flowPeriod(md: String, name: String?, sprintId: Long? = 1) =
            listOf(period(5, "2026-11-02", md, CapacitySource.FLOW, sprintId, name, wip = 3))

        val figure = plan(sprints, flowPeriod("18.00", "Alpha")).only()
        assertEquals(CapacityAction.UPDATE, figure.action)
        assertTrue(figure.ticked)
        assertEquals(5u, figure.existing?.periodId)
        assertEquals(18.0, figure.existing?.mdPerWeek)
        assertEquals(20.0, figure.mdPerWeek)

        assertEquals(CapacityAction.UPDATE, plan(sprints, flowPeriod("20.00", "Old name")).only().action, "a rename alone")
        val other = plan(sprints, flowPeriod("20.00", "Alpha", sprintId = 2)).only()
        assertEquals(CapacityAction.UPDATE, other.action, "another sprint's period")

        val same = plan(sprints, flowPeriod("20.0", "Alpha")).only()
        assertEquals(CapacityAction.UNCHANGED, same.action, "20.0 equals 20.00: the scale is not a change")
        assertFalse(same.ticked)
        assertEquals(CapacitySource.FLOW, same.existing?.source)
        assertEquals(0, plan(sprints, flowPeriod("20.00", "Alpha")).removals.size, "the reused period is not a removal")
    }

    @Test
    fun `removals - a sprint gone from the document, a re-dated sprint's stale period, a null sprint id - never a manual one`() {
        val sprints = listOf(span(1, "2026-11-02", "2026-11-13", "40", name = "Alpha"), span(2, "2026-11-16", "2026-11-27", "36"))
        val existing = listOf(
            period(1, "2026-11-02", "20", CapacitySource.FLOW, 1, "Alpha"), // reused: UNCHANGED
            period(2, "2026-11-09", "9", CapacitySource.FLOW, 1, "Alpha"), // sprint 1 was re-dated: inside it now
            period(3, "2026-12-14", "7", CapacitySource.FLOW, 99, "Gone"), // its sprint left the document
            period(4, "2026-12-21", "6", CapacitySource.FLOW, null, null), // no sprint id at all
            period(5, "2026-11-23", "5", CapacitySource.MANUAL), // inside sprint 2, but a person's: untouched
            period(6, "2026-11-26", "4", CapacitySource.FLOW, 2, "Sprint 2"), // inside sprint 2 (sprint 2 starts 11-16)
        )

        val result = plan(sprints, existing)

        assertEquals(listOf(2u, 6u, 3u, 4u), result.removals.map { it.periodId }, "by date")
        assertEquals(listOf("2026-11-09", "2026-11-26", "2026-12-14", "2026-12-21"), result.removals.map { it.effectiveFrom })
        assertEquals("Gone", result.removals.single { it.periodId == 3u }.flowSprintName)
        assertEquals(9.0, result.removals.first().mdPerWeek)
        assertEquals(listOf(CapacityAction.UNCHANGED, CapacityAction.CREATE), result.items.map { it.action })
        assertEquals(4, result.totals().removals)
    }

    @Test
    fun `a gone sprint's period before the window keeps its history unless closed sprints are included`() {
        val gone = listOf(period(1, "2026-09-07", "10", CapacitySource.FLOW, 99, "Aged out"))
        val today = LocalDate.of(2026, 11, 20)

        assertEquals(emptyList(), plan(emptyList(), gone, today = today).removals, "dated before today: history")
        assertEquals(listOf(1u), plan(emptyList(), gone, today = today, includeClosed = true).removals.map { it.periodId })
        assertEquals(listOf(1u), plan(emptyList(), gone, today = today, from = LocalDate.of(2026, 9, 1)).removals.map { it.periodId })
    }

    @Test
    fun `closed sprints - left out by default, listed unticked with the toggle - from moves the line, the end day itself is open`() {
        val sprints = listOf(span(1, "2026-11-02", "2026-11-13", "40"), span(2, "2026-11-16", "2026-11-27", "36"))
        val today = LocalDate.of(2026, 11, 20)

        assertEquals(listOf(2L), plan(sprints, today = today).items.map { it.sprintId })

        val all = plan(sprints, today = today, includeClosed = true)
        assertEquals(listOf(1L, 2L), all.items.map { it.sprintId })
        assertEquals(listOf(false, true), all.items.map { it.ticked })
        assertEquals(CapacityAction.CREATE, all.items[0].action, "closed, but still planned: the user may tick it")

        val endsOnFrom = plan(sprints, today = today, from = LocalDate.of(2026, 11, 13))
        assertEquals(listOf(1L, 2L), endsOnFrom.items.map { it.sprintId }, "ends ON from")
        assertEquals(listOf(2L), plan(sprints, today = today, from = LocalDate.of(2026, 11, 14)).items.map { it.sprintId })
        val earlyToday = plan(sprints, today = LocalDate.of(2026, 1, 1), from = LocalDate.of(2026, 11, 14))
        assertEquals(listOf(2L), earlyToday.items.map { it.sprintId }, "from wins over today")
    }

    @Test
    fun `an overlap is decided by the dates alone - a hidden closed sprint still wins over the open one that starts inside it`() {
        val sprints = listOf(span(1, "2026-11-02", "2026-11-13", "40"), span(2, "2026-11-09", "2026-11-24", "30"))
        val today = LocalDate.of(2026, 11, 20)

        val hidden = plan(sprints, today = today)
        assertEquals(listOf(2L), hidden.items.map { it.sprintId })
        assertEquals(CapacitySkipReason.OVERLAPS, hidden.only().reason)
        assertEquals(CapacitySkipReason.OVERLAPS, plan(sprints, today = today, includeClosed = true).items[1].reason)
    }

    @Test
    fun `a stale Flow period inside a closed sprint is history - and inside a listed closed one is still not removed`() {
        val sprints = listOf(span(1, "2026-11-02", "2026-11-13", "40"))
        val stale = listOf(period(1, "2026-11-09", "9", CapacitySource.FLOW, 1, "Sprint 1"))
        val today = LocalDate.of(2026, 11, 20)

        assertEquals(emptyList(), plan(sprints, stale, today = today).removals)
        assertEquals(emptyList(), plan(sprints, stale, today = today, includeClosed = true).removals)
        assertEquals(listOf(1u), plan(sprints, stale).removals.map { it.periodId }, "the same data, not closed: removed")
    }

    @Test
    fun `zone edge - instants near midnight in Warsaw are the next local day, and the zone changes the working days`() {
        // 2026-11-01T23:30Z is 00:30 on Monday 11-02 in Warsaw (CET, +1); 2026-11-12T23:30Z is 00:30 on Friday 11-13.
        val sprints = listOf(sprint(1, at("2026-11-01", "23:30", ZoneId.of("UTC")), at("2026-11-12", "23:30", ZoneId.of("UTC")), "40"))

        val warsaw = plan(sprints).only()
        assertEquals("2026-11-02", warsaw.start)
        assertEquals("2026-11-13", warsaw.end)
        assertEquals(10, warsaw.workingDays)
        assertEquals(20.0, warsaw.mdPerWeek)

        val utc = plan(sprints, zone = ZoneId.of("UTC")).only()
        assertEquals("2026-11-01", utc.start, "a Sunday")
        assertEquals("2026-11-12", utc.end)
        assertEquals(9, utc.workingDays)
        assertEquals(22.22, utc.mdPerWeek)

        // A Friday 23:30 Warsaw end is still Friday; the same instant 22:30Z.
        val friday = plan(listOf(sprint(2, at("2026-11-16"), at("2026-11-27", "23:30"), "40"))).only()
        assertEquals("2026-11-27", friday.end)
    }
}
