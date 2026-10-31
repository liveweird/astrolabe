package ch.nokillswit

import ch.nokillswit.infra.db.lazyStatements
import ch.nokillswit.infra.db.payloadChunkSizes
import kotlinx.coroutines.flow.toList
import kotlin.random.Random
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

/**
 * The ORACLE for the planner when no row is heavy (it used to be main code): as many full chunks of [maxRows] as fit, then the remainder
 * as its binary decomposition (13 -> 8, 4, 1) - at most `log2(maxRows) + 1` distinct sizes, so a table ever produces only a handful of
 * SQL texts. Written independently of `payloadChunkSizes` on purpose.
 */
internal fun chunkSizes(total: Int, maxRows: Int): List<Int> {
    val sizes = ArrayList<Int>()
    var left = total
    while (left >= maxRows) {
        sizes += maxRows
        left -= maxRows
    }
    var bit = Integer.highestOneBit(left)
    while (left > 0) {
        if (left >= bit) {
            sizes += bit
            left -= bit
        }
        bit = bit shr 1
    }
    return sizes
}

/**
 * `infra/db/MultiRowInsert.kt` bounds a statement's payload as well as its bind parameters (`MAX_PAYLOAD_CHARS`; `build-times.md`
 * WHY 48, "Postgres memory under dense raw inserts"): the pure planner `payloadChunkSizes` and its lazy statement assembly.
 */
class MultiRowInsertPayloadTest {
    private val max = 100
    private val budget = 1_000L

    private fun plan(vararg payloads: Int) = payloadChunkSizes(payloads.toList(), max, budget)

    @Test
    fun `an empty batch plans no statement`() {
        assertEquals(emptyList(), plan())
    }

    @Test
    fun `one row over the budget goes alone, and so does its neighbourhood's remainder`() {
        assertEquals(listOf(1), plan(50_000))
        // [heavy, light, light]: the heavy row alone, then the two light ones together
        assertEquals(listOf(1, 2), plan(50_000, 10, 10))
        // [light, heavy]: the heavy row cannot join the light one
        assertEquals(listOf(1, 1), plan(10, 50_000))
    }

    @Test
    fun `many small rows plan exactly what the bind cap alone plans`() {
        for (total in 0..450) {
            assertEquals(chunkSizes(total, max), payloadChunkSizes(List(total) { 1 }, max, budget), "total $total")
            assertEquals(chunkSizes(total, max), payloadChunkSizes(List(total) { 0 }, max, budget), "weightless total $total")
        }
    }

    @Test
    fun `the budget is inclusive - exactly at it fits, one over splits`() {
        assertEquals(listOf(2), plan(500, 500))
        assertEquals(listOf(1, 1), plan(500, 501))
        // 4 rows of 250 = 1,000 fit as one statement; a fifth would not
        assertEquals(listOf(4), plan(250, 250, 250, 250))
        assertEquals(listOf(4, 1), plan(250, 250, 250, 250, 250))
    }

    @Test
    fun `a mixed batch splits where the payload fills up and keeps only power-of-two sizes`() {
        // the first 600 cannot pair with the second (1,200); the second plus four 100s is exactly 1,000 (5 rows, rounded down to 4),
        // then the remaining three 100s (3 rows -> 2) and the last one alone
        assertEquals(listOf(1, 4, 2, 1), plan(600, 600, 100, 100, 100, 100, 100, 100))
        val heavy = List(37) { if (it % 5 == 0) 900 else 30 }
        val sizes = payloadChunkSizes(heavy, max, budget)
        assertEquals(heavy.size, sizes.sum(), "every row is written exactly once")
        assertTrue(sizes.all { it == max || Integer.bitCount(it) == 1 }, "only full or power-of-two chunks: $sizes")
        var offset = 0
        for (size in sizes) {
            val payload = heavy.subList(offset, offset + size).sum()
            assertTrue(size == 1 || payload <= budget, "a statement of $size rows carries $payload > $budget")
            offset += size
        }
    }

    @Test
    fun `the row cap and the payload budget both apply - the tighter one wins`() {
        // 250 weightless rows: row cap only (100, 100, 32, 16, 2)
        assertEquals(chunkSizes(250, max), payloadChunkSizes(List(250) { 0 }, max, budget))
        // 250 rows of 100: the payload allows 10 per statement, so 8 (power of two), the rest in the same manner
        val sizes = payloadChunkSizes(List(250) { 100 }, max, budget)
        assertTrue(sizes.all { it <= 8 }, "$sizes")
        assertEquals(250, sizes.sum())
    }

    /** Runs [lazyStatements] over [payloads]: the statement sizes and the most rows built but not yet handed out at any hand-out. */
    private fun lazyRun(payloads: List<Int>, maxRows: Int): Pair<List<Int>, Int> {
        var built = 0
        var emitted = 0
        var mostInFlight = 0
        val sizes = ArrayList<Int>()
        for (statement in lazyStatements(payloads.size, maxRows, budget, { weight: Int -> weight }) { payloads[built++] }) {
            mostInFlight = maxOf(mostInFlight, built - emitted)
            emitted += statement.size
            sizes += statement.size
            assertEquals(payloads.subList(emitted - statement.size, emitted), statement, "rows keep their order")
        }
        assertEquals(payloads.size, built, "every row is built exactly once")
        return sizes to mostInFlight
    }

    @Test
    fun `the lazy plan equals the full-list plan and builds ahead by at most one statement's row cap`() {
        for (total in 0..450) {
            val (sizes, inFlight) = lazyRun(List(total) { 1 }, max)
            assertEquals(chunkSizes(total, max), sizes, "light total $total")
            assertTrue(inFlight <= max, "light total $total built $inFlight ahead")
            // no payload overflow: not even a power-of-two remainder is built before its statement is decided
            val largest = sizes.maxOrNull() ?: 0
            assertTrue(inFlight <= largest, "light total $total built $inFlight for a largest statement of $largest")
        }
        val random = Random(396)
        repeat(400) { round ->
            val total = random.nextInt(0, 451)
            val heavyShare = listOf(0.0, 0.02, 0.1, 0.5, 1.0)[round % 5]
            val payloads = List(total) {
                when {
                    random.nextDouble() < heavyShare -> random.nextInt(300, 1_600)
                    random.nextBoolean() -> random.nextInt(0, 12)
                    else -> random.nextInt(0, 60)
                }
            }
            val (sizes, inFlight) = lazyRun(payloads, max)
            assertEquals(payloadChunkSizes(payloads, max, budget), sizes, "round $round, payloads $payloads")
            assertTrue(inFlight <= max, "round $round built $inFlight rows ahead of a statement, over the row cap $max")
        }
    }
}
