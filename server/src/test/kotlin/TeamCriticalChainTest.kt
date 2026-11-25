package ch.nokillswit

import ch.nokillswit.planning.ChainRef
import ch.nokillswit.planning.CriticalChain
import ch.nokillswit.planning.CriticalPathResult
import ch.nokillswit.planning.CriticalPathsLoad
import ch.nokillswit.planning.DaySpan
import ch.nokillswit.planning.DependencyType
import ch.nokillswit.planning.EndpointKind
import ch.nokillswit.planning.EndpointRef
import ch.nokillswit.planning.MilestoneFactRow
import ch.nokillswit.planning.PlanLinkFact
import ch.nokillswit.planning.PlanMilestoneFact
import ch.nokillswit.planning.teamCriticalChain
import java.time.LocalDate
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

/**
 * The pure assembly of the team view's `criticalChain` block (`teamCriticalChain`): the union of the per-project chains, one member
 * per kind and id (`hops` the minimum, `chainOf` the union, ascending), the order, both caps and "every link's ends are listed
 * members". Hand-built [CriticalPathsLoad]s: no kernel, no database. Projects 1 and 2 are the team's; project 9 holds the members.
 */
class TeamCriticalChainTest {
    private fun ms(id: UInt) = EndpointRef(EndpointKind.MILESTONE, id)

    private fun fact(id: UInt, project: UInt = 9u, start: String = "2027-02-01", end: String = start) =
        PlanMilestoneFact(id, project, 5u, DaySpan(LocalDate.parse(start), LocalDate.parse(end)))

    private fun row(id: UInt, name: String = "m$id", team: String = "Team Five", project: UInt = 9u, start: String = "2027-02-01") =
        MilestoneFactRow(fact(id, project, start), team, name)

    private fun link(id: UInt, pred: EndpointRef, succ: EndpointRef) = PlanLinkFact(id, pred, succ, DependencyType.FS, 0)

    private fun chain(members: List<Pair<EndpointRef, Int>>, vararg links: UInt) =
        CriticalPathResult.EMPTY.copy(chain = CriticalChain(members.map { ChainRef(it.first, it.second) }, links.toSet()))

    private fun load(
        results: Map<UInt, CriticalPathResult>,
        rows: List<MilestoneFactRow>,
        links: List<PlanLinkFact> = emptyList(),
    ) = CriticalPathsLoad(results, rows, mapOf(1u to "Alpha", 2u to "Beta", 9u to "Gamma", 8u to "Delta"), links)

    @Test
    fun `nothing on any chain is an empty block, not truncated`() {
        val block = teamCriticalChain(load(mapOf(1u to CriticalPathResult.EMPTY), emptyList()), 100, 500)
        assertEquals(emptyList(), block.members)
        assertEquals(emptyList(), block.links)
        assertFalse(block.truncated)
        assertEquals(emptyList(), teamCriticalChain(CriticalPathsLoad.EMPTY, 100, 500).members)
    }

    @Test
    fun `a member on two projects' chains is one row - the fewest hops, both projects ascending, its link once`() {
        val results = mapOf(
            2u to chain(listOf(ms(10u) to 1, ms(11u) to 2), 201u),
            1u to chain(listOf(ms(10u) to 3), 201u),
        )
        val block = teamCriticalChain(load(results, listOf(row(10u), row(11u)), listOf(link(201u, ms(11u), ms(10u)))), 100, 500)
        assertEquals(listOf(10u to 1, 11u to 2), block.members.map { it.id to it.hops })
        assertEquals(listOf(1u, 2u), block.members.first().chainOf)
        assertEquals(listOf(2u), block.members.last().chainOf)
        assertEquals(listOf(201u), block.links.map { it.id })
        assertFalse(block.truncated)
    }

    @Test
    fun `a member row names its team and project and carries its stored dates, and a project member its derived span`() {
        val rows = listOf(row(10u, name = "Design", start = "2027-02-08"), row(11u, project = 8u, start = "2027-02-01"))
        val results = mapOf(1u to chain(listOf(ms(10u) to 1, EndpointRef(EndpointKind.PROJECT, 8u) to 1)))
        val block = teamCriticalChain(load(results, rows), 100, 500)
        val milestone = block.members.single { it.kind == EndpointKind.MILESTONE }
        assertEquals(
            listOf("Design", "Team Five", "Gamma", "2027-02-08", "2027-02-08"),
            listOf(milestone.name, milestone.teamName, milestone.projectName, milestone.startDate, milestone.endDate),
        )
        assertEquals(5u to 9u, milestone.teamId to milestone.projectId)
        val project = block.members.single { it.kind == EndpointKind.PROJECT }
        assertEquals(listOf("Delta", 8u, "Delta"), listOf(project.name, project.projectId, project.projectName))
        assertEquals(null to null, project.teamId to project.teamName, "a whole project has no team")
        assertEquals("2027-02-01" to "2027-02-01", project.startDate to project.endDate, "the derived span of its scheduled milestones")
    }

    @Test
    fun `the order is hops, start, end, name case-insensitively, kind, id`() {
        val rows = listOf(
            row(1u, name = "b", start = "2027-02-08"), row(2u, name = "B", start = "2027-02-08"), row(3u, name = "a", start = "2027-02-15"),
            row(4u, name = "z", start = "2027-02-01"), row(5u, name = "c", start = "2027-03-01"),
        )
        val members = listOf(ms(5u) to 2, ms(4u) to 2, ms(3u) to 1, ms(2u) to 1, ms(1u) to 1)
        val block = teamCriticalChain(load(mapOf(1u to chain(members)), rows), 100, 500)
        // hops 1: the 02-08 pair (b before B only by id: equal when folded), then 02-15; hops 2: 02-01 before 03-01.
        assertEquals(listOf(1u, 2u, 3u, 4u, 5u), block.members.map { it.id })
    }

    @Test
    fun `the member cap keeps every nearer member, cuts the far end, drops the links that lost an end and says so`() {
        // A chain m5 -> m4 -> m3 -> m2 -> m1 (m1 nearest to the team): hops 1 to 5, links 101 (m2, m1) to 104 (m5, m4).
        val rows = (1u..5u).map { row(it) }
        val members = (1u..5u).map { ms(it) to it.toInt() }
        val links = (1u..4u).map { link(100u + it, ms(it + 1u), ms(it)) }
        val result = chain(members, 101u, 102u, 103u, 104u)
        val block = teamCriticalChain(load(mapOf(1u to result), rows, links), maxMembers = 3, maxLinks = 500)
        assertEquals(listOf(1u, 2u, 3u), block.members.map { it.id }, "the nearest three")
        assertEquals(listOf(1, 2, 3), block.members.map { it.hops })
        assertTrue(block.truncated)
        val listed = block.members.map { EndpointRef(it.kind, it.id) }.toSet()
        assertTrue(block.links.all { it.predecessor in listed && it.successor in listed }, "every link's ends are listed members")
        assertEquals(listOf(101u, 102u), block.links.map { it.id }, "only the links between two kept members, nearest first")
    }

    @Test
    fun `the link cap keeps the nearest links first and says so, and a link with an end outside the members is never listed`() {
        val rows = (1u..4u).map { row(it) }
        val members = listOf(ms(1u) to 1, ms(2u) to 1, ms(3u) to 2, ms(4u) to 2)
        val links = listOf(
            link(105u, ms(3u), ms(4u)), link(104u, ms(1u), ms(2u)), link(103u, ms(2u), ms(3u)),
            link(106u, ms(4u), ms(77u)), // an end that is the team's own milestone: no member
        )
        val result = chain(members, 103u, 104u, 105u, 106u)
        val roomy = teamCriticalChain(load(mapOf(1u to result), rows, links), maxMembers = 100, maxLinks = 500)
        assertEquals(listOf(104u, 103u, 105u), roomy.links.map { it.id }, "the larger of the ends' hops (1, 2, 2), then the id")
        assertFalse(roomy.truncated, "link 106 names a milestone that is no member: that is not a cut")
        val cut = teamCriticalChain(load(mapOf(1u to result), rows, links), maxMembers = 100, maxLinks = 2)
        assertEquals(listOf(104u, 103u), cut.links.map { it.id })
        assertTrue(cut.truncated)
    }
}
