package ch.nokillswit

import ch.nokillswit.planning.CapacityPeriod
import ch.nokillswit.planning.DaySpan
import ch.nokillswit.planning.DependencyType
import ch.nokillswit.planning.EndpointKind
import ch.nokillswit.planning.EndpointRef
import ch.nokillswit.planning.OrderKey
import ch.nokillswit.planning.PlanLinkFact
import ch.nokillswit.planning.PlanMilestoneFact
import ch.nokillswit.planning.TeamScheduleItem
import ch.nokillswit.planning.scheduleScope
import ch.nokillswit.planning.scopeFingerprint
import java.math.BigDecimal
import java.time.LocalDate
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNotEquals
import kotlin.test.assertTrue

/**
 * The schedule scope fingerprint as a pure function (`planning/ScheduleScope.kt`): the same scope in any input order hashes the same;
 * every input the kernel reads that the milestones' schedule revisions do not cover flips it; the team's OWN spans (and what is not
 * linked to the team) do not. The team is 1; its milestones are 10 and 11 (project 100), 12 (project 101); 50 and 51 are another team's
 * (project 102).
 */
class ScheduleScopeTest {
    private val team = 1u

    private fun day(iso: String) = LocalDate.parse(iso)

    private fun span(start: String, end: String) = DaySpan(day(start), day(end))

    private fun item(
        id: UInt,
        projectId: UInt,
        estimate: String = "2",
        span: DaySpan? = null,
        position: Int? = null,
        rank: Int? = null,
        name: String = "m$id",
    ) = TeamScheduleItem(
        id, projectId, span, BigDecimal(estimate),
        OrderKey(position, rank, "p$projectId", projectId, span?.start, span?.end, name, id),
    )

    private fun fact(id: UInt, projectId: UInt, teamId: UInt, span: DaySpan? = null) = PlanMilestoneFact(id, projectId, teamId, span)

    private fun milestone(id: UInt) = EndpointRef(EndpointKind.MILESTONE, id)

    private fun project(id: UInt) = EndpointRef(EndpointKind.PROJECT, id)

    private fun link(id: UInt, from: EndpointRef, to: EndpointRef, type: DependencyType = DependencyType.FS, lag: Int = 0) =
        PlanLinkFact(id, from, to, type, lag)

    private fun period(from: String = "2027-01-04", md: String = "10", wip: Int? = null) = CapacityPeriod(day(from), BigDecimal(md), wip)

    /** One scope's inputs; the tests copy the world and change one part. */
    private data class World(
        val items: List<TeamScheduleItem>,
        val periods: List<CapacityPeriod>,
        val plan: List<PlanMilestoneFact>,
        val links: List<PlanLinkFact>,
        val holidays: List<LocalDate>,
    )

    private val base = World(
        items = listOf(
            item(10u, 100u, span = span("2027-02-01", "2027-02-05")),
            item(11u, 100u),
            item(12u, 101u, estimate = "3.50"),
        ),
        periods = listOf(period(), period("2027-06-07", "4", 2)),
        plan = listOf(
            fact(10u, 100u, team, span("2027-02-01", "2027-02-05")), fact(11u, 100u, team), fact(12u, 101u, team),
            fact(50u, 102u, 2u, span("2027-03-01", "2027-03-05")), fact(51u, 102u, 2u, span("2027-03-08", "2027-03-12")),
            fact(52u, 103u, 2u, span("2027-09-06", "2027-09-10")),
        ),
        links = listOf(
            link(1u, milestone(50u), milestone(10u)), // a foreign milestone binds a team one
            link(2u, project(102u), milestone(11u), DependencyType.SS, 2), // a foreign project (50..51) binds a team one
            link(3u, milestone(52u), milestone(50u)), // touches nothing of the team
        ),
        holidays = listOf(day("2027-04-05"), day("2027-05-03")),
    )

    private fun hash(world: World = base) =
        scopeFingerprint(scheduleScope(team, world.items, world.periods, world.plan, world.links, world.holidays))

    @Test
    fun `the hash is 64 lowercase hex digits and does not depend on the order of any input`() {
        assertTrue(Regex("^[0-9a-f]{64}$").matches(hash()))
        val shuffled = World(
            base.items.reversed(), base.periods.reversed(), base.plan.reversed(), base.links.reversed(), base.holidays.reversed(),
        )
        assertEquals(hash(), hash(shuffled))
    }

    private fun World.withItem(id: UInt, replacement: TeamScheduleItem) = copy(items = items.map { if (it.id == id) replacement else it })

    private fun World.withLink(id: UInt, replacement: PlanLinkFact) = copy(links = links.map { if (it.id == id) replacement else it })

    private fun World.withFact(id: UInt, replacement: PlanMilestoneFact) = copy(plan = plan.map { if (it.id == id) replacement else it })

    @Test
    fun `each input the kernel reads flips the hash`() {
        val first = base.links.first()
        val foreign = span("2027-03-02", "2027-03-05")
        val changes = mapOf(
            "an estimate" to base.withItem(12u, item(12u, 101u, estimate = "4")),
            "a milestone's project" to base.withItem(11u, item(11u, 101u)),
            "a capacity figure" to base.copy(periods = listOf(period(), period("2027-06-07", "5", 2))),
            "a WIP limit" to base.copy(periods = listOf(period(), period("2027-06-07", "4", 3))),
            "a period's start" to base.copy(periods = listOf(period(), period("2027-06-14", "4", 2))),
            "a period added" to base.copy(periods = base.periods + period("2027-09-06", "6")),
            "the stored order" to base.withItem(12u, item(12u, 101u, estimate = "3.50", position = 1)),
            "a link's lag" to base.withLink(1u, link(1u, first.predecessor, first.successor, lag = 3)),
            "a link's type" to base.withLink(1u, link(1u, first.predecessor, first.successor, DependencyType.SS)),
            "a link added" to base.copy(links = base.links + link(4u, milestone(11u), milestone(52u))),
            "a link removed" to base.copy(links = base.links.filter { it.id != 2u }),
            "a holiday added" to base.copy(holidays = base.holidays + day("2027-08-16")),
            "a holiday removed" to base.copy(holidays = listOf(day("2027-04-05"))),
            "a foreign predecessor milestone moved" to base.withFact(50u, fact(50u, 102u, 2u, foreign)),
            "a foreign predecessor milestone unscheduled" to base.withFact(50u, fact(50u, 102u, 2u)),
            "the derived span of a foreign predecessor project" to
                base.withFact(51u, fact(51u, 102u, 2u, span("2027-03-08", "2027-03-19"))),
            "a foreign milestone joining that project" to
                base.copy(plan = base.plan + fact(53u, 102u, 2u, span("2027-01-04", "2027-01-08"))),
            "a milestone joining the team" to base.copy(items = base.items + item(13u, 100u), plan = base.plan + fact(13u, 100u, team)),
            "a milestone leaving the team" to base.copy(items = base.items.filter { it.id != 11u }),
        )
        val reference = hash()
        for ((label, world) in changes) assertNotEquals(reference, hash(world), label)
    }

    @Test
    fun `the project rank flips the hash only when it reorders the unlisted milestones`() {
        fun ranked(rank100: Int?, rank101: Int?) = base.copy(
            items = listOf(
                item(10u, 100u, rank = rank100, span = span("2027-02-01", "2027-02-05")), item(11u, 100u, rank = rank100),
                item(12u, 101u, estimate = "3.50", rank = rank101),
            ),
        )
        // p100 < p101 by name when both are unranked; ranking 101 first reorders; ranking both the same way does not.
        assertNotEquals(hash(ranked(null, null)), hash(ranked(2, 1)))
        assertEquals(hash(ranked(null, null)), hash(ranked(1, 2)))
        assertEquals(hash(ranked(1, 2)), hash(ranked(5, 9)), "absolute rank positions are not an input, their order is")
    }

    @Test
    fun `the team's own spans, what is not linked to the team and a weekend-only change do not flip the hash`() {
        val reference = hash()
        val ownMoved = base.copy(
            items = base.items.map { if (it.id == 10u) item(10u, 100u, span = span("2027-05-03", "2027-05-07")) else it },
            plan = base.plan.map { if (it.id == 10u) fact(10u, 100u, team, span("2027-05-03", "2027-05-07")) else it },
        )
        assertEquals(reference, hash(ownMoved), "a team milestone's own span change")
        val ownScheduled = base.copy(
            items = base.items.map { if (it.id == 11u) item(11u, 100u, span = span("2027-01-04", "2027-01-05")) else it },
            plan = base.plan.map { if (it.id == 11u) fact(11u, 100u, team, span("2027-01-04", "2027-01-05")) else it },
        )
        assertEquals(reference, hash(ownScheduled), "a team milestone gaining dates (which would reorder the default tiebreak)")
        val stray = base.copy(plan = base.plan.map { if (it.id == 52u) fact(52u, 103u, 2u, span("2027-11-01", "2027-11-05")) else it })
        assertEquals(reference, hash(stray), "a foreign milestone that only an unrelated link touches")
        val renamedElsewhere = base.copy(plan = base.plan + fact(60u, 104u, 3u, span("2027-01-04", "2027-01-08")))
        assertEquals(reference, hash(renamedElsewhere), "a milestone of a third team in an unlinked project")
        val unrelatedLink = base.copy(links = base.links + link(9u, milestone(52u), project(104u)))
        assertEquals(reference, hash(unrelatedLink), "a link between two foreign entities")
    }

    @Test
    fun `a project end holding the team's own milestones sees only its foreign part`() {
        // Link 5 ends at project 100, which holds the team's 10 and 11; a foreign milestone 54 joins it.
        val linked = base.copy(links = base.links + link(5u, milestone(52u), project(100u)))
        val withForeign = linked.copy(plan = linked.plan + fact(54u, 100u, 2u, span("2027-07-05", "2027-07-09")))
        assertNotEquals(hash(linked), hash(withForeign), "the foreign milestone of that project counts")
        val ownMoved = withForeign.copy(
            items = withForeign.items.map { if (it.id == 10u) item(10u, 100u, span = span("2027-08-02", "2027-08-06")) else it },
            plan = withForeign.plan.map { if (it.id == 10u) fact(10u, 100u, team, span("2027-08-02", "2027-08-06")) else it },
        )
        assertEquals(hash(withForeign), hash(ownMoved), "the team's own milestone of it does not")
    }
}
