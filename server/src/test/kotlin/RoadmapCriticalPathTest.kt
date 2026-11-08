package ch.nokillswit

import ch.nokillswit.infra.time.WorkingCalendar
import ch.nokillswit.planning.CriticalPathKernels
import ch.nokillswit.planning.CriticalPathResult
import ch.nokillswit.planning.DaySpan
import ch.nokillswit.planning.DependencyType
import ch.nokillswit.planning.EndpointKind
import ch.nokillswit.planning.EndpointRef
import ch.nokillswit.planning.PlanLinkFact
import ch.nokillswit.planning.PlanMilestoneFact
import ch.nokillswit.planning.RoadmapCriticalPair
import ch.nokillswit.planning.RoadmapCriticalPath
import ch.nokillswit.planning.RoadmapCriticalPathKernels
import ch.nokillswit.planning.RoadmapCriticalProject
import java.time.LocalDate
import kotlin.test.Test
import kotlin.test.assertEquals

/**
 * The roadmap's roll-up of one project's critical path to projects and project pairs as a pure kernel (no server, no database), on
 * the kernel's own answer over hand-built rows. 2027-02-01 is a Monday; the viewed project is P = 3, the others X = 1, Y = 2 and Z = 4.
 * Milestone ids are below 100, link ids from 101.
 */
class RoadmapCriticalPathTest {
    private val x = 1u
    private val y = 2u
    private val p = 3u
    private val z = 4u

    private fun m(id: UInt, project: UInt, start: String?, end: String? = start) = PlanMilestoneFact(
        id, project, 1u, if (start != null && end != null) DaySpan(LocalDate.parse(start), LocalDate.parse(end)) else null,
    )

    private fun fs(id: UInt, pred: EndpointRef, succ: EndpointRef) = PlanLinkFact(id, pred, succ, DependencyType.FS, 0)

    private fun ms(id: UInt) = EndpointRef(EndpointKind.MILESTONE, id)

    private fun pj(id: UInt) = EndpointRef(EndpointKind.PROJECT, id)

    private fun rollUp(facts: List<PlanMilestoneFact>, links: List<PlanLinkFact>, root: UInt = p): RoadmapCriticalPath =
        RoadmapCriticalPathKernels.rollUp(
            root,
            CriticalPathKernels.analyse(root, facts, links, WorkingCalendar.MON_FRI),
            facts,
            links,
        )

    private fun project(id: UInt, slack: Int, critical: Boolean, hops: Int) = RoadmapCriticalProject(id, slack, critical, hops)

    @Test
    fun `the three-project chain - the projects by hops, slack and id, the critical pairs, a slack project off the chain`() {
        val facts = listOf(
            m(1u, x, "2027-02-01", "2027-02-05"), m(2u, y, "2027-02-08", "2027-02-12"),
            m(3u, p, "2027-02-15", "2027-02-19"), m(4u, z, "2027-02-01", "2027-02-05"),
        )
        val links = listOf(fs(101u, ms(1u), ms(2u)), fs(102u, ms(2u), ms(3u)), fs(103u, ms(4u), ms(3u)))
        val r = rollUp(facts, links)

        assertEquals(p, r.projectId)
        assertEquals(
            listOf(project(y, 0, true, 1), project(z, 5, false, 1), project(x, 0, true, 2)),
            r.projects,
            "hops first, then slack: Z (five working days of slack) sits between Y and X",
        )
        assertEquals(listOf(RoadmapCriticalPair(x, y), RoadmapCriticalPair(y, p)), r.pairs, "Z -> P is not on the chain")
    }

    @Test
    fun `a project with several upstream entities takes the least slack, any critical, the fewest hops - and a pair counts once`() {
        // X holds x1 (drives P: slack 0) and x2 (ends a week earlier: slack 5); a direct project link X -> P is critical too.
        val facts = listOf(
            m(1u, x, "2027-02-08", "2027-02-12"), m(2u, x, "2027-02-01", "2027-02-05"), m(3u, p, "2027-02-15", "2027-02-19"),
        )
        val links = listOf(fs(101u, ms(1u), ms(3u)), fs(102u, ms(2u), ms(3u)), fs(103u, pj(x), pj(p)))
        val r = rollUp(facts, links)

        assertEquals(listOf(project(x, 0, true, 1)), r.projects)
        assertEquals(listOf(RoadmapCriticalPair(x, p)), r.pairs, "two critical links between the pair roll up to one pair")
    }

    @Test
    fun `a link inside one project yields no pair, and the hops of a project are its nearest entity's`() {
        val facts = listOf(
            m(1u, x, "2027-02-01", "2027-02-05"), m(2u, x, "2027-02-08", "2027-02-12"), m(3u, p, "2027-02-15", "2027-02-19"),
        )
        val links = listOf(fs(101u, ms(1u), ms(2u)), fs(102u, ms(2u), ms(3u)))
        val r = rollUp(facts, links)

        assertEquals(listOf(project(x, 0, true, 1)), r.projects, "x1 is two links away, x2 one: the project is one hop away")
        assertEquals(listOf(RoadmapCriticalPair(x, p)), r.pairs, "x1 -> x2 stays inside X")
    }

    @Test
    fun `a target with nothing scheduled answers empty lists, and a violated link is no chain`() {
        val unscheduled = rollUp(
            listOf(m(1u, x, "2027-02-01", "2027-02-05"), m(3u, p, null)),
            listOf(fs(101u, ms(1u), ms(3u))),
        )
        assertEquals(RoadmapCriticalPath(p, emptyList(), emptyList()), unscheduled)

        // x1 starts after p1 ends: the FS link is violated, never driving, and ends the chain.
        val violated = rollUp(
            listOf(m(1u, x, "2027-02-15", "2027-02-19"), m(3u, p, "2027-02-01", "2027-02-05")),
            listOf(fs(101u, ms(1u), ms(3u))),
        )
        assertEquals(RoadmapCriticalPath(p, emptyList(), emptyList()), violated)
    }

    @Test
    fun `an end that is not among the facts is skipped, never a failure`() {
        val facts = listOf(m(3u, p, "2027-02-15", "2027-02-19"))
        val result = CriticalPathResult(emptyMap(), emptySet(), setOf(101u), emptyList())
        val r = RoadmapCriticalPathKernels.rollUp(p, result, facts, listOf(fs(101u, ms(99u), ms(3u))))
        assertEquals(emptyList(), r.pairs)
    }
}
