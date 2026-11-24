package ch.nokillswit

import ch.nokillswit.planning.BaselineLinkKernels
import ch.nokillswit.planning.DependencyType
import ch.nokillswit.planning.EndpointKind
import ch.nokillswit.planning.EndpointRef
import ch.nokillswit.planning.LinkChange
import ch.nokillswit.planning.LinkChangeKind
import ch.nokillswit.planning.LinkTotals
import ch.nokillswit.planning.PlanLinkFact
import kotlin.test.Test
import kotlin.test.assertEquals

/** The pure link comparison (no server, no database): a link is its dependency id; type or lag differing is CHANGED. Hand-counted. */
class BaselineLinkKernelsTest {
    private fun link(id: UInt, type: DependencyType = DependencyType.FS, lag: Int = 0, pred: UInt = 100u, succ: UInt = 200u) =
        PlanLinkFact(id, EndpointRef(EndpointKind.MILESTONE, pred), EndpointRef(EndpointKind.PROJECT, succ), type, lag)

    private fun kinds(changes: List<LinkChange>) = changes.map { it.dependencyId to it.kind }

    @Test
    fun `the same ids with the same type and lag are all unchanged`() {
        val links = listOf(link(1u), link(2u, DependencyType.SS, 3))
        val result = BaselineLinkKernels.compare(links, links.toList())
        assertEquals(emptyList(), result.changes)
        assertEquals(LinkTotals(added = 0, removed = 0, changed = 0, unchanged = 2), result.totals)
    }

    @Test
    fun `a link only now is ADDED, only then REMOVED, a different type or lag CHANGED, by dependency id`() {
        // then: 1 FS+0 (same), 2 SS+2 (lag changes), 3 FF+0 (gone), 5 SF-1 (type changes) ; now: 1 FS+0, 2 SS+3, 4 FS+0 (new), 5 FS-1
        val then = listOf(link(1u), link(2u, DependencyType.SS, 2), link(3u, DependencyType.FF), link(5u, DependencyType.SF, -1))
        val now = listOf(link(5u, DependencyType.FS, -1), link(4u), link(2u, DependencyType.SS, 3), link(1u))
        val result = BaselineLinkKernels.compare(then, now)
        assertEquals(
            listOf(
                2u to LinkChangeKind.CHANGED, 3u to LinkChangeKind.REMOVED, 4u to LinkChangeKind.ADDED, 5u to LinkChangeKind.CHANGED,
            ),
            kinds(result.changes),
        )
        assertEquals(LinkTotals(added = 1, removed = 1, changed = 2, unchanged = 1), result.totals)
        val changed = result.changes.first()
        assertEquals(2 to DependencyType.SS, changed.then?.lagDays to changed.then?.type)
        assertEquals(3, changed.now?.lagDays)
        assertEquals(null, result.changes[1].now, "a removed link has no 'now'")
        assertEquals(null, result.changes[2].then, "an added link has no 'then'")
    }

    @Test
    fun `a link deleted and made again has a new id - one REMOVED and one ADDED`() {
        val result = BaselineLinkKernels.compare(listOf(link(7u)), listOf(link(9u)))
        assertEquals(listOf(7u to LinkChangeKind.REMOVED, 9u to LinkChangeKind.ADDED), kinds(result.changes))
        assertEquals(LinkTotals(added = 1, removed = 1, changed = 0, unchanged = 0), result.totals)
    }

    @Test
    fun `an empty side makes every link of the other added or removed`() {
        assertEquals(LinkTotals(2, 0, 0, 0), BaselineLinkKernels.compare(emptyList(), listOf(link(1u), link(2u))).totals)
        assertEquals(LinkTotals(0, 1, 0, 0), BaselineLinkKernels.compare(listOf(link(1u)), emptyList()).totals)
        assertEquals(LinkTotals(0, 0, 0, 0), BaselineLinkKernels.compare(emptyList(), emptyList()).totals)
    }
}
