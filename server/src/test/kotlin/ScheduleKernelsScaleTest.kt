package ch.nokillswit

import ch.nokillswit.infra.time.WorkingCalendar
import ch.nokillswit.planning.CapacityPeriod
import ch.nokillswit.planning.DaySpan
import ch.nokillswit.planning.DependencyType
import ch.nokillswit.planning.EndpointKind
import ch.nokillswit.planning.EndpointRef
import ch.nokillswit.planning.MAX_LOAD_WEEKS
import ch.nokillswit.planning.MultiTeamInputs
import ch.nokillswit.planning.OrderKey
import ch.nokillswit.planning.PlanLinkFact
import ch.nokillswit.planning.PlanMilestoneFact
import ch.nokillswit.planning.PolishHolidays
import ch.nokillswit.planning.ScheduleInputs
import ch.nokillswit.planning.ScheduleKernels
import ch.nokillswit.planning.TeamRun
import ch.nokillswit.planning.TeamScheduleItem
import ch.nokillswit.planning.postCheckMany
import ch.nokillswit.planning.proposeMany
import java.math.BigDecimal
import java.time.LocalDate
import kotlin.random.Random
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
 *
 * The cross-team case (1.8.0) runs `proposeMany` over 15 teams of the sample plan's density (1,000 milestones in the sample's team
 * sizes, about 300 links of which a third cross teams, a few pinned, a capacity cliff on a third of the teams) and prints the run's and
 * the post-check's milliseconds, the passes and whether it settled.
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

    @Test
    fun `15 teams of the sample's density run across teams inside the tripwire`() {
        val input = sampleWorld()
        val result = ScheduleKernels.proposeMany(input)
        assertEquals(TEAM_SIZES.size, result.order.size)
        assertTrue(result.passes in 1..input.maxPasses)
        val movable = input.teams.sumOf { run -> run.team.count { !it.pinned } }
        val listed = result.byTeam.values.sumOf { it.placements.size + it.unplaced.size }
        assertEquals(movable, listed, "every movable milestone is placed or listed")
        val run = ScaleFigures.series(CROSS_WARMUPS, CROSS_RUNS) { ScheduleKernels.proposeMany(input) }
        ScaleFigures.printSeries("proposeMany 15 teams, $ITEM_TOTAL milestones, ${input.links.size} links", run)
        println("scale-figure\tproposeMany passes\t${result.passes} (settled=${result.settled})")
        val check = ScaleFigures.series(CROSS_WARMUPS, CROSS_RUNS) { ScheduleKernels.postCheckMany(input, result) }
        ScaleFigures.printSeries("postCheckMany 15 teams", check)
        assertTrue(ScaleFigures.median(run) <= CROSS_TRIPWIRE_MS, "proposeMany took ${ScaleFigures.median(run)} ms (median)")
    }

    /** 15 teams in the sample's sizes, their milestones spread over ~100 projects, ~300 FS links (a third across teams). */
    private fun sampleWorld(): MultiTeamInputs {
        val random = Random(SEED)
        var next = 1
        val teamOfId = HashMap<Int, Int>()
        val runs = TEAM_SIZES.mapIndexed { t, size ->
            val teamId = (t + 1).toUInt()
            // Every third team stops at the cliff, half of them run a WIP limit; the rest never run out of capacity (the sample's shape).
            val capacity = buildList {
                add(CapacityPeriod(anchor, BigDecimal("10.00"), if (t % 2 == 0) WIP_LIMIT else null))
                if (t % 3 == 0) add(CapacityPeriod(cliff, BigDecimal("0.00"), null))
            }
            val items = List(size) { i ->
                val id = next++
                teamOfId[id] = t
                val start = anchor.plusWeeks((i / PER_WEEK).toLong()).plusDays((i % PER_WEEK).toLong())
                val projectId = (1 + id % PROJECTS).toUInt()
                val dated = i % UNSCHEDULED_EVERY != 0
                TeamScheduleItem(
                    id = id.toUInt(),
                    projectId = projectId,
                    span = if (dated) DaySpan(start, start.plusDays(1 + (id % 3).toLong())) else null,
                    estimateMd = BigDecimal(1 + id % 20),
                    key = OrderKey(i + 1, null, "P$projectId", projectId, start, start, "m%04d".format(id), id.toUInt()),
                    pinned = dated && i % PINNED_EVERY == 0,
                )
            }
            TeamRun(teamId, "Team %02d".format(t), items, capacity)
        }
        // Links run from an earlier to a later milestone of ONE random order (so the plan has no cycle) that ignores the team blocks: the
        // cross-team links point both ways between teams and the team graph is cyclic, the fixed point's hard case.
        val rank = (1..ITEM_TOTAL).shuffled(random)
        val links = List(LINKS) { n ->
            val at = 1 + random.nextInt(rank.size - 1)
            val successor = rank[at]
            val earlier = rank.subList(0, at)
            val sameTeam = random.nextInt(100) >= CROSS_TEAM_PERCENT
            val pool = if (sameTeam) earlier.filter { teamOfId[it] == teamOfId[successor] }.ifEmpty { earlier } else earlier
            PlanLinkFact(
                (n + 1).toUInt(),
                EndpointRef(EndpointKind.MILESTONE, pool[random.nextInt(pool.size)].toUInt()),
                EndpointRef(EndpointKind.MILESTONE, successor.toUInt()),
                DependencyType.FS,
                0,
            )
        }
        return MultiTeamInputs(
            asOf = asOf,
            teams = runs,
            plan = runs.flatMap { run -> run.team.map { PlanMilestoneFact(it.id, it.projectId, run.teamId, it.span) } },
            links = links,
            calendar = WorkingCalendar.MON_FRI,
        )
    }

    private companion object {
        const val ITEMS = 300
        const val PER_WEEK = 2
        const val PER_PROJECT = 10
        const val CLIFF_WEEK = 80L
        const val WARMUPS = 2
        const val RUNS = 5
        const val TRIPWIRE_MS = 5_000.0

        // The cross-team case.
        val TEAM_SIZES = listOf(301, 101, 60, 75, 151, 50, 43, 38, 34, 27, 30, 25, 23, 22, 20)
        val ITEM_TOTAL = TEAM_SIZES.sum()
        const val SEED = 18
        const val PROJECTS = 100
        const val LINKS = 300
        const val CROSS_TEAM_PERCENT = 30
        const val WIP_LIMIT = 3
        const val UNSCHEDULED_EVERY = 10
        const val PINNED_EVERY = 25
        const val CROSS_WARMUPS = 1
        const val CROSS_RUNS = 3
        const val CROSS_TRIPWIRE_MS = 20_000.0
    }
}
