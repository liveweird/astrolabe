package ch.nokillswit

import ch.nokillswit.planning.PlanOrder
import ch.nokillswit.planning.PlanOrderKernels
import ch.nokillswit.planning.ProgramSlot
import kotlin.test.Test
import kotlin.test.assertEquals

/** The effective order of the work streams and programs as pure functions (no server, no database; `plan-tree.md`). */
class PlanOrderKernelsTest {
    private data class Stream(val id: UInt, val name: String, val closed: Boolean = false)

    private data class Program(val id: UInt, val streamId: UInt, val name: String)

    private fun streams(items: List<Stream>, order: PlanOrder = PlanOrder.NONE): List<UInt> =
        PlanOrderKernels.orderWorkStreams(items, order, { it.id }, { it.name }, { it.closed }).map { it.id }

    private fun programs(items: List<Program>, order: PlanOrder = PlanOrder.NONE): List<UInt> =
        PlanOrderKernels.orderPrograms(items, order, { it.id }, { it.streamId }, { it.name }).map { it.id }

    /** The comparators the views used before V34, kept here as the oracle the empty order must equal. */
    private fun oldStreams(items: List<Stream>) =
        items.sortedWith(compareBy({ it.closed }, { it.name.lowercase() }, { it.id })).map { it.id }

    private fun oldPrograms(items: List<Program>) = items.sortedWith(compareBy({ it.name.lowercase() }, { it.id })).map { it.id }

    private val someStreams = listOf(
        Stream(1u, "aaa-closed", closed = true), Stream(3u, "Charlie"), Stream(2u, "bravo"), Stream(5u, "alpha"), Stream(4u, "ALPHA"),
        Stream(6u, "Zulu", closed = true), Stream(7u, "Ünder"),
    )

    private val somePrograms =
        listOf(Program(11u, 1u, "Zed"), Program(12u, 1u, "apple"), Program(14u, 1u, "Zed"), Program(13u, 1u, "Banana"))

    @Test
    fun `with nothing stored both orders equal the comparators of before V34`() {
        assertEquals(oldStreams(someStreams), streams(someStreams))
        assertEquals(listOf(4u, 5u, 2u, 3u, 7u, 1u, 6u), streams(someStreams), "open by lowercase name then id, then the closed ones")
        assertEquals(oldPrograms(somePrograms), programs(somePrograms))
        assertEquals(listOf(12u, 13u, 11u, 14u), programs(somePrograms))
        assertEquals(oldStreams(someStreams.reversed()), streams(someStreams.reversed()), "the input order does not matter")
    }

    @Test
    fun `a listed work stream goes ahead of every unlisted one, the unlisted follow by name`() {
        val order = PlanOrder(workStreams = mapOf(3u to 1, 2u to 2))
        assertEquals(listOf(3u, 2u, 4u, 5u, 7u, 1u, 6u), streams(someStreams, order))
    }

    @Test
    fun `closed work streams stay last whatever their position`() {
        val order = PlanOrder(workStreams = mapOf(6u to 1, 1u to 2, 3u to 3))
        assertEquals(listOf(3u, 4u, 5u, 2u, 7u, 6u, 1u), streams(someStreams, order), "open first; the closed ones by their positions")
        assertEquals(listOf(6u, 1u), streams(someStreams, order).takeLast(2))
    }

    @Test
    fun `a closed stream listed ahead of nothing but closed ones keeps its place among them`() {
        val closedOnly = listOf(Stream(1u, "a", closed = true), Stream(2u, "b", closed = true), Stream(3u, "c", closed = true))
        assertEquals(listOf(3u, 1u, 2u), streams(closedOnly, PlanOrder(workStreams = mapOf(3u to 1))))
    }

    @Test
    fun `a listed program goes ahead of the unlisted ones in its work stream`() {
        val order = PlanOrder(programs = mapOf(14u to ProgramSlot(1u, 1), 11u to ProgramSlot(1u, 2)))
        assertEquals(listOf(14u, 11u, 12u, 13u), programs(somePrograms, order))
    }

    @Test
    fun `a position counts only while the row names the program's current work stream`() {
        // 13 was listed in work stream 9 and has moved to stream 1 (a row a rolled-back build left behind); 12 is listed in stream 1.
        val order = PlanOrder(programs = mapOf(13u to ProgramSlot(9u, 1), 12u to ProgramSlot(1u, 2)))
        assertEquals(listOf(12u, 13u, 11u, 14u), programs(somePrograms, order), "13 is unlisted here: by name, after the listed 12")
        val firstPlaceOnlyHere = PlanOrder(programs = mapOf(13u to ProgramSlot(9u, 1)))
        assertEquals(oldPrograms(somePrograms), programs(somePrograms, firstPlaceOnlyHere), "a stale row alone changes nothing")
    }

    @Test
    fun `rows of nodes that are not in the input are inert`() {
        val order = PlanOrder(
            workStreams = mapOf(99u to 1, 98u to 2),
            programs = mapOf(77u to ProgramSlot(1u, 1)),
        )
        assertEquals(oldStreams(someStreams), streams(someStreams, order))
        assertEquals(oldPrograms(somePrograms), programs(somePrograms, order))
    }
}
