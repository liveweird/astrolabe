package ch.nokillswit

import ch.nokillswit.infra.time.WorkingCalendar
import ch.nokillswit.planning.CheckedLink
import ch.nokillswit.planning.DaySpan
import ch.nokillswit.planning.DependencyListKernels
import ch.nokillswit.planning.DependencyListRow
import ch.nokillswit.planning.DependencyListTotals
import ch.nokillswit.planning.DependencyStatus
import ch.nokillswit.planning.DependencyType
import ch.nokillswit.planning.EndpointKind
import ch.nokillswit.planning.EndpointRef
import ch.nokillswit.planning.MilestoneFactRow
import ch.nokillswit.planning.PlanLinkFact
import ch.nokillswit.planning.PlanMilestoneFact
import ch.nokillswit.planning.PlanProjectFact
import ch.nokillswit.planning.ProjectDependency
import ch.nokillswit.planning.ProjectDependencyCan
import ch.nokillswit.planning.RoadmapKernels
import ch.nokillswit.planning.DEPENDENCY_ORDER
import java.time.LocalDate
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * The dependency list as pure functions (no server, no database): hand-built facts of a small world on [WorkingCalendar.MON_FRI]
 * (2027-03-08 is a Monday). Projects 1 "Alpha" (milestones 11 "Pred", 12 "Inside"), 2 "Beta" (21 "Next", 22 "Tray" unscheduled, 23
 * "early", 24 "Dup") and 3 "Gamma" (nothing scheduled); teams 5 "Platform" and 6 "Core". Nine links, three of them violated (one
 * inside project 1) and two unscheduled; link 7 and link 3 tie on a shortfall of ten working days, links 8 and 9 on everything.
 */
class DependencyListKernelsTest {
    private fun day(date: String) = LocalDate.parse(date)

    private fun span(start: String, end: String) = DaySpan(day(start), day(end))

    private fun milestone(id: UInt, project: UInt, team: UInt, name: String, dates: DaySpan?) =
        MilestoneFactRow(PlanMilestoneFact(id, project, team, dates), if (team == 5u) "Platform" else "Core", name)

    private val milestones = listOf(
        milestone(11u, 1u, 5u, "Pred", span("2027-03-08", "2027-03-12")),
        milestone(12u, 1u, 5u, "Inside", span("2027-03-08", "2027-03-10")),
        milestone(21u, 2u, 6u, "Next", span("2027-03-15", "2027-03-19")),
        milestone(22u, 2u, 6u, "Tray", null),
        milestone(23u, 2u, 6u, "early", span("2027-03-01", "2027-03-03")),
        milestone(24u, 2u, 6u, "Dup", span("2027-03-15", "2027-03-19")),
    )
    private val facts = milestones.map { it.fact }
    private val projectNames = mapOf(1u to "Alpha", 2u to "Beta", 3u to "Gamma")
    private val spans = RoadmapKernels.projectSpans(facts)

    private fun m(id: UInt) = EndpointRef(EndpointKind.MILESTONE, id)

    private fun p(id: UInt) = EndpointRef(EndpointKind.PROJECT, id)

    private fun link(id: UInt, from: EndpointRef, to: EndpointRef) = PlanLinkFact(id, from, to, DependencyType.FS, 0)

    /** Link ids 1..9 as the module list above describes; the input order is deliberately NOT the id order. */
    private val links = listOf(
        link(9u, m(11u), m(24u)),
        link(1u, m(11u), m(21u)),
        link(2u, m(11u), m(12u)),
        link(3u, m(11u), m(23u)),
        link(4u, p(1u), m(21u)),
        link(5u, m(11u), m(22u)),
        link(6u, p(3u), m(21u)),
        link(7u, m(21u), p(1u)),
        link(8u, m(11u), m(24u)),
    )

    private val checked: List<CheckedLink> = RoadmapKernels.checkedLinks(
        links, projectNames.keys.map { PlanProjectFact(it, null, null) }, facts, spans, WorkingCalendar.MON_FRI,
    )

    private fun view(maxRows: Int = 1_000, revision: Long = 7) =
        DependencyListKernels.view(revision, checked, milestones, projectNames, spans, maxRows)

    @Test
    fun `the totals count every link once, a violated link inside one project included`() {
        assertEquals(9, checked.size, "every link resolves")
        assertEquals(DependencyListTotals(links = 9, violated = 3, unscheduled = 2), DependencyListKernels.totals(checked))
        assertEquals(DependencyListTotals(0, 0, 0), DependencyListKernels.totals(emptyList()))
        val inside = checked.single { it.link.id == 2u }
        assertEquals(inside.predecessorProjectId, inside.successorProjectId)
        assertEquals(DependencyStatus.VIOLATED, inside.check.status)
        assertEquals(1, DependencyListKernels.totals(listOf(inside)).violated)
    }

    @Test
    fun `the order is violated by the largest shortfall, then OK, then unscheduled, names case-insensitively, then the id`() {
        val rows = view().dependencies
        // 7 and 3 are both ten working days short ("Alpha" sorts before "early"); 2 is five; the OK links by successor name ("Dup"
        // twice, tied on everything but the id, then "Next" by predecessor name "Alpha" before "Pred"); the unscheduled ones by name.
        assertEquals(listOf(7u, 3u, 2u, 8u, 9u, 4u, 1u, 6u, 5u), rows.map { it.id })
        assertEquals(listOf(10, 10, 5), rows.take(3).map { it.check.shortfallDays })
        // ONE rule: the project view's comparator over the same links gives the same order.
        val asProjectItems = rows.map {
            ProjectDependency(it.id, it.predecessor, it.successor, it.type, it.lagDays, it.check, false, ProjectDependencyCan(false, false))
        }
        assertEquals(rows.map { it.id }, asProjectItems.shuffled(kotlin.random.Random(3)).sortedWith(DEPENDENCY_ORDER).map { it.id })
    }

    @Test
    fun `a milestone end carries its own project, team and dates, a project end its derived span and no team`() {
        val byId = view().dependencies.associateBy { it.id }
        val one = byId.getValue(1u)
        assertEquals(EndpointKind.MILESTONE, one.predecessor.kind)
        assertEquals(
            listOf<Any?>(11u, "Pred", 1u, "Alpha", 5u, "Platform", "2027-03-08", "2027-03-12"),
            with(one.predecessor) { listOf(id, name, projectId, projectName, teamId, teamName, startDate, endDate) },
        )
        assertEquals(
            listOf<Any?>(21u, "Next", 2u, "Beta", 6u, "Core"),
            with(one.successor) { listOf(id, name, projectId, projectName, teamId, teamName) },
        )
        assertEquals(DependencyType.FS, one.type)
        assertEquals(0, one.lagDays)
        assertEquals(DependencyStatus.OK, one.check.status)
        assertEquals("2027-03-15", one.check.requiredDate)

        val fromProject = byId.getValue(4u).predecessor
        assertEquals(EndpointKind.PROJECT, fromProject.kind)
        assertEquals(
            listOf<Any?>(1u, "Alpha", 1u, "Alpha"),
            listOf(fromProject.id, fromProject.name, fromProject.projectId, fromProject.projectName),
        )
        assertNull(fromProject.teamId)
        assertNull(fromProject.teamName)
        assertEquals("2027-03-08" to "2027-03-12", fromProject.startDate to fromProject.endDate, "the derived span of its two milestones")

        val empty = byId.getValue(6u)
        assertEquals(DependencyStatus.UNSCHEDULED, empty.check.status)
        assertEquals("Gamma", empty.predecessor.name)
        assertNull(empty.predecessor.startDate, "nothing scheduled: no dates")
        assertNull(empty.predecessor.endDate)
        val tray = byId.getValue(5u).successor
        assertEquals("Tray", tray.name)
        assertNull(tray.startDate)
        assertNull(tray.endDate)
        assertEquals(6u, tray.teamId, "an unscheduled milestone still has its team")
    }

    @Test
    fun `a cut keeps the first rows of the order and says so, while the totals count every link`() {
        val whole = view()
        assertFalse(whole.truncated)
        assertEquals(9, whole.dependencies.size)
        assertEquals(7L, whole.revision)
        val cut = view(maxRows = 3)
        assertTrue(cut.truncated)
        assertEquals(whole.dependencies.take(3), cut.dependencies)
        assertEquals(whole.totals, cut.totals)
        assertEquals(3, cut.totals.violated)
        assertTrue(cut.dependencies.all { it.check.status == DependencyStatus.VIOLATED }, "a cut that keeps the violated rows")
        assertFalse(view(maxRows = 9).truncated, "exactly the cap is not a cut")
        assertTrue(view(maxRows = 8).truncated)
        val none = DependencyListKernels.view(1, emptyList(), emptyList(), emptyMap(), emptyMap(), 1_000)
        assertEquals(emptyList<DependencyListRow>(), none.dependencies)
        assertFalse(none.truncated)
        assertEquals(DependencyListTotals(0, 0, 0), none.totals)
    }
}
