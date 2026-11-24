package ch.nokillswit

import ch.nokillswit.planning.BaselineCaptureComparison
import ch.nokillswit.planning.CapacityCapture
import ch.nokillswit.planning.CapacityPeriod
import ch.nokillswit.planning.CompareProject
import ch.nokillswit.planning.DependencyType
import ch.nokillswit.planning.EndpointKind
import ch.nokillswit.planning.EndpointRef
import ch.nokillswit.planning.LinkChangeKind
import ch.nokillswit.planning.LinkEndNames
import ch.nokillswit.planning.MAX_BASELINE_CAPACITY_ROWS
import ch.nokillswit.planning.MAX_BASELINE_LINK_ROWS
import ch.nokillswit.planning.MilestoneCapture
import ch.nokillswit.planning.PlanLinkFact
import java.math.BigDecimal
import java.time.LocalDate
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

/** The pure assembly of the comparison's `links` and `capacity` blocks: naming, ordering, the caps and "not captured" (no database). */
class BaselineCaptureComparisonTest {
    private val names = LinkEndNames(
        nowProjects = listOf(CompareProject(20u, "Now project", "Prog", "Stream", null, null)),
        frozenProjects = emptyList(),
        nowMilestones = listOf(MilestoneCapture(10u, 20u, 1u, "Live milestone", BigDecimal.ONE, null)),
        frozenMilestones = emptyList(),
    )

    private fun link(id: UInt, lag: Int = 0) = PlanLinkFact(
        id, EndpointRef(EndpointKind.MILESTONE, 10u), EndpointRef(EndpointKind.PROJECT, 20u), DependencyType.FS, lag,
    )

    private fun capture(id: UInt, team: UInt, from: String, md: String) =
        CapacityCapture(id, team, CapacityPeriod(LocalDate.parse(from), BigDecimal(md), null))

    @Test
    fun `a side that captured nothing answers not captured, empty, whatever the other side holds`() {
        for ((then, now) in listOf(null to listOf(link(1u)), listOf(link(1u)) to null, null to null)) {
            val links = BaselineCaptureComparison.links(then, now, names)
            assertFalse(links.captured)
            assertEquals(0, links.totals.added + links.totals.removed + links.totals.changed + links.totals.unchanged)
            assertEquals(emptyList(), links.items)
            assertFalse(links.truncated)
        }
        val capacity = BaselineCaptureComparison.capacity(null, listOf(capture(1u, 1u, "2027-01-01", "10")), mapOf(1u to "A"))
        assertFalse(capacity.captured)
        assertEquals(emptyList(), capacity.teams)
        assertEquals(0, capacity.totals.teams)
    }

    @Test
    fun `a changed link names both ends, the milestone with its project, the removed one by its frozen name`() {
        val result = BaselineCaptureComparison.links(listOf(link(1u, 0)), listOf(link(1u, 2)), names)
        val item = result.items.single()
        assertEquals(LinkChangeKind.CHANGED, item.change)
        assertEquals("Live milestone", item.predecessor.name)
        assertEquals("Now project", item.predecessor.projectName)
        assertEquals(EndpointKind.PROJECT, item.successor.kind)
        assertEquals("Now project", item.successor.name)
        assertEquals(null, item.successor.projectName, "a project end has no project name")
        assertEquals(0 to 2, item.then?.lagDays to item.now?.lagDays)
        val gone = PlanLinkFact(2u, EndpointRef(EndpointKind.MILESTONE, 99u), EndpointRef(EndpointKind.PROJECT, 98u), DependencyType.SS, 1)
        val unknown = BaselineCaptureComparison.links(listOf(gone), emptyList(), names).items.single()
        assertEquals("#99", unknown.predecessor.name, "an end found nowhere reads as its id")
    }

    @Test
    fun `the links block lists at most 1000 changed rows, by id, and the totals count them all`() {
        val added = (1..MAX_BASELINE_LINK_ROWS + 1).map { link(it.toUInt()) }
        val result = BaselineCaptureComparison.links(emptyList(), added, names)
        assertTrue(result.truncated)
        assertEquals(MAX_BASELINE_LINK_ROWS, result.items.size)
        assertEquals(MAX_BASELINE_LINK_ROWS + 1, result.totals.added)
        assertEquals(1u, result.items.first().dependencyId)
        assertEquals(MAX_BASELINE_LINK_ROWS.toUInt(), result.items.last().dependencyId)
        // Exactly the cap is not truncated.
        assertFalse(BaselineCaptureComparison.links(emptyList(), added.take(MAX_BASELINE_LINK_ROWS), names).truncated)
    }

    @Test
    fun `the capacity block lists the changed teams by name then id and cuts the rows at 2000, the totals counting every team`() {
        val teamNames = mapOf(1u to "Zeta", 2u to "alpha", 3u to "Beta", 4u to "Unchanged")
        val then = listOf(capture(1u, 1u, "2027-01-01", "10"), capture(2u, 2u, "2027-01-01", "10"), capture(4u, 4u, "2027-01-01", "5"))
        val now = listOf(
            capture(11u, 1u, "2027-01-01", "8"), capture(12u, 2u, "2027-01-01", "12"),
            capture(13u, 3u, "2027-01-01", "4"), capture(14u, 4u, "2027-01-01", "5.00"),
        )
        val result = BaselineCaptureComparison.capacity(then, now, teamNames)
        assertEquals(listOf("alpha", "Beta", "Zeta"), result.teams.map { it.teamName }, "by name, case-insensitive; no unchanged team")
        assertEquals(4 to 3, result.totals.teams to result.totals.changedTeams)
        assertFalse(result.truncated)
        assertEquals("2027-01-01", result.teams.first().changes.single().from)
        assertEquals(null, result.teams[1].changes.single().then, "Beta had no capacity then")

        // 667 teams x 3 change ranges = 2,001 rows: the list stops at 2,000 (the last team cut to two ranges), the totals stay whole.
        val many = (1..667).map { it.toUInt() }
        val manyThen = many.map { capture(it, it, "2027-01-01", "10") }
        val manyNow = many.flatMap { id ->
            listOf("2027-01-01" to "8", "2027-02-01" to "10", "2027-03-01" to "9", "2027-04-01" to "10", "2027-05-01" to "7")
                .mapIndexed { i, (from, md) -> capture(id * 10u + i.toUInt(), id, from, md) }
        }
        val capped = BaselineCaptureComparison.capacity(manyThen, manyNow, many.associateWith { "T%05d".format(it.toInt()) })
        assertTrue(capped.truncated)
        assertEquals(MAX_BASELINE_CAPACITY_ROWS, capped.teams.sumOf { it.changes.size })
        assertEquals(667, capped.teams.size)
        assertEquals(2, capped.teams.last().changes.size, "the last team is cut short")
        assertEquals(667 to 667, capped.totals.teams to capped.totals.changedTeams)
    }
}
