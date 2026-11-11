package ch.nokillswit

import ch.nokillswit.infra.time.WorkingCalendar
import ch.nokillswit.planning.CapacityPeriod
import ch.nokillswit.planning.DaySpan
import ch.nokillswit.planning.DependencyType
import ch.nokillswit.planning.EndpointKind
import ch.nokillswit.planning.EndpointRef
import ch.nokillswit.planning.MilestoneSpan
import ch.nokillswit.planning.OrderKey
import ch.nokillswit.planning.PlanLinkFact
import ch.nokillswit.planning.PlanMilestoneFact
import ch.nokillswit.planning.ScopeDigests
import ch.nokillswit.planning.ScopeToken
import ch.nokillswit.planning.TeamScheduleItem
import ch.nokillswit.planning.ValidatedBatchItem
import ch.nokillswit.planning.acceptsOnlyFreshDates
import ch.nokillswit.planning.holidaysDigest
import ch.nokillswit.planning.runScope
import ch.nokillswit.planning.scheduleScope
import ch.nokillswit.planning.structureDigest
import java.math.BigDecimal
import java.time.LocalDate
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNotEquals
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * The schedule scope token as a pure function (`planning/ScheduleScope.kt`): 64 hex in three parts, the structure digest (chars 0-27),
 * the holidays digest (28-55) and `asOf` (56-63). The same scope in any input order gives the same token; every input the kernel reads
 * that the milestones' schedule revisions do not cover flips the STRUCTURE part only; the Monday-Friday holidays flip the HOLIDAYS part
 * only; the team's OWN spans (and what is not linked to the team) flip nothing. The team is 1; its milestones are 10 and 11 (project 100),
 * 12 (project 101); 50 and 51 are another team's (project 102).
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

    private val asOf = day("2027-01-31")

    private fun digests(world: World = base) = ScopeDigests(
        structureDigest(scheduleScope(team, world.items, world.periods, world.plan, world.links)),
        holidaysDigest(world.holidays),
    )

    private fun hash(world: World = base, on: LocalDate = asOf) = digests(world).token(on)

    @Test
    fun `the token is 64 lowercase hex digits and does not depend on the order of any input`() {
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
    fun `each structural input flips the structure part only`() {
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
        for ((label, world) in changes) {
            val changed = hash(world)
            assertNotEquals(reference.take(STRUCTURE), changed.take(STRUCTURE), label)
            assertEquals(reference.drop(STRUCTURE), changed.drop(STRUCTURE), "$label: the holidays and asOf parts stand")
        }
    }

    @Test
    fun `a Monday-Friday holiday flips the holidays part only, a weekend one flips nothing`() {
        val reference = hash()
        val changes = mapOf(
            "a holiday added" to base.copy(holidays = base.holidays + day("2027-08-16")),
            "a holiday removed" to base.copy(holidays = listOf(day("2027-04-05"))),
        )
        for ((label, world) in changes) {
            val changed = hash(world)
            assertEquals(reference.take(STRUCTURE), changed.take(STRUCTURE), "$label: the structure part stands")
            assertNotEquals(reference.substring(STRUCTURE, STRUCTURE + HOLIDAYS), changed.substring(STRUCTURE, STRUCTURE + HOLIDAYS), label)
            assertEquals(reference.takeLast(ASOF), changed.takeLast(ASOF), "$label: the asOf part stands")
        }
        // The calendar hands the digest its Monday-Friday dates only: a Saturday holiday leaves the token alone.
        fun calendarToken(vararg dates: String) =
            digests(base.copy(holidays = WorkingCalendar(dates.associate { day(it) to "h" }).offDayDates())).token(asOf)
        assertEquals(calendarToken("2027-04-05"), calendarToken("2027-04-05", "2027-08-14"), "2027-08-14 is a Saturday")
        assertNotEquals(calendarToken("2027-04-05"), calendarToken("2027-04-05", "2027-08-16"), "2027-08-16 is a Monday")
    }

    @Test
    fun `asOf is the last 8 characters - days since 1900-01-01 in hex - and no other part reads it`() {
        val other = hash(on = day("2027-02-03"))
        assertEquals(hash().take(ASOF_AT), other.take(ASOF_AT))
        assertNotEquals(hash().takeLast(ASOF), other.takeLast(ASOF))
        assertEquals("00000000", hash(on = day("1900-01-01")).takeLast(ASOF))
        assertEquals("00000001", hash(on = day("1900-01-02")).takeLast(ASOF))
        val token = ScopeToken(hash())
        assertEquals(asOf, token.asOf())
        assertEquals(digests(), token.digests)
        assertNull(ScopeToken(hash().take(ASOF_AT) + "ffffffff").asOf(), "a day beyond the latest asOf is no proposal's")
        assertNull(ScopeToken(hash(on = day("2999-12-31"))).asOf(), "the last plan day is past the latest asOf")
        assertEquals(day("2900-01-04"), ScopeToken(hash(on = day("2900-01-04"))).asOf(), "a late year is fine while the horizon fits")
    }

    @Test
    fun `a team token and a run token never share a structure part`() {
        val run = runScope(mapOf(team to base.items), mapOf(team to "Alpha"), mapOf(team to base.periods), base.plan, base.links)
        assertNotEquals(digests().structure, structureDigest(run))
        val renamed = runScope(mapOf(team to base.items), mapOf(team to "Beta"), mapOf(team to base.periods), base.plan, base.links)
        assertNotEquals(structureDigest(run), structureDigest(renamed), "a run team's name is in its structure")
    }

    @Test
    fun `the look-again accepts a batch only when every item carries both dates and equals the fresh span`() {
        fun item(id: UInt, start: String?, end: String?) =
            ValidatedBatchItem(id, if (start != null && end != null) MilestoneSpan(day(start), day(end)) else null)
        val fresh = mapOf(10u to span("2027-02-01", "2027-02-02"), 11u to span("2027-02-03", "2027-02-03"))
        val same = listOf(item(10u, "2027-02-01", "2027-02-02"), item(11u, "2027-02-03", "2027-02-03"))
        assertTrue(acceptsOnlyFreshDates(same, fresh))
        assertTrue(acceptsOnlyFreshDates(same.take(1), fresh), "a subset of the fresh proposal")
        for (index in same.indices) {
            val moved = same.mapIndexed { i, kept -> if (i == index) item(kept.milestoneId, "2027-02-04", "2027-02-05") else kept }
            assertFalse(acceptsOnlyFreshDates(moved, fresh), "item $index carries another date")
            val unscheduled = same.mapIndexed { i, kept -> if (i == index) item(kept.milestoneId, null, null) else kept }
            assertFalse(acceptsOnlyFreshDates(unscheduled, fresh), "item $index is an unschedule pair")
        }
        assertFalse(acceptsOnlyFreshDates(same + item(12u, "2027-02-08", "2027-02-08"), fresh), "a milestone the fresh run does not hold")
        assertFalse(acceptsOnlyFreshDates(same, fresh - 11u), "a milestone the fresh run left unplaced")
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

    private companion object {
        const val STRUCTURE = 28
        const val HOLIDAYS = 28
        const val ASOF = 8
        const val ASOF_AT = STRUCTURE + HOLIDAYS
    }
}
