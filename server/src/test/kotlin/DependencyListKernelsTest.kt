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
        DependencyListKernels.view(revision, checked, milestones, projectNames, maxRows)

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
        // ONE rule: the project view's comparator over the same links (their ends resolved through the lists) gives the same order.
        val document = view()
        val asProjectItems = rows.map {
            ProjectDependency(
                it.id, document.endOf(it.predecessor), document.endOf(it.successor), it.type, it.lagDays, it.check, false,
                ProjectDependencyCan(false, false),
            )
        }
        assertEquals(rows.map { it.id }, asProjectItems.shuffled(kotlin.random.Random(3)).sortedWith(DEPENDENCY_ORDER).map { it.id })
    }

    @Test
    fun `a row names its ends by kind and id, and the lists hold each named milestone with its project and team, once and by id`() {
        val document = view()
        val byId = document.dependencies.associateBy { it.id }
        val one = byId.getValue(1u)
        assertEquals(m(11u), one.predecessor)
        assertEquals(m(21u), one.successor)
        assertEquals(DependencyType.FS, one.type)
        assertEquals(0, one.lagDays)
        assertEquals(DependencyStatus.OK, one.check.status)
        assertEquals("2027-03-15", one.check.requiredDate)
        assertEquals(p(1u), byId.getValue(4u).predecessor)
        assertEquals(p(3u), byId.getValue(6u).predecessor)

        // Every end resolves through the lists to what the end used to carry (without dates).
        assertEquals(
            listOf<Any?>(11u, "Pred", 1u, "Alpha", 5u, "Platform"),
            with(document.endOf(one.predecessor)) { listOf(id, name, projectId, projectName, teamId, teamName) },
        )
        val fromProject = document.endOf(byId.getValue(4u).predecessor)
        assertEquals(
            listOf<Any?>(EndpointKind.PROJECT, 1u, "Alpha", 1u, "Alpha", null, null),
            with(fromProject) { listOf(kind, id, name, projectId, projectName, teamId, teamName) },
        )
        assertEquals("Tray", document.endOf(byId.getValue(5u).successor).name)
        assertEquals(6u, document.endOf(byId.getValue(5u).successor).teamId, "an unscheduled milestone still has its team")

        // The lists: the milestones named as an end (22 "Tray" and 23 and 24 too), each once, by id; the projects of those and the
        // project ends; the teams of the milestones.
        assertEquals(listOf(11u, 12u, 21u, 22u, 23u, 24u), document.milestones.map { it.id })
        assertEquals(listOf(1u to "Alpha", 2u to "Beta", 3u to "Gamma"), document.projects.map { it.id to it.name })
        assertEquals(listOf(5u to "Platform", 6u to "Core"), document.teams.map { it.id to it.name })
        document.assertListsHoldExactlyWhatTheRowsName()
    }

    @Test
    fun `a link between two projects names those projects and no milestone, no team`() {
        val projectsOnly = RoadmapKernels.checkedLinks(
            listOf(link(1u, p(1u), p(3u))),
            projectNames.keys.map { PlanProjectFact(it, null, null) },
            facts,
            spans,
            WorkingCalendar.MON_FRI,
        )
        val document = DependencyListKernels.view(1, projectsOnly, milestones, projectNames, 1_000)
        assertEquals(emptyList(), document.milestones)
        assertEquals(emptyList(), document.teams)
        assertEquals(listOf(1u to "Alpha", 3u to "Gamma"), document.projects.map { it.id to it.name })
        document.assertListsHoldExactlyWhatTheRowsName()
    }

    @Test
    fun `a cut keeps the first rows of the order and says so, while the totals count every link`() {
        val whole = view()
        assertFalse(whole.truncated)
        assertEquals(9, whole.dependencies.size)
        assertEquals(7L, whole.revision)
        val cut = view(maxRows = 3)
        val cut1 = view(maxRows = 1)
        assertTrue(cut.truncated)
        assertEquals(whole.dependencies.take(3), cut.dependencies)
        assertEquals(whole.totals, cut.totals)
        assertEquals(3, cut.totals.violated)
        assertTrue(cut.dependencies.all { it.check.status == DependencyStatus.VIOLATED }, "a cut that keeps the violated rows")
        // The lists name only what the KEPT rows name: the first row (link 7, milestone 21 to project 1) and nothing a cut row names.
        assertEquals(listOf(21u), cut1.milestones.map { it.id })
        assertEquals(listOf(1u, 2u), cut1.projects.map { it.id })
        assertEquals(listOf(6u), cut1.teams.map { it.id })
        cut1.assertListsHoldExactlyWhatTheRowsName()
        cut.assertListsHoldExactlyWhatTheRowsName()
        assertFalse(view(maxRows = 9).truncated, "exactly the cap is not a cut")
        assertTrue(view(maxRows = 8).truncated)
        val none = DependencyListKernels.view(1, emptyList(), emptyList(), emptyMap(), 1_000)
        assertEquals(emptyList<DependencyListRow>(), none.dependencies)
        assertTrue(none.projects.isEmpty() && none.teams.isEmpty() && none.milestones.isEmpty(), "no row, no name")
        assertFalse(none.truncated)
        assertEquals(DependencyListTotals(0, 0, 0), none.totals)
    }
}
