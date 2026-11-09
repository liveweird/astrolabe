package ch.nokillswit

import ch.nokillswit.infra.time.WorkingCalendar
import ch.nokillswit.planning.CapacityPeriod
import ch.nokillswit.planning.DaySpan
import ch.nokillswit.planning.DependencyStatus
import ch.nokillswit.planning.DependencyType
import ch.nokillswit.planning.EndpointKind
import ch.nokillswit.planning.EndpointRef
import ch.nokillswit.planning.MAX_CROSS_TEAM_PASSES
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
import ch.nokillswit.planning.checkMany
import ch.nokillswit.planning.postCheckMany
import ch.nokillswit.planning.proposeMany
import java.math.BigDecimal
import java.time.LocalDate
import kotlin.random.Random
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertTrue

/**
 * The cross-team run (`ScheduleKernels.proposeMany`) as a pure function; every figure is counted by hand. The builders and the calendar
 * of [ScheduleKernelsTest]: 2027-02-01 is a Monday (d1), a team's capacity is 10 MD/week from 2027-01-04 (2/day, so 2 MD fill a day and
 * 4 MD take two), `asOf` is Sunday 2027-01-31 (every dated milestone starts after it, so it is movable) and the calendar is `MON_FRI`.
 * Teams are 1 (A), 2 (B), 3 (C), 9 (outside the run); a team's milestone ids start at `10 * team` (A 11.., B 21.., C 31..), project ids
 * are named per test. Dates print as `MM-DD` (all in 2027).
 */
class CrossTeamKernelsTest {
    private val fs = DependencyType.FS
    private val a = 1u
    private val b = 2u
    private val c = 3u

    private fun d(text: String) = LocalDate.parse(text)

    private fun span(start: String, end: String = start) = DaySpan(d(start), d(end))

    private fun periods(mdPerWeek: String = "10") = listOf(CapacityPeriod(d("2027-01-04"), BigDecimal(mdPerWeek), null))

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

    private fun team(id: UInt, name: String, items: List<TeamScheduleItem>, mdPerWeek: String = "10") =
        TeamRun(id, name, items, periods(mdPerWeek))

    private fun fact(id: UInt, project: UInt, teamId: UInt, start: String? = null, end: String? = start) =
        PlanMilestoneFact(id, project, teamId, start?.let { span(it, checkNotNull(end)) })

    private fun ms(id: UInt) = EndpointRef(EndpointKind.MILESTONE, id)

    private fun pr(id: UInt) = EndpointRef(EndpointKind.PROJECT, id)

    private fun link(id: UInt, pred: EndpointRef, succ: EndpointRef, type: DependencyType = fs, lag: Int = 0) =
        PlanLinkFact(id, pred, succ, type, lag)

    private fun inputs(
        teams: List<TeamRun>,
        others: List<PlanMilestoneFact> = emptyList(),
        links: List<PlanLinkFact> = emptyList(),
        maxPasses: Int = MAX_CROSS_TEAM_PASSES,
    ) = MultiTeamInputs(
        d("2027-01-31"),
        teams,
        others + teams.flatMap { run -> run.team.map { PlanMilestoneFact(it.id, it.projectId, run.teamId, it.span) } },
        links,
        WorkingCalendar.MON_FRI,
        maxPasses = maxPasses,
    )

    /** What `propose` alone answers for [run] against the same plan: the per-team kernel the run must reproduce. */
    private fun alone(input: MultiTeamInputs, teamId: UInt): ScheduleProposalResult {
        val run = input.teams.single { it.teamId == teamId }
        return ScheduleKernels.propose(
            ScheduleInputs(input.asOf, teamId, run.team, run.periods, input.plan, input.links, input.calendar, input.horizonWeeks),
        )
    }

    /** `id -> "MM-DD..MM-DD"`, the span each milestone ends on in the team's result (fixed and placed alike). */
    private fun MultiTeamResult.spans(teamId: UInt): Map<UInt, String> =
        byTeam.getValue(teamId).spansAfter.mapValues { (_, s) -> "${s.start.toString().drop(5)}..${s.end.toString().drop(5)}" }

    // ---- the contract's properties --------------------------------------------------------------------------------------------

    @Test
    fun `a one-team run equals propose, in one pass`() {
        val foreign = listOf(fact(91u, 9u, 9u, "2027-02-01", "2027-02-05"))
        val items = listOf(item(11u, "4", pos = 1), item(12u, "2", "2027-02-08", "2027-02-09", pos = 2), item(13u, "3", pos = 3))
        val input = inputs(listOf(team(a, "A", items)), foreign, listOf(link(1u, ms(91u), ms(11u))))
        val result = ScheduleKernels.proposeMany(input)
        assertEquals(listOf(a), result.order)
        assertEquals(1, result.passes)
        assertTrue(result.settled)
        assertEquals(alone(input, a), result.byTeam.getValue(a))
        assertEquals("02-08..02-09", result.spans(a).getValue(11u), "waits for the foreign milestone ending 02-05")
    }

    @Test
    fun `teams with no link between them each equal their own propose, in one pass`() {
        val input = inputs(
            listOf(
                team(a, "A", listOf(item(11u, "4"), item(12u, "6", project = 1u))),
                team(b, "B", listOf(item(21u, "3", project = 2u), item(22u, "2", "2027-02-22", "2027-02-23", project = 2u))),
            ),
        )
        val result = ScheduleKernels.proposeMany(input)
        assertEquals(1, result.passes)
        assertTrue(result.settled)
        assertEquals(listOf(a, b), result.order, "equal movables (2 and 2): the name decides")
        assertEquals(alone(input, a), result.byTeam.getValue(a))
        assertEquals(alone(input, b), result.byTeam.getValue(b))
    }

    @Test
    fun `a chain A to B places B after A's PROPOSED date, whatever the request order`() {
        // a1 4 MD is stored late (02-22..02-23) and proposed at 02-01..02-02; b1 2 MD follows the PROPOSED end: 02-03, not 02-24.
        fun chain(order: List<UInt>): MultiTeamResult {
            val runs = mapOf(
                a to team(a, "A", listOf(item(11u, "4", "2027-02-22", "2027-02-23", project = 1u))),
                b to team(b, "B", listOf(item(21u, "2", project = 2u))),
            )
            return ScheduleKernels.proposeMany(inputs(order.map { runs.getValue(it) }, links = listOf(link(1u, ms(11u), ms(21u)))))
        }
        val forward = chain(listOf(a, b))
        assertEquals(listOf(a, b), forward.order)
        assertEquals(mapOf(11u to "02-01..02-02"), forward.spans(a))
        assertEquals(mapOf(21u to "02-03..02-03"), forward.spans(b))
        assertEquals(1, forward.passes)
        assertTrue(forward.settled, "an acyclic team graph settles in one pass")
        assertEquals(forward, chain(listOf(b, a)))
    }

    @Test
    fun `a team cycle with room to spare settles in two passes and the late team follows the early one`() {
        // A (50 MD/week = 10/day, nothing contends): a1 4 MD -> b1 -> a2 2 MD, A's order [a2, a1]. A has two movables, B one: A first.
        // Pass 1: a2 02-01 (b1 has no dates yet), a1 02-01, b1 02-02. Pass 2: a2 waits for b1: 02-03; a1 and b1 stay -> B unchanged.
        val input = cycleWorld(aMdPerWeek = "50")
        val result = ScheduleKernels.proposeMany(input)
        assertEquals(listOf(a, b), result.order)
        assertEquals(2, result.passes)
        assertTrue(result.settled, "A changed in pass 2, but A's only edge (a1 -> b1) points forward")
        assertEquals(mapOf(12u to "02-03..02-03", 11u to "02-01..02-01"), result.spans(a))
        assertEquals(mapOf(21u to "02-02..02-02"), result.spans(b))
    }

    @Test
    fun `a contended cycle takes three passes and stopping early reports it unsettled`() {
        // A at 10 MD/week (2/day): pass 1 a2 02-01, a1 02-02..02-03, b1 02-04. Pass 2: a2 02-05 (after b1), a1 02-01..02-02, b1 02-03.
        // Pass 3: a2 02-04 (after b1's new end); B repeats itself, so nothing read by an earlier team changed: settled.
        val input = cycleWorld()
        val result = ScheduleKernels.proposeMany(input)
        assertEquals(3, result.passes)
        assertTrue(result.settled)
        assertEquals(mapOf(12u to "02-04..02-04", 11u to "02-01..02-02"), result.spans(a))
        assertEquals(mapOf(21u to "02-03..02-03"), result.spans(b))

        val two = ScheduleKernels.proposeMany(cycleWorld(maxPasses = 2))
        assertEquals(2, two.passes)
        assertTrue(!two.settled, "B moved in pass 2 and A (earlier) read the old date")
        assertEquals("02-05..02-05", two.spans(a).getValue(12u), "the last pass's dates stand")
        assertEquals("02-03..02-03", two.spans(b).getValue(21u))
    }

    @Test
    fun `postCheckMany of an unsettled run lists the cross-team link in both teams, unscheduled then violated`() {
        val input = cycleWorld(aMdPerWeek = "50", maxPasses = 1)
        val result = ScheduleKernels.proposeMany(input)
        assertEquals(1, result.passes)
        assertTrue(!result.settled)
        val checks = ScheduleKernels.postCheckMany(input, result)
        for (teamId in listOf(a, b)) {
            val links = checks.getValue(teamId).links
            assertEquals(setOf(1u, 2u), links.map { it.linkId }.toSet(), "both links touch both teams")
            val back = links.single { it.linkId == 2u }
            assertEquals(DependencyStatus.UNSCHEDULED, back.before)
            assertEquals(DependencyStatus.VIOLATED, back.after.status, "a2 starts 02-01 but must wait for b1, ending 02-02")
            assertEquals(DependencyStatus.OK, links.single { it.linkId == 1u }.after.status)
            assertEquals(DependencyStatus.VIOLATED, links.first().after.status, "violated first")
        }
    }

    /** a1 (id 11, 4 MD) -> b1 (id 21, 2 MD) -> a2 (id 12, 2 MD, first in A's order); links 1 and 2. */
    private fun cycleWorld(aMdPerWeek: String = "10", maxPasses: Int = MAX_CROSS_TEAM_PASSES) = inputs(
        listOf(
            team(a, "A", listOf(item(11u, "4", pos = 2), item(12u, "2", pos = 1)), aMdPerWeek),
            team(b, "B", listOf(item(21u, "2", project = 2u))),
        ),
        links = listOf(link(1u, ms(11u), ms(21u)), link(2u, ms(21u), ms(12u))),
        maxPasses = maxPasses,
    )

    // ---- fixed things and project ends ----------------------------------------------------------------------------------------

    @Test
    fun `a pinned future milestone is fixed everywhere - it bounds the other team's successor and is in no placement`() {
        val pinnedB = team(b, "B", listOf(item(21u, "2", "2027-02-15", "2027-02-16", project = 2u, pinned = true)))
        val successor = team(a, "A", listOf(item(11u, "2")))
        val links = listOf(link(1u, ms(21u), ms(11u)))
        val result = ScheduleKernels.proposeMany(inputs(listOf(successor, pinnedB), links = links))
        assertEquals(listOf(b, a), result.order)
        assertEquals(mapOf(21u to "02-15..02-16"), result.spans(b))
        assertTrue(result.byTeam.getValue(b).placements.isEmpty() && result.byTeam.getValue(b).unplaced.isEmpty())
        assertEquals(mapOf(11u to "02-17..02-17"), result.spans(a))
        assertEquals(1, result.passes)
        // The same two teams with the pin off: B re-plans to the first free day and A follows it there.
        val free = ScheduleKernels.proposeMany(
            inputs(listOf(successor, team(b, "B", listOf(item(21u, "2", "2027-02-15", "2027-02-16", project = 2u)))), links = links),
        )
        assertEquals(mapOf(21u to "02-01..02-01"), free.spans(b))
        assertEquals(mapOf(11u to "02-02..02-02"), free.spans(a))
    }

    @Test
    fun `a project end resolves to the teams holding its milestones, and the successor follows its PROPOSED derived end`() {
        // P (project 10) holds B's b1 (4 MD: 02-01..02-02) and a fixed foreign milestone that ended long before; m (A, 2 MD) waits for P.
        val foreign = listOf(fact(91u, 10u, 9u, "2027-01-11", "2027-01-12"))
        val input = inputs(
            listOf(team(a, "A", listOf(item(11u, "2", project = 1u))), team(b, "B", listOf(item(21u, "4", project = 10u)))),
            foreign,
            listOf(link(1u, pr(10u), ms(11u))),
        )
        val result = ScheduleKernels.proposeMany(input)
        assertEquals(listOf(b, a), result.order, "the project end puts B before A")
        assertEquals(mapOf(21u to "02-01..02-02"), result.spans(b))
        assertEquals(mapOf(11u to "02-03..02-03"), result.spans(a))
        assertEquals(1, result.passes)
    }

    // ---- the team order ------------------------------------------------------------------------------------------------------

    @Test
    fun `in a team cycle the team with more movable milestones goes first, then the lower name, then the id`() {
        fun orderOf(teams: List<TeamRun>) = ScheduleKernels.proposeMany(
            inputs(teams, links = listOf(link(1u, ms(11u), ms(21u)), link(2u, ms(22u), ms(12u)))),
        ).order

        fun two(first: UInt) = listOf(item(first, "1", project = first), item(first + 1u, "1", project = first))
        // 3 movables (B) beat 2 (A) although A's name sorts first.
        assertEquals(
            listOf(b, a),
            orderOf(listOf(team(a, "Alpha", two(11u)), team(b, "Zulu", two(21u) + item(23u, "1", project = 2u)))),
        )
        // Equal counts: the name, case-insensitively - "alpha" (id 2) before "Zulu" (id 1).
        assertEquals(listOf(b, a), orderOf(listOf(team(a, "Zulu", two(11u)), team(b, "alpha", two(21u)))))
        // The same name: the lower id.
        assertEquals(listOf(a, b), orderOf(listOf(team(b, "Same", two(21u)), team(a, "SAME", two(11u)))))
    }

    @Test
    fun `an in-progress or pinned milestone is not movable for the team order`() {
        // A: two movables and one in progress (started 01-25) = 2. B: two movables and one pinned future milestone = 2. Equal -> the name.
        // Both name arrangements run, so counting only the in-progress item or only the pinned one flips one of them.
        val aItems = listOf(
            item(11u, "1", project = 1u),
            item(12u, "1", project = 1u),
            item(13u, "1", "2027-01-25", "2027-02-05", project = 1u),
        )
        val bItems = listOf(
            item(21u, "1", project = 2u),
            item(22u, "1", project = 2u),
            item(23u, "1", "2027-03-01", "2027-03-01", project = 2u, pinned = true),
        )
        fun orderOf(aName: String, bName: String) = ScheduleKernels.proposeMany(
            inputs(
                listOf(team(b, bName, bItems), team(a, aName, aItems)),
                links = listOf(link(1u, ms(11u), ms(21u)), link(2u, ms(22u), ms(12u))),
            ),
        ).order
        assertEquals(listOf(a, b), orderOf("Alpha", "Zulu"), "counting the pinned item would put B first")
        assertEquals(listOf(b, a), orderOf("Zulu", "Alpha"), "counting the in-progress item would put A first")
    }

    @Test
    fun `a team downstream of a cycle is never placed before it, and follows the cycle's FINAL dates`() {
        // A and B form a team cycle (a1 -> b1 and b1 -> a0, a0 and b0 being in progress), one movable each; C is fed only by B (b1 -> c1)
        // and has the most movables, so a pick among ALL remaining teams would place C first. The source component {A, B} goes first (the
        // tie on one movable: the name), then C. Pass 1: a1 (4 MD) 02-01..02-02, b1 02-03, c1 02-04; pass 2 repeats it: settled.
        val running = { id: UInt, project: UInt -> item(id, "1", "2027-01-25", "2027-01-29", project = project) }
        val input = inputs(
            listOf(
                team(c, "Aardvark", listOf(item(31u, "2", project = 3u), item(32u, "2", project = 3u), item(33u, "2", project = 3u))),
                team(b, "Bravo", listOf(running(21u, 2u), item(22u, "2", project = 2u))),
                team(a, "Alpha", listOf(running(11u, 1u), item(12u, "4", project = 1u))),
            ),
            links = listOf(link(1u, ms(12u), ms(22u)), link(2u, ms(22u), ms(11u)), link(3u, ms(22u), ms(31u))),
        )
        val result = ScheduleKernels.proposeMany(input)
        assertEquals(listOf(a, b, c), result.order)
        assertEquals(2, result.passes)
        assertTrue(result.settled)
        assertEquals("02-01..02-02", result.spans(a).getValue(12u))
        assertEquals("02-03..02-03", result.spans(b).getValue(22u))
        assertEquals("02-04..02-04", result.spans(c).getValue(31u), "the day after b1's final end")
    }

    // ---- the post-check ------------------------------------------------------------------------------------------------------

    @Test
    fun `a link between two run teams is listed for both and a project link of one team only for that team`() {
        // Links: 1 = a1 -> b1 (milestone ends: both teams). 2 = P -> Q, both projects hold only B's milestones, whose derived spans move.
        val input = inputs(
            listOf(
                team(a, "A", listOf(item(11u, "4", project = 1u))),
                team(b, "B", listOf(item(21u, "2", project = 10u), item(22u, "2", "2027-03-01", "2027-03-02", project = 11u))),
            ),
            links = listOf(link(1u, ms(11u), ms(21u)), link(2u, pr(10u), pr(11u))),
        )
        val checks = ScheduleKernels.postCheckMany(input, ScheduleKernels.proposeMany(input))
        assertEquals(listOf(1u), checks.getValue(a).links.map { it.linkId })
        assertEquals(listOf(1u, 2u), checks.getValue(b).links.map { it.linkId }.sorted())
    }

    @Test
    fun `checkMany judges the given spans - an unticked move stays at its stored dates and the weeks follow`() {
        // a1 stored 02-22..02-23 would move to 02-01..02-02; b1 (unscheduled) to 02-03. Keep a1 stored, move b1: the link reads OK still.
        val input = inputs(
            listOf(
                team(a, "A", listOf(item(11u, "4", "2027-02-22", "2027-02-23", project = 1u))),
                team(b, "B", listOf(item(21u, "2", project = 2u))),
            ),
            links = listOf(link(1u, ms(11u), ms(21u))),
        )
        val after = mapOf(a to mapOf(11u to span("2027-02-22", "2027-02-23")), b to mapOf(21u to span("2027-02-03")))
        val checks = ScheduleKernels.checkMany(input, after)
        val link = checks.getValue(b).links.single()
        assertEquals(DependencyStatus.UNSCHEDULED, link.before)
        assertEquals(DependencyStatus.VIOLATED, link.after.status, "b1 starts 02-03, a1 ends 02-23")
        assertEquals(listOf("2.00"), checks.getValue(b).weeks.map { it.load.toString() })
        assertEquals(listOf("4.00"), checks.getValue(a).weeks.map { it.load.toString() })
    }

    // ---- determinism and failure ---------------------------------------------------------------------------------------------

    @Test
    fun `shuffled teams, items, plan and links give the identical result`() {
        val teams = listOf(
            team(a, "A", listOf(item(11u, "4", pos = 2), item(12u, "2", pos = 1), item(13u, "3", project = 3u))),
            team(b, "B", listOf(item(21u, "2", project = 2u), item(22u, "5", "2027-02-10", "2027-02-12", project = 2u))),
            team(c, "C", listOf(item(31u, "3", project = 4u), item(32u, "1", project = 4u))),
        )
        val links = listOf(
            link(1u, ms(11u), ms(21u)),
            link(2u, ms(21u), ms(12u)),
            link(3u, pr(2u), ms(31u)),
            link(4u, ms(32u), ms(13u), DependencyType.SS, 1),
        )
        val plain = inputs(teams, listOf(fact(91u, 9u, 9u, "2027-02-02", "2027-02-04")), links)
        val expected = ScheduleKernels.proposeMany(plain)
        repeat(8) { seed ->
            val random = Random(seed)
            val shuffled = plain.copy(
                teams = teams.shuffled(random).map { it.copy(team = it.team.shuffled(random), periods = it.periods) },
                plan = plain.plan.shuffled(random),
                links = links.shuffled(random),
            )
            assertEquals(expected, ScheduleKernels.proposeMany(shuffled), "seed $seed")
        }
    }

    @Test
    fun `a cyclic plan fails closed once, and a team listed twice is refused`() {
        val cyclic = inputs(
            listOf(team(a, "A", listOf(item(11u, "1"))), team(b, "B", listOf(item(21u, "1", project = 2u)))),
            links = listOf(link(1u, ms(11u), ms(21u)), link(2u, ms(21u), ms(11u))),
        )
        assertFailsWith<IllegalStateException> { ScheduleKernels.proposeMany(cyclic) }
        val twice = inputs(listOf(team(a, "A", listOf(item(11u, "1"))), team(a, "A again", listOf(item(12u, "1")))))
        assertFailsWith<IllegalArgumentException> { ScheduleKernels.proposeMany(twice) }
        assertFailsWith<IllegalArgumentException> { ScheduleKernels.proposeMany(inputs(listOf(team(a, "A", emptyList())), maxPasses = 0)) }
    }
}
