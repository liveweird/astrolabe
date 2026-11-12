package ch.nokillswit

import ch.nokillswit.flow.CapacityAction
import ch.nokillswit.flow.CapacityImportItem
import ch.nokillswit.flow.CapacityImportKernels
import ch.nokillswit.flow.CapacityInfoCode
import ch.nokillswit.flow.CapacityPlan
import ch.nokillswit.flow.CapacitySkipReason
import ch.nokillswit.flow.FLOW_MAX_CALENDAR_DAYS
import ch.nokillswit.flow.FlowMirrorSprint
import ch.nokillswit.flow.spanEndOf
import ch.nokillswit.infra.time.WorkingCalendar
import ch.nokillswit.planning.CapacityPeriod
import ch.nokillswit.planning.weekCapacity
import ch.nokillswit.teams.CapacityPeriodRow
import ch.nokillswit.teams.CapacitySource
import java.math.BigDecimal
import java.math.RoundingMode
import java.time.LocalDate
import java.time.LocalDateTime
import java.time.ZoneId
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * The capacity import kernel (`CapacityImportKernels.plan`), pure: every vector is counted by hand. The span and the days a sprint
 * holds are Flow's (the planned end first; the first sprint holding a day claims it; only a sprint wholly inside another counts no
 * day). Calendar facts used below: 2026-11-02
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
        source: String = "CALENDAR",
    ) = FlowMirrorSprint(id, 1, name, "future", start, end, completeAt, true, md?.let(::BigDecimal), source)

    /** A sprint from a Monday 09:00 to a Friday 17:00 (Warsaw). */
    private fun span(id: Long, from: String, to: String, md: String?, name: String = "Sprint $id") =
        sprint(id, at(from), at(to, "17:00"), md, name)

    /** A closed sprint from 11-02 (20 MD unless given) with both an `endAt` and a `completeAt`. */
    private fun completed(id: Long, endAt: Long, completeAt: Long, md: String = "20") =
        FlowMirrorSprint(id, 1, "Sprint $id", "closed", at("2026-11-02"), endAt, completeAt, true, BigDecimal(md), "CALENDAR")

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
    fun `overlapping sprints take the days no earlier sprint holds - none is skipped unless wholly inside`() {
        val result = plan(
            listOf(
                span(3, "2026-11-16", "2026-11-27", "36"),
                span(2, "2026-11-09", "2026-11-20", "30"),
                span(1, "2026-11-02", "2026-11-13", "40"),
                sprint(4, at("2026-11-12", "12:30"), at("2026-11-24", "17:00"), "20"),
            ),
        )

        // In start order 1, 2, 4, 3. 1 holds 11-02..11-13 (W 10, 20.00). 2 (11-09..11-20) gets 11-14..11-20: W 5 (11-16..11-20), 30.00.
        // 4 (11-12..11-24) gets 11-21..11-24: W 2 (the weekend is not a working day), 50.00.
        // 3 (11-16..11-27) gets 11-25..11-27: W 3, 60.00.
        assertEquals(listOf(1L, 2L, 4L, 3L), result.items.map { it.sprintId })
        assertEquals(listOf("2026-11-02", "2026-11-14", "2026-11-21", "2026-11-25"), result.items.map { it.effectiveFrom })
        assertEquals(listOf(10, 5, 2, 3), result.items.map { it.workingDays })
        assertEquals(listOf(20.0, 30.0, 50.0, 60.0), result.items.map { it.mdPerWeek })
        assertEquals(listOf(null, null, null, null), result.items.map { it.reason })
        assertTrue(result.items.all { it.ticked && it.action == CapacityAction.CREATE })
    }

    @Test
    fun `wholly inside - the inner sprint is OVERLAPS and holds nothing, so the next sprint starts after the OUTER one's end`() {
        val result = plan(
            listOf(
                span(1, "2026-11-02", "2026-11-13", "40"),
                span(2, "2026-11-04", "2026-11-10", "10"),
                span(3, "2026-11-11", "2026-11-18", "30"),
            ),
        )

        assertEquals(listOf(null, CapacitySkipReason.OVERLAPS, null), result.items.map { it.reason })
        assertEquals(listOf(CapacityAction.CREATE, CapacityAction.SKIP, CapacityAction.CREATE), result.items.map { it.action })
        assertNull(result.items[1].effectiveFrom)
        assertNull(result.items[1].workingDays)
        assertNull(result.items[1].mdPerWeek, "a sprint with no day carries no figure")
        assertFalse(result.items[1].ticked)
        // 3 starts 11-11 inside 1, so it holds 11-14..11-18: W 3 (11-16..11-18), 30 x 5 / 3 = 50.00.
        assertEquals("2026-11-14", result.items[2].effectiveFrom)
        assertEquals(3, result.items[2].workingDays)
        assertEquals(50.0, result.items[2].mdPerWeek)
        assertEquals(1, result.totals().skip)
    }

    @Test
    fun `a sprint without capacity, with 0 man-days, out of range or on a weekend still holds its days`() {
        // Each first sprint is refused (or unticked) for its own reason, and the second sprint starts inside its window.
        fun after(first: FlowMirrorSprint, second: FlowMirrorSprint) = plan(listOf(first, second)).items

        // NO_CAPACITY 11-02..11-13, then 11-09..11-20 (30 MD): held from 11-14, W 5, 30.00.
        val noCapacity = after(span(1, "2026-11-02", "2026-11-13", null), span(2, "2026-11-09", "2026-11-20", "30"))
        assertEquals(CapacitySkipReason.NO_CAPACITY, noCapacity[0].reason)
        assertEquals("2026-11-14", noCapacity[1].effectiveFrom)
        assertEquals(30.0, noCapacity[1].mdPerWeek)

        // ZERO_CAPACITY is still planned (and unticked); its days are held all the same.
        val zero = after(span(1, "2026-11-02", "2026-11-13", "0"), span(2, "2026-11-09", "2026-11-20", "30"))
        assertEquals(CapacityAction.CREATE, zero[0].action)
        assertEquals("2026-11-14", zero[1].effectiveFrom)

        // OUT_OF_RANGE: one working day 11-03 with 300,000 MD; the next sprint (11-03 15:00..11-06) holds 11-04..11-06:
        // W 3, 15 x 5 / 3 = 25.00.
        val outOfRange = after(
            sprint(1, at("2026-11-03"), at("2026-11-03", "17:00"), "300000"),
            sprint(2, at("2026-11-03", "15:00"), at("2026-11-06", "17:00"), "15"),
        )
        assertEquals(CapacitySkipReason.OUT_OF_RANGE, outOfRange[0].reason)
        assertEquals("2026-11-04", outOfRange[1].effectiveFrom)
        assertEquals(3, outOfRange[1].workingDays)
        assertEquals(25.0, outOfRange[1].mdPerWeek)

        // NO_WORKING_DAY: a Saturday-Sunday sprint 11-07..11-08; the next (11-08 12:00..11-13) holds 11-09..11-13: W 5, 10.00.
        val weekend = after(
            sprint(1, at("2026-11-07"), at("2026-11-08", "17:00"), "10"),
            sprint(2, at("2026-11-08", "12:00"), at("2026-11-13", "17:00"), "10"),
        )
        assertEquals(CapacitySkipReason.NO_WORKING_DAY, weekend[0].reason)
        assertEquals("2026-11-09", weekend[1].effectiveFrom)
        assertEquals(10.0, weekend[1].mdPerWeek)
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
    fun `a sprint wholly on the previous sprint's last day is an overlap - a partial one is held from the next day`() {
        val first = span(1, "2026-11-02", "2026-11-13", "40")
        val onLastDay = sprint(2, at("2026-11-13", "09:30"), at("2026-11-13", "16:00"), "5")
        val partial = sprint(3, at("2026-11-12"), at("2026-11-20", "17:00"), "30")

        // Wholly on 11-13: effectiveFrom 11-14 is past its end 11-13.
        val whole = plan(listOf(first, onLastDay))
        assertEquals(listOf(null, CapacitySkipReason.OVERLAPS), whole.items.map { it.reason })
        assertNull(whole.items[1].effectiveFrom)
        // Starting 11-12 and ending 11-20: held from 11-14, W 5 (11-16..11-20), 30.00 - no longer skipped.
        val part = plan(listOf(first, partial))
        assertEquals(listOf(null, null), part.items.map { it.reason })
        assertEquals("2026-11-14", part.items[1].effectiveFrom)
        assertEquals(5, part.items[1].workingDays)
        assertEquals(30.0, part.items[1].mdPerWeek)

        // All three in start order 1, 3, 2: 3 holds up to 11-20, so 2 is wholly inside (and the partial one stays held from 11-14).
        val all = plan(listOf(first, onLastDay, partial))
        assertEquals(listOf(1L, 3L, 2L), all.items.map { it.sprintId })
        assertEquals(listOf(null, null, CapacitySkipReason.OVERLAPS), all.items.map { it.reason })
    }

    @Test
    fun `the planned end first - a sprint completed early keeps its planned days, and the next sprint holds the days after them`() {
        // A: planned 11-02..11-13 (ends 11-13 17:00), completed 11-06 17:00; B starts that day. Neither is skipped.
        val a = completed(1, endAt = at("2026-11-13", "17:00"), completeAt = at("2026-11-06", "17:00"), md = "40")
        val b = sprint(2, at("2026-11-06", "17:30"), at("2026-11-20", "17:00"), "40")
        val result = plan(listOf(a, b))

        // A holds 11-02..11-13: W 10, 20.00. B holds 11-14..11-20: W 5 (11-16..11-20), 40.00.
        assertEquals(listOf("2026-11-13", "2026-11-20"), result.items.map { it.end })
        assertEquals(listOf("2026-11-02", "2026-11-14"), result.items.map { it.effectiveFrom })
        assertEquals(listOf(10, 5), result.items.map { it.workingDays })
        assertEquals(listOf(20.0, 40.0), result.items.map { it.mdPerWeek })
        assertTrue(result.items.all { it.reason == null })
        // completeAt later than endAt does not stretch the sprint.
        val late = completed(3, endAt = at("2026-11-06", "17:00"), completeAt = at("2026-11-13", "17:00"))
        assertEquals("2026-11-06", plan(listOf(late)).only().end)
        // completeAt alone stands in for a missing endAt.
        val alone = sprint(4, at("2026-11-02"), null, "40", completeAt = at("2026-11-13", "17:00"))
        assertEquals("2026-11-13", plan(listOf(alone)).only().end)
    }

    @Test
    fun `a sprint completed a day early - planned to 09-15, completed 09-14 - reads 10 working days and 20 00, next holds from 09-16`() {
        // A sprint completed the day before its planned end (Europe/Warsaw): started 2026-09-02, endAt 2026-09-15, completeAt 2026-09-14.
        // The 1.5.0 min rule read 9 working days / 22.22.
        val real = FlowMirrorSprint(
            801, 1, "Sprint A", "closed", at("2026-09-02", "10:00"), at("2026-09-15", "10:00"), at("2026-09-14", "16:00"),
            true, BigDecimal("40"), "CALENDAR",
        )
        // The next sprint starts on 09-15 (the shared day): it holds 09-16..09-29 - W 10, 40 x 5 / 10 = 20.00.
        val next = sprint(802, at("2026-09-15", "10:00"), at("2026-09-29", "10:00"), "40")
        val result = plan(listOf(real, next), today = LocalDate.of(2026, 8, 1))

        val first = result.items[0]
        assertEquals("2026-09-02", first.start)
        assertEquals("2026-09-15", first.end)
        assertEquals(10, first.workingDays)
        assertEquals(20.0, first.mdPerWeek)
        val second = result.items[1]
        assertEquals("2026-09-16", second.effectiveFrom)
        assertEquals("2026-09-29", second.end)
        assertEquals(10, second.workingDays)
        assertEquals(20.0, second.mdPerWeek)
    }

    @Test
    fun `the span rule has one home - each rule of spanEndOf has a vector`() {
        val planned = at("2026-11-13", "17:00")
        val completedAt = at("2026-11-06", "17:00")
        fun spanOf(end: Long?, complete: Long?) = spanEndOf(sprint(1, at("2026-11-02"), end, "40", completeAt = complete))

        assertEquals(planned, spanOf(planned, completedAt), "the planned end first, though the completion is earlier")
        assertEquals(completedAt, spanOf(completedAt, planned), "the planned end first, though the completion is later")
        assertEquals(completedAt, spanOf(null, completedAt), "a completion alone stands in for a missing planned end")
        assertEquals(planned, spanOf(planned, null))
        assertNull(spanOf(null, null), "neither end: no span (Flow's one-day fallback is not followed)")

        // And the kernel obeys it: a start with neither end is NO_DATES, with a completion alone it is planned.
        assertEquals(CapacitySkipReason.NO_DATES, plan(listOf(sprint(2, at("2026-11-02"), null, "40"))).only().reason)
        assertEquals(10, plan(listOf(sprint(3, at("2026-11-02"), null, "40", completeAt = at("2026-11-13", "17:00")))).only().workingDays)
    }

    @Test
    fun `a sprint over Flow's 60-day cap carries LONG_WINDOW, is unticked, and claims last - the days no other sprint holds`() {
        // A sprint whose planned end was mistyped a year and more out: 669 calendar days, 477 working days, 2,500 MD.
        val long = sprint(1, at("2025-11-01"), at("2027-08-31", "17:00"), "2500")
        val inside = span(2, "2025-12-01", "2025-12-12", "30")
        val result = plan(listOf(long, inside), today = LocalDate.of(2025, 10, 1))

        // The sprint inside it holds its own days (12-01..12-12: 10 working days), so the long one keeps 477 - 10 = 467 of them.
        val item = result.items[0]
        val days = WorkingCalendar.MON_FRI.workingDaysBetween(LocalDate.of(2025, 11, 1), LocalDate.of(2027, 8, 31))
        assertEquals(477L, days)
        assertEquals(467, item.workingDays)
        assertEquals("2025-11-01", item.effectiveFrom, "the first day no other sprint holds (a Saturday: a period may start on any date)")
        val exact = BigDecimal("5").multiply(BigDecimal("2500")).divide(BigDecimal(467), 2, RoundingMode.HALF_UP)
        assertEquals(exact.toDouble(), item.mdPerWeek)
        assertEquals(26.77, item.mdPerWeek)
        assertEquals(CapacityAction.CREATE, item.action)
        assertEquals(listOf(CapacityInfoCode.LONG_WINDOW), item.infos.map { it.code })
        assertNull(item.infos.single().date)
        assertFalse(item.ticked, "a long window is listed but never preselected")
        // It claims LAST: the sprint inside it keeps all its days and its own figure, as if the long one were absent.
        assertNull(result.items[1].reason)
        assertEquals("2025-12-01", result.items[1].effectiveFrom)
        assertEquals(10, result.items[1].workingDays)
        assertEquals(15.0, result.items[1].mdPerWeek)
        assertTrue(result.items[1].infos.isEmpty())
        assertTrue(result.items[1].ticked)

        // The cap is 60 calendar days, inclusive: 11-02..12-31 is exactly 60 (no info, ticked), 11-02..2027-01-01 is 61.
        assertEquals(60, FLOW_MAX_CALENDAR_DAYS)
        val sixty = plan(listOf(span(3, "2026-11-02", "2026-12-31", "40"))).only()
        assertTrue(sixty.infos.isEmpty())
        assertTrue(sixty.ticked)
        val sixtyOne = plan(listOf(span(4, "2026-11-02", "2027-01-01", "40"))).only()
        assertEquals(listOf(CapacityInfoCode.LONG_WINDOW), sixtyOne.infos.map { it.code })
        assertFalse(sixtyOne.ticked)

        // The note travels on skipped rows too (a long window without capacity), and an UPDATE stays unticked.
        val skipped = plan(listOf(span(5, "2026-11-02", "2027-01-01", null))).only()
        assertEquals(CapacitySkipReason.NO_CAPACITY, skipped.reason)
        assertEquals(listOf(CapacityInfoCode.LONG_WINDOW), skipped.infos.map { it.code })
        val flowPeriod = period(1, "2026-11-02", "1", CapacitySource.FLOW, 4, "Sprint 4")
        val update = plan(listOf(span(4, "2026-11-02", "2027-01-01", "40")), listOf(flowPeriod)).only()
        assertEquals(CapacityAction.UPDATE, update.action)
        assertFalse(update.ticked)
    }

    @Test
    fun `a mistyped far end claims last, so the two-week sprints inside it keep their days`() {
        // Sprint 701 (DEFAULT, 1,200 MD, Tue 2025-10-21..Wed 2027-08-25) is followed by two-week DEFAULT sprints; Flow 1.57.1 lets them
        // claim first. The calendar has 11-11 in both years (2025-11-11, 2026-11-11), nothing else.
        val calendar = WorkingCalendar(
            mapOf(LocalDate.of(2025, 11, 11) to "Independence Day", LocalDate.of(2026, 11, 11) to "Independence Day"),
        )
        val long = sprint(701, at("2025-10-21"), at("2027-08-25", "17:00"), "1200", source = "DEFAULT")
        val first = sprint(702, at("2025-11-13"), at("2025-12-03", "17:00"), "60", source = "DEFAULT")
        val active = sprint(703, at("2026-11-05"), at("2026-11-18", "17:00"), "45", source = "DEFAULT")
        val result = plan(listOf(active, first, long), calendar = calendar, today = LocalDate.of(2025, 10, 1))

        assertEquals(listOf(701L, 702L, 703L), result.items.map { it.sprintId })
        val (l, a, b) = result.items
        // 702: Thu 11-13..Wed 12-03 is 15 working days, 5 x 60 / 15 = 20.00.
        assertEquals(listOf("2025-11-13", 15, 20.0, null), listOf(a.effectiveFrom, a.workingDays, a.mdPerWeek, a.reason))
        // 703: Thu 11-05..Wed 11-18 is 9 working days (11-11 is a holiday), 5 x 45 / 9 = 25.00.
        assertEquals(listOf("2026-11-05", 9, 25.0, null), listOf(b.effectiveFrom, b.workingDays, b.mdPerWeek, b.reason))
        assertTrue(a.ticked && b.ticked && a.infos.isEmpty() && b.infos.isEmpty())
        // 701: 480 working days in its window (2 holidays), less the 15 and 9 the others hold: 456; 5 x 1,200 / 456 = 13.16. With more
        // two-week sprints inside the window the long one would keep fewer days.
        assertEquals(480L, calendar.workingDaysBetween(LocalDate.of(2025, 10, 21), LocalDate.of(2027, 8, 25)))
        assertEquals(listOf("2025-10-21", 456, 13.16, null), listOf(l.effectiveFrom, l.workingDays, l.mdPerWeek, l.reason))
        assertEquals(listOf(CapacityInfoCode.LONG_WINDOW), l.infos.map { it.code })
        assertEquals(CapacityAction.CREATE, l.action)
        assertFalse(l.ticked)
        assertEquals(listOf(3, 0, 0, 0, 0), result.totals().let { listOf(it.create, it.update, it.unchanged, it.skip, it.removals) })
    }

    @Test
    fun `a long window wholly covered by sprints within the cap is OVERLAPS - nothing left to claim`() {
        val a = span(1, "2025-11-03", "2025-12-31", "40")
        val b = span(2, "2025-12-15", "2026-01-30", "30")
        val long = span(9, "2025-11-03", "2026-01-30", "90")
        val result = plan(listOf(a, b, long), today = LocalDate.of(2025, 10, 1))

        assertEquals(listOf(1L, 9L, 2L), result.items.map { it.sprintId })
        // B still starts after A's end (the long one advances nothing): 2026-01-01..01-30 is 22 working days.
        assertEquals("2026-01-01", result.items[2].effectiveFrom)
        assertEquals(22, result.items[2].workingDays)
        val item = result.items[1]
        assertEquals(CapacitySkipReason.OVERLAPS, item.reason)
        assertEquals(CapacityAction.SKIP, item.action)
        assertNull(item.effectiveFrom)
        assertNull(item.workingDays)
        assertNull(item.mdPerWeek)
        assertEquals(listOf(CapacityInfoCode.LONG_WINDOW), item.infos.map { it.code })
        assertFalse(item.ticked)
    }

    @Test
    fun `two overlapping long windows - the earlier by start claims first, the later keeps the rest`() {
        val first = span(2, "2025-11-03", "2026-02-27", "100")
        val second = span(1, "2025-12-01", "2026-04-30", "88")
        val result = plan(listOf(second, first), today = LocalDate.of(2025, 10, 1))

        assertEquals(listOf(2L, 1L), result.items.map { it.sprintId })
        val (a, b) = result.items
        // The first holds its whole window: 11-03..02-27 is 85 working days. The second keeps Sat 02-28..04-30: 44 working days.
        assertEquals(listOf("2025-11-03", 85, 5.88), listOf(a.effectiveFrom, a.workingDays, a.mdPerWeek))
        assertEquals(listOf("2026-02-28", 44, 10.0), listOf(b.effectiveFrom, b.workingDays, b.mdPerWeek))
        assertTrue(a.infos.any { it.code == CapacityInfoCode.LONG_WINDOW } && b.infos.any { it.code == CapacityInfoCode.LONG_WINDOW })
        assertFalse(a.ticked || b.ticked)
    }

    @Test
    fun `an in-cap sprint that starts before a long window and one inside it - the long one gets only the rest, in two runs`() {
        val before = span(1, "2025-10-20", "2025-11-14", "40")
        val long = span(2, "2025-11-03", "2026-02-27", "130")
        val inside = span(3, "2026-01-05", "2026-01-16", "20")
        val result = plan(listOf(inside, long, before), today = LocalDate.of(2025, 10, 1))

        assertEquals(listOf(1L, 2L, 3L), result.items.map { it.sprintId })
        val (b, l, i) = result.items
        assertEquals(listOf("2025-10-20", 20, null), listOf(b.effectiveFrom, b.workingDays, b.reason))
        // The sprint inside the long one keeps its own days.
        assertEquals(listOf("2026-01-05", 10, 10.0, null), listOf(i.effectiveFrom, i.workingDays, i.mdPerWeek, i.reason))
        // The long one: from Sat 11-15, the runs 11-15..01-04 (35 working days) and 01-17..02-27 (30) = 65; 5 x 130 / 65 = 10.00.
        assertEquals(listOf("2025-11-15", 65, 10.0, null), listOf(l.effectiveFrom, l.workingDays, l.mdPerWeek, l.reason))
        assertFalse(l.ticked)
    }

    @Test
    fun `periods imported under the 1 5 0 rule re-preview as a removal and a create when the window grew`() {
        // 1.5.0 read A (planned 11-13, completed 11-06) as 11-02..11-06 (W 5, 40 MD = 40.00) and B as held from 11-07 (W 10, 20.00).
        val a = completed(1, endAt = at("2026-11-13", "17:00"), completeAt = at("2026-11-06", "17:00"), md = "40")
        val b = sprint(2, at("2026-11-06", "17:30"), at("2026-11-20", "17:00"), "40")
        val old = listOf(
            period(1, "2026-11-02", "40.00", CapacitySource.FLOW, 1, "Sprint 1"),
            period(2, "2026-11-07", "20.00", CapacitySource.FLOW, 2, "Sprint 2"),
            period(3, "2026-11-09", "9", CapacitySource.MANUAL),
        )
        val result = plan(listOf(a, b), old, today = LocalDate.of(2026, 11, 1))

        // A is the same period at a new figure (10 working days, 20.00); B now holds from 11-14 with nothing there: a CREATE.
        assertEquals(listOf(CapacityAction.UPDATE, CapacityAction.CREATE), result.items.map { it.action })
        assertEquals(listOf("2026-11-02", "2026-11-14"), result.items.map { it.effectiveFrom })
        assertEquals(40.0, result.items[0].existing?.mdPerWeek)
        assertEquals(20.0, result.items[0].mdPerWeek)
        // The stale FLOW period of B is offered for removal; the hand-entered one inside A is never offered (only an info).
        assertEquals(listOf(2u), result.removals.map { it.periodId })
        assertEquals(listOf("2026-11-09"), result.items[0].infos.map { it.date })
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
        // A listed sprint owns its old period whatever its skip reason (here NO_CAPACITY, which moved: its old-date period is offered, a
        // period at its CURRENT start is kept as the last good figure); a closed sprint hidden by the toggle is history.
        val noCapacity = listOf(span(1, "2026-11-16", "2026-11-27", null))
        assertEquals(listOf(1u), plan(noCapacity, old).removals.map { it.periodId })
        val atStart = listOf(period(2, "2026-11-16", "18", CapacitySource.FLOW, 1, "Sprint 1"))
        assertEquals(emptyList(), plan(noCapacity, atStart).removals)
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
        // Sprint 2 (start only, lower id) stays NO_DATES but holds its start day 11-02, as in Flow (`end ?: complete ?: start`), so
        // sprint 5 (same start, completion 11-13) holds 11-03..11-13: 9 working days, 40 x 5 / 9 = 22.22. Sprint 3 (inverted) holds 11-13.
        assertEquals(CapacityAction.CREATE, byId.getValue(5L).action)
        assertEquals("2026-11-13", byId.getValue(5L).end)
        assertEquals("2026-11-03", byId.getValue(5L).effectiveFrom)
        assertEquals(9, byId.getValue(5L).workingDays)
        assertEquals(22.22, byId.getValue(5L).mdPerWeek)
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
    fun `the days are claimed by the dates alone - a hidden closed sprint still holds its days, the open one is held from the day after`() {
        val sprints = listOf(span(1, "2026-11-02", "2026-11-13", "40"), span(2, "2026-11-09", "2026-11-24", "30"))
        val today = LocalDate.of(2026, 11, 20)

        // 2 starts inside the closed 1: held from 11-14, W 7 (11-16..11-20, 11-23, 11-24), 30 x 5 / 7 = 21.43 - not skipped.
        val hidden = plan(sprints, today = today)
        assertEquals(listOf(2L), hidden.items.map { it.sprintId })
        assertNull(hidden.only().reason)
        assertEquals("2026-11-14", hidden.only().effectiveFrom)
        assertEquals(7, hidden.only().workingDays)
        assertEquals(21.43, hidden.only().mdPerWeek)
        assertTrue(hidden.only().ticked)
        val shown = plan(sprints, today = today, includeClosed = true)
        assertEquals("2026-11-14", shown.items[1].effectiveFrom)
        assertEquals(listOf(false, true), shown.items.map { it.ticked })
    }

    @Test
    fun `a stale Flow period of a closed sprint is history while hidden - and offered for removal once the sprint is listed`() {
        val sprints = listOf(span(1, "2026-11-02", "2026-11-13", "40"))
        val stale = listOf(period(1, "2026-11-09", "9", CapacitySource.FLOW, 1, "Sprint 1"))
        val today = LocalDate.of(2026, 11, 20)

        assertEquals(emptyList(), plan(sprints, stale, today = today).removals, "closed and hidden: its history is left alone")
        val listed = plan(sprints, stale, today = today, includeClosed = true)
        assertEquals(listOf(1u), listed.removals.map { it.periodId }, "(c): a listed sprint's other period")
        assertEquals(listOf(1u), plan(sprints, stale).removals.map { it.periodId }, "the same data, not closed: removed")
    }

    @Test
    fun `a period imported under 1 5 0 for a sprint that is now closed is offered for removal once closed sprints are listed`() {
        val a = completed(1, endAt = at("2026-11-13", "17:00"), completeAt = at("2026-11-06", "17:00"), md = "40")
        val b = sprint(2, at("2026-11-06", "17:30"), at("2026-11-20", "17:00"), "40")
        val old = listOf(
            period(1, "2026-11-02", "20.00", CapacitySource.FLOW, 1, "Sprint 1"),
            period(2, "2026-11-07", "20.00", CapacitySource.FLOW, 2, "Sprint 2"),
        )
        val today = LocalDate.of(2026, 11, 23)

        // Both sprints are closed (ends 11-13 and 11-20): B holds 11-14..11-20 now, so its 11-07 period is stale.
        val shown = plan(listOf(a, b), old, today = today, includeClosed = true)
        assertEquals(listOf(CapacityAction.UNCHANGED, CapacityAction.CREATE), shown.items.map { it.action })
        assertEquals(listOf(2u), shown.removals.map { it.periodId })
        assertEquals(emptyList(), plan(listOf(a, b), old, today = today).removals, "hidden closed sprints: history")
    }

    @Test
    fun `a refused long window loses its start day to an in-cap sprint - it reuses the old period, the new first day keeps its own`() {
        // L (id 1, no capacity, 11-03..02-27) is refused; S (id 2, same start, 11-03..11-14) claims first, despite its higher id, and holds
        // the start day, so L's first day left is Sat 11-15. L's old FLOW period at 11-03 is S's to reuse (an UPDATE: another sprint id);
        // the FLOW period at 11-15 is the refused row's own, kept as the last good figure.
        val long = span(1, "2025-11-03", "2026-02-27", null)
        val short = span(2, "2025-11-03", "2025-11-14", "40")
        val result = plan(
            listOf(short, long),
            listOf(
                period(1, "2025-11-03", "20.00", CapacitySource.FLOW, 1, "Sprint 1"),
                period(2, "2025-11-15", "5", CapacitySource.FLOW, 1, "Sprint 1"),
            ),
            today = LocalDate.of(2025, 10, 1),
        )

        assertEquals(listOf(1L, 2L), result.items.map { it.sprintId })
        val (l, s) = result.items
        assertEquals(listOf(CapacitySkipReason.NO_CAPACITY, "2025-11-15"), listOf(l.reason, l.effectiveFrom))
        assertEquals(listOf(CapacityAction.UPDATE, "2025-11-03", 1u), listOf(s.action, s.effectiveFrom, s.existing?.periodId))
        assertEquals(emptyList(), result.removals)
    }

    @Test
    fun `a long window whose only leftover is a weekend is NO_WORKING_DAY, from the Saturday`() {
        // A (11-02..12-31, exactly 60 days) and B (2027-01-01..01-29) hold everything but Sat 01-30 and Sun 01-31 of the long window.
        val first = span(1, "2026-11-02", "2026-12-31", "40")
        val second = span(2, "2027-01-01", "2027-01-29", "40")
        val long = sprint(9, at("2026-11-02"), at("2027-01-31", "17:00"), "50")
        val result = plan(listOf(long, second, first))

        assertEquals(listOf(1L, 9L, 2L), result.items.map { it.sprintId })
        val item = result.items[1]
        assertEquals(CapacitySkipReason.NO_WORKING_DAY, item.reason)
        assertEquals("2027-01-30", item.effectiveFrom)
        assertEquals(0, item.workingDays)
        assertNull(item.mdPerWeek)
        assertEquals(listOf(CapacityInfoCode.LONG_WINDOW), item.infos.map { it.code })
        assertFalse(item.ticked)
    }

    @Test
    fun `two long windows with the same start - the lower id claims first`() {
        val low = span(3, "2025-11-03", "2026-02-27", "100")
        val high = span(7, "2025-11-03", "2026-04-30", "88")
        val result = plan(listOf(high, low), today = LocalDate.of(2025, 10, 1))

        assertEquals(listOf(3L, 7L), result.items.map { it.sprintId })
        val (a, b) = result.items
        assertEquals(listOf("2025-11-03", 85, 5.88), listOf(a.effectiveFrom, a.workingDays, a.mdPerWeek))
        // The higher id keeps only what the lower one left: Sat 02-28..04-30, 44 working days.
        assertEquals(listOf("2026-02-28", 44, 10.0), listOf(b.effectiveFrom, b.workingDays, b.mdPerWeek))
    }

    @Test
    fun `a start-only sprint inside a long window holds its start day and splits the leftover by exactly that day`() {
        val long = span(1, "2025-11-03", "2026-02-27", "130")
        val startOnly = sprint(2, at("2026-01-14"), null, "40")
        val result = plan(listOf(long, startOnly), today = LocalDate.of(2025, 10, 1))

        assertEquals(CapacitySkipReason.NO_DATES, result.items[1].reason)
        // 85 working days in the window less Wed 01-14: 84 (11-03..01-13 and 01-15..02-27); 5 x 130 / 84 = 7.74.
        assertEquals(listOf("2025-11-03", 84, 7.74), result.items[0].let { listOf(it.effectiveFrom, it.workingDays, it.mdPerWeek) })
    }

    @Test
    fun `the old Flow period of a sprint that now holds no day is offered for removal - a hand-entered one never`() {
        // Sprint 2 (with capacity) lies wholly inside sprint 1: it holds no day, and its ownership of its old period (rule (c)) offers
        // it. Sprint 1 has no capacity, so it is refused and covers nothing: rule (b) cannot offer the period, only (c) can.
        // 1.5.0 had imported sprint 2 at 2025-12-01; a person entered 2025-12-02.
        val outer = span(1, "2025-11-03", "2025-12-26", null)
        val inner = span(2, "2025-12-01", "2025-12-12", "30")
        val result = plan(
            listOf(outer, inner),
            listOf(
                period(1, "2025-12-01", "14.29", CapacitySource.FLOW, 2, "Sprint 2"),
                period(2, "2025-12-02", "9", CapacitySource.MANUAL),
            ),
            today = LocalDate.of(2025, 10, 1),
        )

        assertEquals(CapacitySkipReason.OVERLAPS, result.items[1].reason)
        assertEquals(listOf(1u), result.removals.map { it.periodId })
    }

    @Test
    fun `every listed sprint owns its old Flow periods - a weekend sprint after a long window, a moved sprint on a manual period`() {
        // L (long window, Sat 2025-11-01..Fri 2027-08-27) claims last and covers nothing. P (Mon 08-23..Fri 09-03, no capacity) is refused,
        // so it covers nothing either. X (Thu 09-02..Sun 09-05) holds only 09-04..09-05: NO_WORKING_DAY; its period at 09-02 is stale.
        val long = sprint(1, at("2025-11-01"), at("2027-08-27", "17:00"), "2500")
        val earlier = span(3, "2027-08-23", "2027-09-03", null)
        val weekend = sprint(2, at("2027-09-02"), at("2027-09-05", "17:00"), "5")
        val atStart = listOf(period(1, "2027-09-02", "5", CapacitySource.FLOW, 2, "Sprint 2"))
        val noDay = plan(listOf(long, earlier, weekend), atStart, today = LocalDate.of(2025, 10, 1))
        assertEquals(CapacitySkipReason.NO_WORKING_DAY, noDay.items[2].reason)
        assertEquals(listOf(1u), noDay.removals.map { it.periodId })

        // A closed and listed (11-23, includeClosed): B moved from 11-07 to 11-14, where a MANUAL period sits, so B is MANUAL_PERIOD.
        val a = completed(1, endAt = at("2026-11-13", "17:00"), completeAt = at("2026-11-06", "17:00"), md = "40")
        val b = sprint(2, at("2026-11-06", "17:30"), at("2026-11-20", "17:00"), "40")
        val old = listOf(
            period(1, "2026-11-02", "20.00", CapacitySource.FLOW, 1, "Sprint 1"),
            period(2, "2026-11-07", "20.00", CapacitySource.FLOW, 2, "Sprint 2"),
            period(3, "2026-11-14", "9", CapacitySource.MANUAL),
        )
        val moved = plan(listOf(a, b), old, today = LocalDate.of(2026, 11, 23), includeClosed = true)
        assertEquals(CapacityAction.MANUAL_PERIOD, moved.items[1].action)
        assertEquals(listOf(2u), moved.removals.map { it.periodId }, "B's stale FLOW period only - the manual one is never offered")
    }

    @Test
    fun `a long window does not cover its span - a hidden sprint's Flow period inside it is not offered for removal`() {
        // Sprint 2 (2025-12-01..12-12) is closed and hidden (today 12-20); its FLOW period (12-02, not its own first day, so no refused
        // row keeps it) lies inside the 669-day sprint 1: rule (b) does not apply to a long window, and a hidden sprint owns nothing.
        // Listed (includeClosed), it owns its period.
        val long = sprint(1, at("2025-11-01"), at("2027-08-31", "17:00"), "2500")
        val inner = span(2, "2025-12-01", "2025-12-12", null)
        val inside = listOf(period(1, "2025-12-02", "5", CapacitySource.FLOW, 2, "Sprint 2"))
        val today = LocalDate.of(2025, 12, 20)
        assertEquals(emptyList(), plan(listOf(long, inner), inside, today = today).removals)
        assertEquals(listOf(1u), plan(listOf(long, inner), inside, today = today, includeClosed = true).removals.map { it.periodId })

        // The same shape under the cap (11-02..12-31, exactly 60 days) covers: the hidden sprint's period inside it is offered (rule (b)).
        val sixty = span(1, "2026-11-02", "2026-12-31", "40")
        val innerSixty = span(2, "2026-11-16", "2026-11-20", null)
        val insideSixty = listOf(period(1, "2026-11-16", "5", CapacitySource.FLOW, 2, "Sprint 2"))
        val removals = plan(listOf(sixty, innerSixty), insideSixty, today = LocalDate.of(2026, 11, 25)).removals
        assertEquals(listOf(1u), removals.map { it.periodId })
    }

    @Test
    fun `a refused row keeps the Flow period at its own start - the last good figure - and its other old periods are offered`() {
        val old = listOf(
            period(1, "2026-11-02", "20.00", CapacitySource.FLOW, 1, "Sprint 1"),
            period(2, "2026-11-16", "20.00", CapacitySource.FLOW, 1, "Sprint 1"),
        )
        // OUT_OF_RANGE: one working day (11-16) with 300,000 MD cannot be computed, so the 11-16 period stays; 11-02 is stale.
        val outOfRange = plan(listOf(sprint(1, at("2026-11-16"), at("2026-11-16", "17:00"), "300000")), old)
        assertEquals(CapacitySkipReason.OUT_OF_RANGE, outOfRange.only().reason)
        assertEquals(listOf(1u), outOfRange.removals.map { it.periodId })
        // NO_CAPACITY: the same.
        val noCapacity = plan(listOf(span(1, "2026-11-16", "2026-11-27", null)), old)
        assertEquals(CapacitySkipReason.NO_CAPACITY, noCapacity.only().reason)
        assertEquals(listOf(1u), noCapacity.removals.map { it.periodId })
        // NO_WORKING_DAY: a weekend sprint keeps the period at its start; NO_DATES (a start only) the one carrying its sprint id there.
        val weekend = plan(listOf(sprint(1, at("2026-11-07"), at("2026-11-08", "17:00"), "10")), listOf(
            period(1, "2026-11-07", "5", CapacitySource.FLOW, 1, "Sprint 1"),
            period(2, "2026-11-02", "5", CapacitySource.FLOW, 1, "Sprint 1"),
        ))
        assertEquals(CapacitySkipReason.NO_WORKING_DAY, weekend.only().reason)
        assertEquals(listOf(2u), weekend.removals.map { it.periodId })
        val noDates = plan(listOf(sprint(1, at("2026-11-16"), null, "40")), old)
        assertEquals(CapacitySkipReason.NO_DATES, noDates.only().reason)
        assertEquals(listOf(1u), noDates.removals.map { it.periodId })
        // OVERLAPS holds no day and keeps nothing; the outer sprint has no capacity and covers nothing, so only rule (c) offers it.
        val inside = plan(
            listOf(span(1, "2026-11-02", "2026-11-27", null), span(2, "2026-11-16", "2026-11-20", "10")),
            listOf(period(1, "2026-11-16", "5", CapacitySource.FLOW, 2, "Sprint 2")),
        )
        assertEquals(CapacitySkipReason.OVERLAPS, inside.items[1].reason)
        assertEquals(listOf(1u), inside.removals.map { it.periodId })
    }

    @Test
    fun `a TEAM_DEFAULT sprint is a fixed figure - it spreads over the working days of its own window, not the days it holds`() {
        // After 11-02..11-13, a TEAM_DEFAULT sprint 11-09..11-20 (40 MD) holds 11-14..11-20 (W 5) but its window has 10 working
        // days: 20.00.
        val after = plan(
            listOf(
                span(1, "2026-11-02", "2026-11-13", "40"),
                sprint(2, at("2026-11-09"), at("2026-11-20", "17:00"), "40", source = "TEAM_DEFAULT"),
            ),
        )
        assertEquals("2026-11-14", after.items[1].effectiveFrom)
        assertEquals(5, after.items[1].workingDays, "the row still counts the days it holds")
        assertEquals(20.0, after.items[1].mdPerWeek)
        // It says so: FIXED_FIGURE with the window's 10 working days (a sprint holding its whole window, or a CALENDAR one, does not).
        assertEquals(listOf(CapacityInfoCode.FIXED_FIGURE to 10), after.items[1].infos.map { it.code to it.days })
        assertNull(after.items[1].infos.single().date)
        assertTrue(after.items[0].infos.isEmpty())
        val whole = plan(listOf(sprint(1, at("2026-11-02"), at("2026-11-13", "17:00"), "40", source = "TEAM_DEFAULT"))).only()
        assertTrue(whole.infos.isEmpty(), "the whole window is held: nothing to explain")
        // The legacy CONFIGURED source is the same fixed per-sprint total.
        val configured = plan(
            listOf(
                span(1, "2026-11-02", "2026-11-13", "40"),
                sprint(2, at("2026-11-09"), at("2026-11-20", "17:00"), "40", source = "CONFIGURED"),
            ),
        ).items[1]
        assertEquals(20.0, configured.mdPerWeek)
        assertEquals(listOf(CapacityInfoCode.FIXED_FIGURE to 10), configured.infos.map { it.code to it.days })
        // The same sprint with a CALENDAR source spreads its total over the 5 days it holds: 40.00.
        val calendar = plan(listOf(span(1, "2026-11-02", "2026-11-13", "40"), span(2, "2026-11-09", "2026-11-20", "40")))
        assertEquals(40.0, calendar.items[1].mdPerWeek)

        // A shared boundary day: S1 ends Monday 11-02, S2 is TEAM_DEFAULT Mon 11-02..Mon 11-16 (44 MD): it holds 11-03..11-16 (W 10), but
        // its own window has 11 working days: 44 x 5 / 11 = 20.00 (a CALENDAR sprint would read 44 x 5 / 10 = 22.00).
        fun sharedDay(source: String) = plan(
            listOf(
                sprint(1, at("2026-10-19", "10:00"), at("2026-11-02", "10:00"), "40"),
                sprint(2, at("2026-11-02", "10:00"), at("2026-11-16", "10:00"), "44", source = source),
            ),
            today = LocalDate.of(2026, 10, 1),
        ).items[1]
        val shared = sharedDay("TEAM_DEFAULT")
        assertEquals("2026-11-03", shared.effectiveFrom)
        assertEquals(10, shared.workingDays)
        assertEquals(20.0, shared.mdPerWeek)
        assertEquals(22.0, sharedDay("CALENDAR").mdPerWeek)
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
