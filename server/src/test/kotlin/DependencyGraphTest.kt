package ch.nokillswit

import ch.nokillswit.planning.ContainmentLink
import ch.nokillswit.planning.DependencyEdge
import ch.nokillswit.planning.DependencyType
import ch.nokillswit.planning.EndpointKind
import ch.nokillswit.planning.EndpointRef
import ch.nokillswit.planning.TimePoint
import ch.nokillswit.planning.TimePointGraph
import ch.nokillswit.planning.TimeSide
import ch.nokillswit.planning.from
import ch.nokillswit.planning.to
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNotNull
import kotlin.test.assertNull

/**
 * The time-point graph kernel (pure, no server): containment and start-to-end edges make a DAG, a new edge closes a cycle exactly when
 * its target already reaches its source, and the cycle comes back as entities with the first repeated last. Entities: projects
 * P1, P2 and milestones m1, m2 in P1, m3 in P2.
 */
class DependencyGraphTest {
    private fun m(id: UInt) = EndpointRef(EndpointKind.MILESTONE, id)

    private fun p(id: UInt) = EndpointRef(EndpointKind.PROJECT, id)

    private fun start(e: EndpointRef) = TimePoint(e, TimeSide.START)

    private fun end(e: EndpointRef) = TimePoint(e, TimeSide.END)

    private val containment = listOf(ContainmentLink(1u, 1u), ContainmentLink(2u, 1u), ContainmentLink(3u, 2u))

    private fun graph(vararg links: DependencyEdge) = TimePointGraph.build(containment, links.toList())

    private fun link(pred: EndpointRef, succ: EndpointRef, type: DependencyType = DependencyType.FS) = DependencyEdge(pred, succ, type)

    @Test
    fun `without dependencies a point reaches only what containment and start-to-end allow`() {
        val g = graph()
        assertEquals(listOf(start(m(1u)), end(m(1u))), g.reaches(start(m(1u)), end(m(1u))), "S -> E of one entity")
        assertEquals(listOf(start(p(1u)), end(p(1u))), g.reaches(start(p(1u)), end(p(1u))), "a project's own start-to-end edge")
        assertNotNull(g.reaches(start(p(1u)), end(m(2u))), "start of the project reaches the end of its milestone")
        assertNull(g.reaches(end(m(1u)), start(m(1u))), "never backwards in an entity")
        assertNull(g.reaches(end(m(1u)), start(p(1u))), "a milestone's end does not reach its project's start")
        assertNull(g.reaches(start(m(1u)), start(m(2u))), "siblings are unrelated")
        assertNull(g.reaches(end(p(1u)), end(p(2u))), "two projects are unrelated")
        assertEquals(listOf(start(m(3u))), g.reaches(start(m(3u)), start(m(3u))), "a point reaches itself by the one-element path")
    }

    @Test
    fun `a dependency edge joins the entities per type`() {
        val types = mapOf(
            DependencyType.FS to (end(m(1u)) to start(m(3u))),
            DependencyType.SS to (start(m(1u)) to start(m(3u))),
            DependencyType.FF to (end(m(1u)) to end(m(3u))),
            DependencyType.SF to (start(m(1u)) to end(m(3u))),
        )
        for ((type, points) in types) {
            val edge = link(m(1u), m(3u), type)
            assertEquals(points.first, edge.from, "$type leaves from")
            assertEquals(points.second, edge.to, "$type arrives at")
            val g = graph(edge)
            assertEquals(listOf(points.first, points.second), g.reaches(points.first, points.second), "$type is an edge")
            assertNull(g.reaches(points.second, points.first), "$type is directed")
        }
    }

    @Test
    fun `the reverse pair closes a cycle and names it from the new edge's predecessor`() {
        val g = graph(link(m(1u), m(3u)))
        assertEquals(listOf(m(3u), m(1u), m(3u)), g.cycleClosedBy(link(m(3u), m(1u))))
    }

    @Test
    fun `a milestone and its own project cannot be linked finish-to-start either way, start-to-start only one way`() {
        val g = graph()
        assertEquals(listOf(m(1u), p(1u), m(1u)), g.cycleClosedBy(link(m(1u), p(1u), DependencyType.FS)), "m FS p")
        assertEquals(listOf(p(1u), m(1u), p(1u)), g.cycleClosedBy(link(p(1u), m(1u), DependencyType.FS)), "p FS m")
        assertNull(g.cycleClosedBy(link(p(1u), m(1u), DependencyType.SS)), "p SS m is redundant with containment, harmless")
        assertNull(g.cycleClosedBy(link(m(1u), p(1u), DependencyType.FF)), "m FF p is redundant with containment, harmless")
        assertNotNull(g.cycleClosedBy(link(m(1u), p(1u), DependencyType.SS)), "m SS p reverses the containment edge")
        assertNotNull(g.cycleClosedBy(link(p(1u), m(1u), DependencyType.FF)), "p FF m reverses the containment edge")
    }

    @Test
    fun `a cycle across three entities and two projects is found and reported in order`() {
        // m1 (P1) -> m3 (P2) -> m2 (P1); the new edge m2 -> m1 closes it.
        val g = graph(link(m(1u), m(3u)), link(m(3u), m(2u)))
        assertEquals(listOf(m(2u), m(1u), m(3u), m(2u)), g.cycleClosedBy(link(m(2u), m(1u))))
        assertNull(g.cycleClosedBy(link(m(1u), m(2u))), "the forward shortcut closes nothing")
    }

    @Test
    fun `a project-level link in the cycle collapses consecutive points of one entity`() {
        // P1 FS P2: E(P1) -> S(P2). A milestone of P2 that must finish before a milestone of P1 starts contradicts it:
        // S(m1) -> E(m1) -> E(P1) -> S(P2) -> S(m3) -> E(m3), and the new edge E(m3) -> S(m1) closes the loop.
        val g = graph(link(p(1u), p(2u)))
        assertEquals(listOf(m(3u), m(1u), p(1u), p(2u), m(3u)), g.cycleClosedBy(link(m(3u), m(1u))))
        assertNull(g.cycleClosedBy(link(m(1u), m(3u))), "the same direction as the project link closes nothing")
        // The milestone of P2 finishing before P1 itself starts: found through the project link, the route is deterministic.
        assertEquals(listOf(m(3u), p(1u), p(2u), m(3u)), g.cycleClosedBy(link(m(3u), p(1u))))
    }

    @Test
    fun `zero-lag symmetric links are cycles too - lags never enter the graph`() {
        val g = graph(link(m(1u), m(3u), DependencyType.SS))
        assertEquals(listOf(m(3u), m(1u), m(3u)), g.cycleClosedBy(link(m(3u), m(1u), DependencyType.SS)))
    }

    @Test
    fun `entities known only from dependencies still carry their start-to-end edge`() {
        // P9 has no milestones, so only the dependency introduces it: its start must still reach its end.
        val g = graph(link(p(9u), p(1u)))
        assertEquals(listOf(start(p(9u)), end(p(9u))), g.reaches(start(p(9u)), end(p(9u))))
        assertNotNull(g.cycleClosedBy(link(p(1u), p(9u))))
    }

    @Test
    fun `a long chain does not overflow the stack - the search is iterative`() {
        val chainLength = 5_000u
        val links = (1u until chainLength).map { link(m(10_000u + it), m(10_001u + it)) }
        val g = TimePointGraph.build(emptyList(), links)
        assertNotNull(g.cycleClosedBy(link(m(10_000u + chainLength), m(10_001u))))
    }
}
