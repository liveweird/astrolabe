package ch.nokillswit

import ch.nokillswit.infra.time.WorkingCalendar
import ch.nokillswit.planning.CapacityPeriod
import ch.nokillswit.planning.DaySpan
import ch.nokillswit.planning.DependencyType
import ch.nokillswit.planning.EndpointKind
import ch.nokillswit.planning.EndpointRef
import ch.nokillswit.planning.MultiTeamInputs
import ch.nokillswit.planning.MultiTeamResult
import ch.nokillswit.planning.OrderKey
import ch.nokillswit.planning.PlanLinkFact
import ch.nokillswit.planning.PlanMilestoneFact
import ch.nokillswit.planning.ScheduleInputs
import ch.nokillswit.planning.ScheduleKernels
import ch.nokillswit.planning.ScheduleProposalResult
import ch.nokillswit.planning.TeamRun
import ch.nokillswit.planning.TeamScheduleItem
import ch.nokillswit.planning.planContainment
import ch.nokillswit.planning.proposeMany
import ch.nokillswit.planning.requireAcyclicPlan
import ch.nokillswit.planning.teamOrder
import java.math.BigDecimal
import java.time.LocalDate
import kotlin.random.Random
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

/**
 * The cross-team run's worklist (1.26: from the second pass on a team is placed again only when a team with an edge into it changed its
 * `spansAfter` since it last ran) against an exhaustive reference loop kept HERE: every team, every pass, exactly the loop 1.8 shipped.
 * The two must answer the same `order`, `passes`, `settled` and `byTeam` (the soundness premise: a team reads other teams only through
 * its link predecessors' facts), and the worklist never places more often. [SEEDS] are fixed random worlds: 2-5 teams in a run (plus a
 * team outside it), shared projects, links of all four types with lags between milestones and projects (the cycle rule decides which
 * are kept, so team cycles run through different milestones), pinned, started and unscheduled milestones, WIP limits, capacity cliffs
 * and a team without capacity, and a pass limit of 1-5 so unsettled runs are covered too.
 */
class CrossTeamWorklistTest {
    private val asOf = LocalDate.parse("2027-01-31") // a Sunday
    private val anchor = LocalDate.parse("2027-01-04") // a Monday

    @Test
    fun `the worklist answers what the every-team-every-pass loop answers on every random world, placing no more often`() {
        var worklist = 0
        var reference = 0
        var cyclic = 0
        var multiPass = 0
        var unsettled = 0
        var fewer = 0
        for (seed in SEEDS) {
            val world = world(seed)
            val expected = exhaustive(world)
            val actual = ScheduleKernels.proposeMany(world)
            val label = "seed $seed"
            assertEquals(expected.order, actual.order, "$label: order")
            assertEquals(expected.passes, actual.passes, "$label: passes")
            assertEquals(expected.settled, actual.settled, "$label: settled")
            assertEquals(expected.byTeam, actual.byTeam, "$label: byTeam")
            assertEquals(expected.byTeam.keys.toList(), actual.byTeam.keys.toList(), "$label: byTeam iterates in order")
            val exhaustivePlacements = expected.passes * world.teams.size
            assertTrue(actual.placements <= exhaustivePlacements, "$label: ${actual.placements} placements > $exhaustivePlacements")
            assertTrue(actual.placements >= world.teams.size, "$label: pass 1 places every team")
            worklist += actual.placements
            reference += exhaustivePlacements
            if (teamOrder(world).backEdgeSources.isNotEmpty()) cyclic++
            if (actual.passes >= 2) multiPass++
            if (!actual.settled) unsettled++
            if (actual.placements < exhaustivePlacements) fewer++
        }
        println("worklist worlds: ${SEEDS.count()}, cyclic team graphs $cyclic, multi-pass $multiPass, unsettled $unsettled, " +
            "fewer placements in $fewer, placements $worklist of $reference")
        assertTrue(cyclic >= MIN_COVERED, "only $cyclic worlds with a cyclic team graph")
        assertTrue(multiPass >= MIN_COVERED, "only $multiPass worlds with a second pass")
        assertTrue(unsettled >= 1, "no world ran out of passes")
        assertTrue(fewer >= MIN_COVERED, "the worklist skipped a team in only $fewer worlds")
    }

    /** The loop of 1.8: every team of the order in every pass, until a pass changes nothing a back edge reads. */
    private fun exhaustive(inputs: MultiTeamInputs): MultiTeamResult {
        val graph = teamOrder(inputs)
        val runs = inputs.teams.associateBy { it.teamId }
        val working = LinkedHashMap<UInt, PlanMilestoneFact>()
        inputs.plan.sortedBy { it.id }.forEach { working[it.id] = it }
        for (run in inputs.teams) run.team.forEach { working[it.id] = PlanMilestoneFact(it.id, it.projectId, run.teamId, it.span) }
        var previous: Map<UInt, Map<UInt, DaySpan>> =
            inputs.teams.associate { run -> run.teamId to run.team.mapNotNull { item -> item.span?.let { item.id to it } }.toMap() }
        var results: Map<UInt, ScheduleProposalResult> = emptyMap()
        var passes = 0
        var settled = false
        while (passes < inputs.maxPasses && !settled) {
            passes++
            val pass = LinkedHashMap<UInt, ScheduleProposalResult>()
            for (teamId in graph.order) {
                val run = runs.getValue(teamId)
                val teamInputs = ScheduleInputs(
                    inputs.asOf, teamId, run.team, run.periods, working.values, inputs.links, inputs.calendar, inputs.horizonWeeks,
                )
                val result = ScheduleKernels.proposeUnchecked(teamInputs)
                pass[teamId] = result
                for (item in run.team) working[item.id] = PlanMilestoneFact(item.id, item.projectId, teamId, result.spansAfter[item.id])
            }
            val changed = pass.filter { (teamId, result) -> result.spansAfter != previous[teamId] }.keys
            settled = changed.none { it in graph.backEdgeSources }
            previous = pass.mapValues { it.value.spansAfter }
            results = pass
        }
        return MultiTeamResult(graph.order, passes, settled, results)
    }

    private fun span(offset: Int, days: Int) = DaySpan(asOf.plusDays(offset.toLong()), asOf.plusDays((offset + days).toLong()))

    private fun periodsOf(random: Random): List<CapacityPeriod> {
        if (random.nextInt(100) < NO_CAPACITY_PERCENT) return emptyList()
        val mdPerWeek = BigDecimal(MIN_MD_PER_WEEK + random.nextInt(MD_PER_WEEK_RANGE))
        val first = CapacityPeriod(anchor, mdPerWeek, listOf(null, null, 1, 2, 3).random(random))
        return buildList {
            add(first)
            if (random.nextInt(100) < CLIFF_PERCENT) {
                add(CapacityPeriod(anchor.plusWeeks(2L + random.nextInt(6)), BigDecimal.ZERO, null))
            }
            if (random.nextInt(100) < LOWERED_PERCENT) {
                add(CapacityPeriod(anchor.plusWeeks(1L + random.nextInt(4)), BigDecimal(2), 1))
            }
        }.distinctBy { it.effectiveFrom }
    }

    private fun item(random: Random, id: UInt, position: Int, projects: Int): TeamScheduleItem {
        val projectId = (1 + random.nextInt(projects)).toUInt()
        val dated = random.nextInt(100) < DATED_PERCENT
        val span = if (dated) span(random.nextInt(-5, DATE_SPREAD_DAYS), random.nextInt(MAX_SPAN_DAYS)) else null
        val position = if (random.nextBoolean()) position else null
        return TeamScheduleItem(
            id = id,
            projectId = projectId,
            span = span,
            estimateMd = BigDecimal(random.nextInt(MAX_HALF_MD)).divide(BigDecimal(2)),
            key = OrderKey(position, null, "P$projectId", projectId, span?.start, span?.end, "m%03d".format(id.toInt()), id),
            pinned = span != null && random.nextInt(100) < PINNED_PERCENT,
        )
    }

    private fun world(seed: Int): MultiTeamInputs {
        val random = Random(seed)
        val projects = 2 + random.nextInt(4)
        var next = 1u
        val runs = (1..2 + random.nextInt(4)).map { t ->
            val items = List(2 + random.nextInt(5)) { i -> item(random, next++, i + 1, projects) }
            val name = listOf("Alpha", "alpha", "Beta", "gamma").random(random)
            TeamRun(t.toUInt(), name, items, periodsOf(random))
        }
        // A team outside the run: its dates never change, so it adds facts but no edge.
        val outside = List(random.nextInt(4)) {
            item(random, next++, 1, projects).let { PlanMilestoneFact(it.id, it.projectId, OUTSIDE_TEAM, it.span) }
        }
        val plan = runs.flatMap { run -> run.team.map { PlanMilestoneFact(it.id, it.projectId, run.teamId, it.span) } } + outside
        return MultiTeamInputs(
            asOf = asOf,
            teams = runs,
            plan = plan,
            links = links(random, plan),
            calendar = WorkingCalendar.MON_FRI,
            horizonWeeks = HORIZON_WEEKS,
            maxPasses = 1 + random.nextInt(MAX_PASSES),
        )
    }

    /**
     * Links run from an earlier to a later milestone of one random order, each end a milestone or its project; a link the cycle rule
     * refuses (a project end can close one) is dropped, so every world is a valid plan.
     */
    private fun links(random: Random, plan: List<PlanMilestoneFact>): List<PlanLinkFact> {
        val ranked = plan.shuffled(random)
        val kept = ArrayList<PlanLinkFact>()
        repeat(MIN_LINKS + random.nextInt(LINK_RANGE)) {
            val at = 1 + random.nextInt(ranked.size - 1)
            val pred = ranked[random.nextInt(at)]
            val succ = ranked[at]
            val candidate = PlanLinkFact(
                (kept.size + 1).toUInt(),
                end(random, pred),
                end(random, succ),
                DependencyType.entries.random(random),
                random.nextInt(-3, MAX_LAG_DAYS),
            )
            val ok = candidate.predecessor != candidate.successor &&
                runCatching { requireAcyclicPlan(planContainment(plan, emptyList()), kept + candidate) }.isSuccess
            if (ok) kept.add(candidate)
        }
        return kept
    }

    private fun end(random: Random, fact: PlanMilestoneFact) =
        if (random.nextInt(100) < PROJECT_END_PERCENT) {
            EndpointRef(EndpointKind.PROJECT, fact.projectId)
        } else {
            EndpointRef(EndpointKind.MILESTONE, fact.id)
        }

    private companion object {
        val SEEDS = 1..SEED_COUNT
        const val SEED_COUNT = 500
        const val OUTSIDE_TEAM = 9u
        const val MIN_COVERED = 20
        const val HORIZON_WEEKS = 40
        const val MAX_PASSES = 5
        const val MIN_LINKS = 3
        const val LINK_RANGE = 10
        const val MAX_LAG_DAYS = 6
        const val PROJECT_END_PERCENT = 25
        const val DATED_PERCENT = 60
        const val PINNED_PERCENT = 15
        const val DATE_SPREAD_DAYS = 30
        const val MAX_SPAN_DAYS = 7
        const val MAX_HALF_MD = 19
        const val NO_CAPACITY_PERCENT = 4
        const val CLIFF_PERCENT = 25
        const val LOWERED_PERCENT = 25
        const val MIN_MD_PER_WEEK = 5
        const val MD_PER_WEEK_RANGE = 11
    }
}
