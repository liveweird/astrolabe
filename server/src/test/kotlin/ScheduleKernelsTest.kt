package ch.nokillswit

import ch.nokillswit.infra.time.WorkingCalendar
import ch.nokillswit.planning.CapacityPeriod
import ch.nokillswit.planning.DaySpan
import ch.nokillswit.planning.DependencyStatus
import ch.nokillswit.planning.DependencyType
import ch.nokillswit.planning.EndpointKind
import ch.nokillswit.planning.EndpointRef
import ch.nokillswit.planning.OrderKey
import ch.nokillswit.planning.PlanLinkFact
import ch.nokillswit.planning.PlanMilestoneFact
import ch.nokillswit.planning.ScheduleInputs
import ch.nokillswit.planning.ScheduleKernels
import ch.nokillswit.planning.ScheduleProposalResult
import ch.nokillswit.planning.TeamScheduleItem
import ch.nokillswit.planning.UnplacedReason
import ch.nokillswit.planning.WeekLoad
import java.math.BigDecimal
import java.time.LocalDate
import kotlin.random.Random
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * The auto-proposal's scheduling kernel as a pure function (no server, no database); every figure is counted by hand.
 *
 * 2027-02-01 is a Monday, so a working day reads (`dN` = the Nth working day from it): d1 Mon 02-01, d2 Tue 02-02, d3 Wed 02-03,
 * d4 Thu 02-04, d5 Fri 02-05, d6 Mon 02-08 ... d10 Fri 02-12, d11 Mon 02-15. The team's capacity is 10 MD/week from 2027-01-04 (a
 * daily capacity of 2.000), `asOf` is Sunday 2027-01-31 so the first candidate day is d1, and the calendar is `MON_FRI` unless a
 * holiday is named. With a WIP limit of 2 the share of a day is 1 MD, without a limit 2 MD. Milestones of the team are `teamId` 1;
 * ids below 50 are the team's, 50+ belong to other teams. Dates print as `MM-DD` (all in 2027) unless the test says otherwise.
 */
class ScheduleKernelsTest {
    private val team = 1u
    private val other = 2u
    private val fs = DependencyType.FS

    private fun d(text: String) = LocalDate.parse(text)

    private fun span(start: String, end: String = start) = DaySpan(d(start), d(end))

    private fun periods(wip: Int? = null, from: String = "2027-01-04", mdPerWeek: String = "10") =
        listOf(CapacityPeriod(d(from), BigDecimal(mdPerWeek), wip))

    private fun item(
        id: UInt,
        md: String,
        start: String? = null,
        end: String? = start,
        project: UInt = 1u,
        pos: Int? = null,
        pinned: Boolean = false,
    ) = TeamScheduleItem(
        id,
        project,
        start?.let { span(it, checkNotNull(end)) },
        BigDecimal(md),
        OrderKey(pos, null, "P$project", project, start?.let(::d), end?.let(::d), "m%03d".format(id.toInt()), id),
        pinned,
    )

    private fun fact(id: UInt, project: UInt, teamId: UInt, start: String? = null, end: String? = start) =
        PlanMilestoneFact(id, project, teamId, start?.let { span(it, checkNotNull(end)) })

    private fun ms(id: UInt) = EndpointRef(EndpointKind.MILESTONE, id)

    private fun pr(id: UInt) = EndpointRef(EndpointKind.PROJECT, id)

    private fun link(id: UInt, pred: EndpointRef, succ: EndpointRef, type: DependencyType = fs, lag: Int = 0) =
        PlanLinkFact(id, pred, succ, type, lag)

    private fun inputs(
        items: List<TeamScheduleItem>,
        periods: List<CapacityPeriod> = periods(),
        others: List<PlanMilestoneFact> = emptyList(),
        links: List<PlanLinkFact> = emptyList(),
        asOf: String = "2027-01-31",
        calendar: WorkingCalendar = WorkingCalendar.MON_FRI,
        horizonWeeks: Int = 520,
    ) = ScheduleInputs(
        d(asOf),
        team,
        items,
        periods,
        others + items.map { PlanMilestoneFact(it.id, it.projectId, team, it.span) },
        links,
        calendar,
        horizonWeeks,
    )

    private fun run(
        items: List<TeamScheduleItem>,
        periods: List<CapacityPeriod> = periods(),
        others: List<PlanMilestoneFact> = emptyList(),
        links: List<PlanLinkFact> = emptyList(),
        asOf: String = "2027-01-31",
        calendar: WorkingCalendar = WorkingCalendar.MON_FRI,
    ) = ScheduleKernels.propose(inputs(items, periods, others, links, asOf, calendar))

    /** `id -> "MM-DD..MM-DD"`, the proposed span of each placed milestone. */
    private fun ScheduleProposalResult.spans(): Map<UInt, String> =
        placements.associate { it.milestoneId to "${it.to.start.toString().drop(5)}..${it.to.end.toString().drop(5)}" }

    private fun List<WeekLoad>.week(monday: String) = single { it.weekStart == d(monday) }

    // ---- the plan's vectors, in order -------------------------------------------------------------------------------------------

    @Test
    fun `three man-days take three days under WIP 2 and two days without a limit`() {
        assertEquals(mapOf(1u to "02-01..02-03"), run(listOf(item(1u, "3")), periods(wip = 2)).spans())
        assertEquals(mapOf(1u to "02-01..02-02"), run(listOf(item(1u, "3"))).spans())
    }

    @Test
    fun `a zero man-day milestone takes one working day and counts for WIP that day`() {
        assertEquals(mapOf(1u to "02-01..02-01"), run(listOf(item(1u, "0"))).spans())
        // WIP 1: the first checkpoint is in progress on d1, so the second takes d2.
        assertEquals(mapOf(1u to "02-01..02-01", 2u to "02-02..02-02"), run(listOf(item(1u, "0"), item(2u, "0")), periods(wip = 1)).spans())
    }

    @Test
    fun `asOf decides the first candidate day and which milestones are fixed`() {
        // asOf Monday 02-01: the first candidate is Tuesday 02-02. F (started 02-01) is in progress and fixed (1 MD a day, 1 in progress);
        // G (02-02..02-03) is movable. WIP 2 (share 1): G takes d2 alone (F 1 + G 1 = 2 of 2), H (unscheduled, 3 MD) waits for d3.
        val items = listOf(item(1u, "5", "2027-02-01", "2027-02-05"), item(2u, "1", "2027-02-02", "2027-02-03"), item(3u, "3"))
        val result = run(items, periods(wip = 2), asOf = "2027-02-01")
        assertEquals(mapOf(2u to "02-02..02-02", 3u to "02-03..02-05"), result.spans())
        assertEquals(span("2027-02-02", "2027-02-03"), result.placements.first { it.milestoneId == 2u }.from)
        assertNull(result.placements.first { it.milestoneId == 3u }.from)
        assertTrue(1u in result.spansAfter && result.placements.none { it.milestoneId == 1u })
        // The same milestones with asOf Sunday 01-31 are ALL movable: F is no longer fixed.
        assertEquals(setOf(1u, 2u, 3u), run(items, periods(wip = 2)).spans().keys)
    }

    @Test
    fun `a pinned future milestone is fixed - its dates stand, its load is booked and an unpinned twin moves`() {
        // Q (4 MD, first in order) and P (4 MD, stored 02-01..02-02 = the days d1-d2 at the full 2/day) with asOf Sunday 01-31: both start
        // AFTER asOf, so both are movable until P is pinned. Unpinned: Q re-plans first onto d1-d2 and P moves behind it.
        val unpinned = run(listOf(item(1u, "4", pos = 1), item(2u, "4", "2027-02-01", "2027-02-02", pos = 2)))
        assertEquals(mapOf(1u to "02-01..02-02", 2u to "02-03..02-04"), unpinned.spans())
        assertTrue(unpinned.placements.single { it.milestoneId == 2u }.to != unpinned.placements.single { it.milestoneId == 2u }.from)
        // Pinned: P is fixed on d1-d2 (booked at 2/day, the days are full), so Q takes d3-d4 and P is no placement at all.
        val pinned = run(listOf(item(1u, "4", pos = 1), item(2u, "4", "2027-02-01", "2027-02-02", pos = 2, pinned = true)))
        assertEquals(mapOf(1u to "02-03..02-04"), pinned.spans())
        assertEquals(span("2027-02-01", "2027-02-02"), pinned.spansAfter.getValue(2u), "the pinned dates stand in the result")
        assertTrue(pinned.unplaced.isEmpty())
    }

    @Test
    fun `a pinned predecessor's stored dates bound an FS successor like another team's milestone`() {
        // P pinned far ahead (02-15..02-16), S waits for it (FS): S starts the working day after P ends, d(02-17), not at the first day.
        val items = listOf(item(1u, "4", "2027-02-15", "2027-02-16", pinned = true), item(2u, "2"))
        val result = run(items, links = listOf(link(1u, ms(1u), ms(2u))))
        assertEquals(mapOf(2u to "02-17..02-17"), result.spans())
        // Without the pin the predecessor is re-planned to the first free days and the successor follows it there.
        val free = run(listOf(item(1u, "4", "2027-02-15", "2027-02-16"), item(2u, "2")), links = listOf(link(1u, ms(1u), ms(2u))))
        assertEquals(mapOf(1u to "02-01..02-02", 2u to "02-03..02-03"), free.spans())
    }

    @Test
    fun `five milestones under WIP 2 fill the week exactly and never exceed it`() {
        val items = listOf(item(1u, "3"), item(2u, "4"), item(3u, "2"), item(4u, "5"), item(5u, "6"))
        val inputs = inputs(items, periods(wip = 2))
        val result = ScheduleKernels.propose(inputs)
        assertEquals(
            mapOf(1u to "02-01..02-03", 2u to "02-01..02-04", 3u to "02-04..02-05", 4u to "02-05..02-11", 5u to "02-08..02-15"),
            result.spans(),
        )
        val weeks = ScheduleKernels.postCheck(inputs, result).weeks
        // Week of 02-01: A 3 + B 4 + C 2 + D 1 = 10.00 against 10.00 (not over); week of 02-08: D 4 + E 5 = 9.00; week of 02-15: E 1.
        assertEquals(listOf("10.00", "9.00", "1.00"), weeks.map { it.load.toString() })
        assertEquals(listOf("10.00", "10.00", "10.00"), weeks.map { it.capacity.toString() })
        assertTrue(weeks.none { it.overloaded || it.wipExceeded })
        assertEquals(2, weeks.maxOf { it.maxWip })
    }

    @Test
    fun `without a limit the daily rule serialises what the week rule alone would run in parallel`() {
        // A 3 MD (1.5/day over 2 days), B 4 MD (2/day over 2 days), C 5 MD (5/3 a day over 3 days): the daily capacity is 2.
        val result = run(listOf(item(1u, "3"), item(2u, "4"), item(3u, "5")))
        assertEquals(mapOf(1u to "02-01..02-02", 2u to "02-03..02-04", 3u to "02-05..02-09"), result.spans())
    }

    @Test
    fun `a fixed milestone in progress takes its rate from the days the proposal can use`() {
        // F is dated Saturday 01-30 .. Friday 02-05: it started on or before asOf (fixed), its effective days are d1..d5 (5 working days).
        fun x(fMd: String): Pair<ScheduleProposalResult, List<WeekLoad>> {
            val inputs = inputs(listOf(item(1u, fMd, "2027-01-30", "2027-02-05"), item(2u, "4")), periods(wip = 2))
            val result = ScheduleKernels.propose(inputs)
            return result to ScheduleKernels.postCheck(inputs, result).weeks
        }
        // F 5 MD (1/day): X fits beside it, WIP 2 (1 + 1), load 1 + 1 = 2 of 2.
        val (five, fiveWeeks) = x("5")
        assertEquals(mapOf(2u to "02-01..02-04"), five.spans())
        assertEquals("9.00", fiveWeeks.week("2027-02-01").load.toString())
        // F 10 MD (2/day) uses the whole daily capacity: X waits for the next week.
        assertEquals(mapOf(2u to "02-08..02-11"), x("10").first.spans())
        // F 15 MD (3/day, overbooked): nothing is added to the overloaded week; X goes to the next, F's excess stays and is shown.
        val (fifteen, fifteenWeeks) = x("15")
        assertEquals(mapOf(2u to "02-08..02-11"), fifteen.spans())
        val over = fifteenWeeks.week("2027-02-01")
        assertEquals("15.00", over.load.toString())
        assertTrue(over.overloaded)
        assertEquals("5.00", over.overloadMd.toString())
        assertEquals("4.00", fifteenWeeks.week("2027-02-08").load.toString())
    }

    @Test
    fun `a falling capacity stretches the span so that no day is over its own share`() {
        // 10 MD/week then 5 from Thursday 02-04: shares 2,2,2 then 1,1,... X 7 MD needs 7 days at rate 1 (the min share rules).
        val inputs = inputs(
            listOf(item(1u, "7")),
            listOf(CapacityPeriod(d("2027-01-04"), BigDecimal(10), null), CapacityPeriod(d("2027-02-04"), BigDecimal(5), null)),
        )
        val result = ScheduleKernels.propose(inputs)
        assertEquals(mapOf(1u to "02-01..02-09"), result.spans())
        val weeks = ScheduleKernels.postCheck(inputs, result).weeks
        assertEquals("5.00", weeks.week("2027-02-01").load.toString())
        assertEquals("8.00", weeks.week("2027-02-01").capacity.toString())
        assertTrue(weeks.none { it.overloaded })
    }

    @Test
    fun `days without capacity are skipped by the period boundary and a team without a period places nothing`() {
        // First period on Monday 02-08: everything starts there, and the horizon counts from there.
        assertEquals(mapOf(1u to "02-08..02-09"), run(listOf(item(1u, "3")), periods(from = "2027-02-08")).spans())
        // No period at all, and a team on hold from the start: NO_CAPACITY for every movable milestone.
        for (none in listOf(emptyList(), periods(mdPerWeek = "0"))) {
            val result = run(listOf(item(1u, "3"), item(2u, "1", "2027-02-02")), none)
            assertEquals(emptyList(), result.placements)
            val reasons = result.unplaced.map { it.milestoneId to it.reason }.sortedBy { it.first }
            assertEquals(listOf(1u to UnplacedReason.NO_CAPACITY, 2u to UnplacedReason.NO_CAPACITY), reasons)
        }
        // A period in 2086 with asOf in 2027: placed in 2086 (the horizon counts from the first USABLE day, not from asOf).
        val far = run(listOf(item(1u, "3")), periods(from = "2086-01-07"))
        assertEquals(span("2086-01-07", "2086-01-08"), far.placements.single().to)
    }

    @Test
    fun `a stretch of capacity too short for a milestone is jumped to the next period that can hold it`() {
        // Capacity 10 until Friday 02-05, on hold 02-08..02-12, 10 again from 02-15. X 3 MD takes d1..d2; Y 10 MD (5 days at 2) cannot fit
        // in the 3 days left of the first stretch, so it jumps over the hold to 02-15..02-19.
        val capacity = listOf(
            CapacityPeriod(d("2027-01-04"), BigDecimal(10), null),
            CapacityPeriod(d("2027-02-08"), BigDecimal(0), null),
            CapacityPeriod(d("2027-02-15"), BigDecimal(10), null),
        )
        val items = listOf(item(1u, "3", pos = 1), item(2u, "10", pos = 2))
        assertEquals(mapOf(1u to "02-01..02-02", 2u to "02-15..02-19"), run(items, capacity).spans())
        // Capacity ends at 02-08 for good: usable days exist (d3..d5) but no span of Y fits - NO_ROOM, not NO_CAPACITY.
        val ending = listOf(CapacityPeriod(d("2027-01-04"), BigDecimal(10), null), CapacityPeriod(d("2027-02-08"), BigDecimal(0), null))
        val result = run(items, ending)
        assertEquals(mapOf(1u to "02-01..02-02"), result.spans())
        assertEquals(listOf(2u to UnplacedReason.NO_ROOM), result.unplaced.map { it.milestoneId to it.reason })
    }

    @Test
    fun `the horizon counts from the first usable day and a milestone that cannot fit before it has no room`() {
        val items = listOf(item(1u, "10"))
        // One week of horizon from 02-08: 10 MD (5 days at 2) fits exactly, 20 MD (10 days) does not.
        val week = periods(from = "2027-02-08")
        val fits = ScheduleKernels.propose(inputs(items, week, horizonWeeks = 1))
        assertEquals(span("2027-02-08", "2027-02-12"), fits.placements.single().to)
        val tooBig = ScheduleKernels.propose(inputs(listOf(item(1u, "20")), week, horizonWeeks = 1))
        assertEquals(listOf(UnplacedReason.NO_ROOM), tooBig.unplaced.map { it.reason })
        // A 100,000 MD milestone needs 50,000 days.
        assertEquals(listOf(UnplacedReason.NO_ROOM), run(listOf(item(1u, "100000"))).unplaced.map { it.reason })
    }

    // ---- dependencies ------------------------------------------------------------------------------------------------------------

    private fun againstFixed(
        type: DependencyType,
        lag: Int,
        calendar: WorkingCalendar = WorkingCalendar.MON_FRI,
        end: String = "2027-02-05",
    ): String? {
        val result = run(
            listOf(item(1u, "3")),
            others = listOf(fact(50u, 2u, other, "2027-02-01", end)),
            links = listOf(link(100u, ms(50u), ms(1u), type, lag)),
            calendar = calendar,
        )
        return result.spans()[1u]
    }

    @Test
    fun `each link type puts its lower bound on the successor`() {
        // P fixed in another team, 02-01..02-05; m 3 MD, no limit (2 days).
        assertEquals("02-08..02-09", againstFixed(fs, 0))
        assertEquals("02-10..02-11", againstFixed(fs, 2))
        assertEquals("02-04..02-05", againstFixed(fs, -2)) // a lead
        assertEquals("02-01..02-02", againstFixed(fs, -10)) // a lead beyond the first day is clamped by it
        assertEquals("02-02..02-03", againstFixed(DependencyType.SS, 1))
        assertEquals("02-04..02-05", againstFixed(DependencyType.FF, 0)) // the earliest start whose END reaches 02-05
        assertEquals("02-01..02-02", againstFixed(DependencyType.SF, 0)) // holds trivially
    }

    @Test
    fun `a holiday costs a calendar day and a lag counts working days`() {
        val wednesdayOff = WorkingCalendar(mapOf(d("2027-02-03") to "Day off"))
        // P ends Tuesday 02-02; FS lag 2: the index skips Wednesday: 02-04 is +1, 02-05 is +2, so the earliest start is Monday 02-08.
        assertEquals("02-08..02-09", againstFixed(fs, 2, wednesdayOff, end = "2027-02-02"))
        // 4 MD at WIP 2 (1 a day, four days) from 02-01 with Wednesday off: Mon, Tue, Thu, Fri - five calendar days.
        assertEquals(mapOf(1u to "02-01..02-05"), run(listOf(item(1u, "4")), periods(wip = 2), calendar = wednesdayOff).spans())
    }

    @Test
    fun `a predecessor is hoisted ahead of the milestone that waits for it`() {
        // Custom order [c, a, b] with b -> c: b is placed first, then c after it, then a; the answer lists them in the TEAM order.
        val items = listOf(item(1u, "2", pos = 2), item(2u, "2", pos = 3), item(3u, "2", pos = 1))
        val result = run(items, periods(wip = 2), links = listOf(link(100u, ms(2u), ms(3u))))
        assertEquals(listOf(3u, 1u, 2u), result.placements.map { it.milestoneId })
        assertEquals(mapOf(1u to "02-01..02-02", 2u to "02-01..02-02", 3u to "02-03..02-04"), result.spans())
    }

    @Test
    fun `a link from a project waits for the project's movable milestones and a link into a project binds its milestones`() {
        // P (project 2) holds the movable x (id 2) and the fixed y of another team (01-25..01-29); m (id 1) comes first in the order.
        val fromProject = run(
            listOf(item(1u, "2", pos = 1), item(2u, "2", project = 2u, pos = 2)),
            periods(wip = 2),
            others = listOf(fact(60u, 2u, other, "2027-01-25", "2027-01-29")),
            links = listOf(link(100u, pr(2u), ms(1u))),
        )
        assertEquals(mapOf(2u to "02-01..02-02", 1u to "02-03..02-04"), fromProject.spans())
        // m -> Q (project 2): q1 (project 2, first in the order) waits for m.
        val intoProject = run(
            listOf(item(1u, "2", project = 2u, pos = 1), item(2u, "2", pos = 2)),
            periods(wip = 2),
            links = listOf(link(100u, ms(2u), pr(2u))),
        )
        assertEquals(mapOf(1u to "02-03..02-04", 2u to "02-01..02-02"), intoProject.spans())
    }

    @Test
    fun `a finish-bound link into a project is no bound and the post-check reports the result`() {
        val items = listOf(item(1u, "2", project = 2u))
        val inputs = inputs(
            items,
            periods(wip = 2),
            others = listOf(fact(60u, 3u, other, "2027-02-08", "2027-02-12")),
            links = listOf(link(100u, pr(3u), pr(2u), DependencyType.FF)),
        )
        val result = ScheduleKernels.propose(inputs)
        assertEquals(mapOf(1u to "02-01..02-02"), result.spans())
        val check = ScheduleKernels.postCheck(inputs, result).links.single()
        assertEquals(DependencyStatus.UNSCHEDULED, check.before)
        assertEquals(DependencyStatus.VIOLATED, check.after.status)
        assertEquals(8, check.after.shortfallDays)
    }

    @Test
    fun `a link into another team's fixed milestone is placed anyway and reported violated`() {
        // WIP 1 (2 MD a day): o1 d1..d5, o2 d6..d10, m (2 MD, one day) d11 = 02-15. w (another team) starts 02-08 and needs m by 02-05.
        val items = listOf(item(1u, "10", pos = 1), item(2u, "10", pos = 2), item(3u, "2", "2027-02-01", pos = 3))
        val inputs = inputs(
            items,
            periods(wip = 1),
            others = listOf(fact(70u, 2u, other, "2027-02-08", "2027-02-12")),
            links = listOf(link(100u, ms(3u), ms(70u))),
        )
        val result = ScheduleKernels.propose(inputs)
        assertEquals(listOf(1u, 2u, 3u), result.placements.map { it.milestoneId })
        assertEquals(mapOf(1u to "02-01..02-05", 2u to "02-08..02-12", 3u to "02-15..02-15"), result.spans())
        val check = ScheduleKernels.postCheck(inputs, result).links.single()
        assertEquals(DependencyStatus.OK, check.before)
        assertEquals(DependencyStatus.VIOLATED, check.after.status)
        assertEquals(6, check.after.shortfallDays)
    }

    @Test
    fun `a milestone that lands on its current dates is a placement with to equal to from`() {
        val result = run(listOf(item(1u, "3", "2027-02-01", "2027-02-02")))
        val placement = result.placements.single()
        assertEquals(placement.from, placement.to)
    }

    @Test
    fun `an unscheduled predecessor binds nothing and a violated link between fixed ends is untouched`() {
        val unscheduled = run(listOf(item(1u, "3")), others = listOf(fact(80u, 2u, other)), links = listOf(link(100u, ms(80u), ms(1u))))
        assertEquals(mapOf(1u to "02-01..02-02"), unscheduled.spans())
        // f1 (01-27..01-29) -> f2 (01-25..01-26) of the team, both fixed (started before asOf): violated before and after, never touched;
        // the link between two other-team milestones is not the team's business and is not reported.
        val items = listOf(item(1u, "3", "2027-01-27", "2027-01-29"), item(2u, "1", "2027-01-25", "2027-01-26"), item(3u, "3"))
        val inputs = inputs(
            items,
            others = listOf(fact(81u, 3u, other, "2027-02-08", "2027-02-12"), fact(82u, 3u, other, "2027-02-01", "2027-02-05")),
            links = listOf(link(100u, ms(1u), ms(2u)), link(101u, ms(81u), ms(82u))),
        )
        val result = ScheduleKernels.propose(inputs)
        assertEquals(mapOf(3u to "02-01..02-02"), result.spans())
        val checks = ScheduleKernels.postCheck(inputs, result).links
        assertEquals(listOf(100u), checks.map { it.linkId })
        assertEquals(DependencyStatus.VIOLATED, checks.single().before)
        assertEquals(DependencyStatus.VIOLATED, checks.single().after.status)
    }

    @Test
    fun `a hoisting loop on valid data is tolerated, a skipped hoist bound is only reported by the post-check, a cycle fails closed`() {
        // a FF b and b SS a: END(a) -> END(b), START(b) -> START(a) is acyclic, yet each waits for the other. b (2 MD) is placed first
        // with no bound from a, then a (3 MD) after b's start: b ends 02-02, a ends 02-03, so a FF b is VIOLATED by 1 and only the
        // post-check says so.
        val links = listOf(link(100u, ms(1u), ms(2u), DependencyType.FF), link(101u, ms(2u), ms(1u), DependencyType.SS))
        val inputs = inputs(listOf(item(1u, "3", pos = 1), item(2u, "2", pos = 2)), periods(wip = 2), links = links)
        val loop = ScheduleKernels.propose(inputs)
        assertEquals(mapOf(1u to "02-01..02-03", 2u to "02-01..02-02"), loop.spans())
        val checks = ScheduleKernels.postCheck(inputs, loop).links
        assertEquals(listOf(100u, 101u), checks.map { it.linkId })
        assertEquals(DependencyStatus.VIOLATED, checks.first().after.status)
        assertEquals(1, checks.first().after.shortfallDays)
        assertEquals(DependencyStatus.OK, checks.last().after.status)
        val cyclic = listOf(link(100u, ms(1u), ms(2u)), link(101u, ms(2u), ms(1u)))
        val error = assertFailsWith<IllegalStateException> { run(listOf(item(1u, "2"), item(2u, "2")), links = cyclic) }
        assertTrue("cycle" in error.message.orEmpty())
    }

    @Test
    fun `a scheduled milestone that cannot be placed keeps its stored load and the strip stays honest`() {
        // 10 MD/week, on hold from 02-15. A (18 MD, 9 days at 2) is first in the order; U (4 MD) is stored 02-08..02-09. Alone, A would
        // take 02-01..02-11 and U would find no room; but U keeps its dates when the proposal is accepted, so U is pinned at 2/day on
        // 02-08..02-09 and A no longer finds nine free days either. Nothing is added to the week U loads.
        val capacity = listOf(CapacityPeriod(d("2027-01-04"), BigDecimal(10), null), CapacityPeriod(d("2027-02-15"), BigDecimal(0), null))
        val inputs = inputs(listOf(item(1u, "18", pos = 1), item(2u, "4", "2027-02-08", "2027-02-09", pos = 2)), capacity)
        val result = ScheduleKernels.propose(inputs)
        assertTrue(result.placements.isEmpty())
        assertEquals(
            listOf(1u to UnplacedReason.NO_ROOM, 2u to UnplacedReason.NO_ROOM),
            result.unplaced.map { it.milestoneId to it.reason },
        )
        assertEquals(span("2027-02-08", "2027-02-09"), result.spansAfter[2u])
        assertNull(result.spansAfter[1u])
        val weeks = ScheduleKernels.postCheck(inputs, result).weeks
        assertEquals("4.00", weeks.week("2027-02-08").load.toString())
        assertTrue(weeks.none { it.overloaded })
    }

    @Test
    fun `fixed load that overbooks a day cannot push the week over its capacity`() {
        // asOf Monday 02-01: F (3 MD on 02-01 alone, 3 against a daily 2) is fixed. X 8 MD = 4 days at 2/day: starting 02-02 would load
        // the week 3 + 8 = 11 of 10 although every day after 02-01 is within its daily capacity, so X starts 02-03 (3 + 6 = 9; 02-08 2).
        val items = listOf(item(1u, "3", "2027-02-01"), item(2u, "8"))
        val inputs = inputs(items, asOf = "2027-02-01")
        val result = ScheduleKernels.propose(inputs)
        assertEquals(mapOf(2u to "02-03..02-08"), result.spans())
        val weeks = ScheduleKernels.postCheck(inputs, result).weeks
        assertEquals("9.00", weeks.week("2027-02-01").load.toString())
        assertTrue(weeks.none { it.overloaded })
    }

    @Test
    fun `the week's load counts the days before the first candidate day`() {
        // asOf Wednesday 02-03: F (8 MD, 02-01..02-03) is wholly in the past but loads the week 8 of 10. X 6 MD = 3 days at 2/day: from
        // Thu 02-04 two days in this week would make 12, so X starts Fri 02-05 (one day here: 10) and ends Tue 02-09.
        val items = listOf(item(1u, "8", "2027-02-01", "2027-02-03"), item(2u, "6"))
        val inputs = inputs(items, asOf = "2027-02-03")
        val result = ScheduleKernels.propose(inputs)
        assertEquals(mapOf(2u to "02-05..02-09"), result.spans())
        assertTrue(ScheduleKernels.postCheck(inputs, result).weeks.none { it.overloaded })
    }

    @Test
    fun `a zero man-day milestone is placed on a day a fixed milestone overbooks and still counts for WIP`() {
        // F is fixed at 3/day against a daily 2 on 02-01..02-05 (15 MD). The checkpoint loads nothing, so without a limit it takes d1;
        // under WIP 1 F holds the limit all week and it takes Monday 02-08.
        val items = listOf(item(1u, "15", "2027-01-30", "2027-02-05"), item(2u, "0"))
        assertEquals(mapOf(2u to "02-01..02-01"), run(items).spans())
        assertEquals(mapOf(2u to "02-08..02-08"), run(items, periods(wip = 1)).spans())
    }

    @Test
    fun `an end bound beyond the horizon has no room and a milestone with a start and an end bound meets both`() {
        val far = listOf(fact(50u, 2u, other, "2030-01-07", "2030-01-11"))
        val farLink = listOf(link(100u, ms(50u), ms(1u), DependencyType.FF))
        val beyond = ScheduleKernels.propose(inputs(listOf(item(1u, "3")), others = far, links = farLink, horizonWeeks = 4))
        assertEquals(listOf(UnplacedReason.NO_ROOM), beyond.unplaced.map { it.reason })
        // FS from P (ends 02-05) puts the start at 02-08 or later; FF from Q (ends 02-12) wants the end on 02-12 or later: with two days
        // the earliest start whose end reaches 02-12 is Thursday 02-11.
        val both = run(
            listOf(item(1u, "3")),
            others = listOf(fact(50u, 2u, other, "2027-02-01", "2027-02-05"), fact(51u, 3u, other, "2027-02-08", "2027-02-12")),
            links = listOf(link(100u, ms(50u), ms(1u)), link(101u, ms(51u), ms(1u), DependencyType.FF)),
        )
        assertEquals(mapOf(1u to "02-11..02-12"), both.spans())
    }

    @Test
    fun `an estimate with decimals is spread exactly`() {
        val inputs = inputs(listOf(item(1u, "2.5")))
        val result = ScheduleKernels.propose(inputs)
        assertEquals(mapOf(1u to "02-01..02-02"), result.spans())
        assertEquals("2.50", ScheduleKernels.postCheck(inputs, result).weeks.week("2027-02-01").load.toString())
    }

    @Test
    fun `shuffled inputs give the same proposal and post-check`() {
        val items = listOf(
            item(1u, "3", pos = 1),
            item(2u, "4", pos = 2),
            item(3u, "2", pos = 3),
            item(4u, "5"),
            item(5u, "6", "2027-01-27", "2027-02-03"),
        )
        val others = listOf(fact(50u, 2u, other, "2027-02-01", "2027-02-02"), fact(51u, 2u, other, "2027-02-08", "2027-02-09"))
        val links = listOf(
            link(100u, ms(50u), ms(2u)),
            link(101u, ms(1u), ms(4u)),
            link(102u, ms(3u), ms(51u)),
            link(103u, pr(2u), ms(3u), DependencyType.SS, 1),
        )
        val base = inputs(items, periods(wip = 2), others, links)
        val expected = ScheduleKernels.propose(base)
        val expectedCheck = ScheduleKernels.postCheck(base, expected)
        val random = Random(7)
        repeat(5) {
            val shuffled = base.copy(
                team = base.team.shuffled(random),
                plan = base.plan.shuffled(random),
                links = base.links.shuffled(random),
                periods = base.periods.shuffled(random),
            )
            val result = ScheduleKernels.propose(shuffled)
            assertEquals(expected, result)
            assertEquals(expectedCheck, ScheduleKernels.postCheck(shuffled, result))
        }
        assertNotNull(expected.placements.firstOrNull())
    }

    @Test
    fun `a dense team is placed without ever exceeding capacity or WIP`() {
        // 200 milestones of 1..12 MD (a fixed pseudo-random sequence), WIP 3, capacity 10 then 14 from 2027-06-07: the post-check's weeks
        // (the team view's own kernel) must show no overloaded and no over-WIP week, and every milestone must have been placed.
        val random = Random(2027)
        val items = (1..200).map { item(it.toUInt(), random.nextInt(1, 13).toString(), pos = it) }
        val capacity = listOf(CapacityPeriod(d("2027-01-04"), BigDecimal(10), 3), CapacityPeriod(d("2027-06-07"), BigDecimal(14), 3))
        val inputs = inputs(items, capacity)
        val result = ScheduleKernels.propose(inputs)
        assertEquals(200, result.placements.size)
        assertTrue(result.unplaced.isEmpty())
        val weeks = ScheduleKernels.postCheck(inputs, result).weeks
        val bad = weeks.filter { it.overloaded || it.wipExceeded }
        assertTrue(bad.isEmpty(), "an overloaded or over-WIP week: $bad")
        assertEquals(3, weeks.maxOf { it.maxWip })
    }
}
