package ch.nokillswit

import ch.nokillswit.infra.time.MILLIS_PER_HOUR
import ch.nokillswit.jira.GONE_PROBE_FAILING_RUNS
import ch.nokillswit.jira.GoneProbeDamper
import ch.nokillswit.jira.StreakChange
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

/** The gone probe's back-off (`GoneProbeDamper`) as a pure state machine: streak, trip, the daily gate, reset and forget. */
class GoneProbeDamperTest {
    private val day = 24 * MILLIS_PER_HOUR
    private val c = 7u

    /** One failing run that sent reads and got no answer, allowed to retry (what an untripped connection's run is). */
    private fun GoneProbeDamper.failingRun(now: Long, retried: Boolean = true, connection: UInt = c) =
        endRun(connection, sent = 3, answered = 0, retried = retried, manual = false, now = now)

    private fun GoneProbeDamper.answeringRun(now: Long, connection: UInt = c) =
        endRun(connection, sent = 3, answered = 1, retried = true, manual = false, now = now)

    /** A Refresh now: it always retries, so `retried` is true; [answered] reads of its three got an answer. */
    private fun GoneProbeDamper.manualRun(now: Long, answered: Int = 0) =
        endRun(c, sent = 3, answered = answered, retried = true, manual = true, now = now)

    @Test
    fun `three failing runs in a row trip it once, a fourth only counts`() {
        val damper = GoneProbeDamper()
        assertEquals(StreakChange.NONE, damper.failingRun(1))
        assertEquals(StreakChange.NONE, damper.failingRun(2))
        assertFalse(damper.tripped(c))
        assertEquals(3, GONE_PROBE_FAILING_RUNS)
        assertEquals(StreakChange.TRIPPED, damper.failingRun(3), "the third failing run is the trip")
        assertTrue(damper.tripped(c))
        assertEquals(StreakChange.NONE, damper.failingRun(4), "it trips once per streak")
        assertEquals(4, damper.failingRuns(c))
    }

    @Test
    fun `a run that sent nothing changes nothing, whatever it answered`() {
        val damper = GoneProbeDamper()
        damper.failingRun(1)
        assertEquals(StreakChange.NONE, damper.endRun(c, sent = 0, answered = 0, retried = true, manual = false, now = 2))
        assertEquals(1, damper.failingRuns(c), "no run counted")
        repeat(2) { damper.failingRun(3) }
        assertEquals(StreakChange.NONE, damper.endRun(c, sent = 0, answered = 0, retried = true, manual = false, now = 4))
        assertTrue(damper.tripped(c), "an empty run neither untrips nor recovers")
    }

    @Test
    fun `an answer ends the streak, once, and the count starts over`() {
        val damper = GoneProbeDamper()
        repeat(3) { damper.failingRun(it.toLong()) }
        assertEquals(StreakChange.RECOVERED, damper.answeringRun(10))
        assertFalse(damper.tripped(c))
        assertEquals(0, damper.failingRuns(c))
        assertEquals(StreakChange.NONE, damper.answeringRun(11), "a second answering run is not a recovery")
        assertEquals(StreakChange.NONE, damper.failingRun(12))
        assertEquals(1, damper.failingRuns(c), "the count started over")
    }

    @Test
    fun `an answer ends a streak that had not tripped without a recovery, and starts the count over`() {
        val damper = GoneProbeDamper()
        damper.failingRun(1)
        damper.failingRun(2)
        assertEquals(StreakChange.NONE, damper.answeringRun(3), "two failing runs are not a trip: nothing to recover from")
        assertEquals(0, damper.failingRuns(c))
        repeat(3) { damper.failingRun(10L + it) }
        assertEquals(StreakChange.RECOVERED, damper.answeringRun(20), "a tripped one is")
    }

    @Test
    fun `a manual run without an answer neither counts nor restarts the retry clock, one with an answer ends the streak`() {
        val damper = GoneProbeDamper()
        damper.failingRun(100)
        assertEquals(StreakChange.NONE, damper.manualRun(200), "no answer: no change, not even for an untripped streak")
        assertEquals(1, damper.failingRuns(c))
        damper.failingRun(300)
        assertEquals(StreakChange.TRIPPED, damper.failingRun(1_000), "scheduled runs trip it, a manual one in between did not count")
        assertEquals(StreakChange.NONE, damper.manualRun(1_000 + day - 1))
        assertEquals(3, damper.failingRuns(c))
        assertTrue(damper.retriesAllowed(c, manual = false, now = 1_000 + day, intervalMs = day), "the clock stayed at the scheduled one")
        assertEquals(StreakChange.RECOVERED, damper.manualRun(1_000 + day, answered = 1), "an answer ends a tripped streak")
        assertEquals(0, damper.failingRuns(c))
        assertTrue(damper.retriesAllowed(c, manual = false, now = 1_000 + day + 1, intervalMs = day))
        damper.failingRun(5_000)
        assertEquals(StreakChange.NONE, damper.manualRun(5_001, answered = 2), "an answer below the trip is no recovery either")
        assertEquals(0, damper.failingRuns(c))
    }

    @Test
    fun `a tripped scheduled run retries only after the interval since the last retry, a manual run always`() {
        val damper = GoneProbeDamper()
        assertTrue(damper.retriesAllowed(c, manual = false, now = 5, intervalMs = day), "untripped: always")
        repeat(2) { damper.failingRun(100) }
        assertTrue(damper.retriesAllowed(c, manual = false, now = 101, intervalMs = day), "two failing runs: not tripped")
        damper.failingRun(1_000) // the tripping run retried at 1,000
        assertFalse(damper.retriesAllowed(c, manual = false, now = 1_001, intervalMs = day))
        assertFalse(damper.retriesAllowed(c, manual = false, now = 1_000 + day - 1, intervalMs = day), "one millisecond short")
        assertTrue(damper.retriesAllowed(c, manual = false, now = 1_000 + day, intervalMs = day), "exactly the interval")
        assertTrue(damper.retriesAllowed(c, manual = true, now = 1_001, intervalMs = day), "Refresh now bypasses the gate")

        // A retry that fails again restarts the clock; a gated run (only newly flagged bindings asked) does not.
        damper.failingRun(1_000 + day)
        assertFalse(damper.retriesAllowed(c, manual = false, now = 1_000 + day + 5, intervalMs = day))
        damper.failingRun(1_000 + day + 10, retried = false)
        assertTrue(damper.retriesAllowed(c, manual = false, now = 1_000 + 2 * day, intervalMs = day), "the clock stayed at the last retry")
        // A retry just before the interval is up (a Refresh now, say) restarts the clock for the scheduled runs.
        damper.failingRun(1_000 + 2 * day - 1)
        assertFalse(damper.retriesAllowed(c, manual = false, now = 1_000 + 2 * day, intervalMs = day))
    }

    @Test
    fun `the first failing run is the one before any failing run was counted, until an answer`() {
        val damper = GoneProbeDamper()
        assertTrue(damper.firstFailingRun(c))
        damper.failed(c, 1u, now = 10) // a failed read alone does not count a run
        assertTrue(damper.firstFailingRun(c))
        damper.failingRun(30)
        assertFalse(damper.firstFailingRun(c), "the streak has a failing run")
        damper.answeringRun(50)
        assertTrue(damper.firstFailingRun(c), "a new streak")
    }

    @Test
    fun `the rotation memory keeps the last failed read per binding, past a streak, until an answer or the binding leaves`() {
        val damper = GoneProbeDamper()
        assertEquals(emptyMap(), damper.lastTried(c))
        damper.failed(c, 1u, now = 10)
        damper.failed(c, 2u, now = 20)
        damper.failed(c, 1u, now = 30)
        assertEquals(mapOf(1u to 30L, 2u to 20L), damper.lastTried(c))
        damper.failingRun(40)
        damper.answeringRun(50) // the streak ends; the rotation memory stays
        assertEquals(mapOf(1u to 30L, 2u to 20L), damper.lastTried(c))
        damper.answered(c, 1u)
        assertEquals(mapOf(2u to 20L), damper.lastTried(c), "an answer removes the entry")
        damper.failed(c, 3u, now = 60)
        damper.retain(c, setOf(3u, 9u))
        assertEquals(mapOf(3u to 60L), damper.lastTried(c), "a binding no longer gone is dropped")
        damper.retain(c, emptySet())
        assertEquals(emptyMap(), damper.lastTried(c))
    }

    @Test
    fun `forget drops the whole entry of one connection and leaves the others`() {
        val damper = GoneProbeDamper()
        val other = 8u
        repeat(3) { damper.failingRun(it.toLong()) }
        damper.failed(c, 1u, now = 5)
        repeat(3) { damper.failingRun(it.toLong(), connection = other) }
        damper.forget(c)
        assertFalse(damper.tripped(c))
        assertEquals(0, damper.failingRuns(c))
        assertEquals(emptyMap(), damper.lastTried(c))
        assertTrue(damper.retriesAllowed(c, manual = false, now = 6, intervalMs = day))
        assertTrue(damper.tripped(other), "another connection is untouched")
        damper.forget(c) // twice, or never seen: harmless
        damper.forget(99u)
    }

    @Test
    fun `an answering run with no streak and nothing remembered leaves no entry behind`() {
        val damper = GoneProbeDamper()
        assertEquals(StreakChange.NONE, damper.answeringRun(1))
        assertEquals(0, damper.failingRuns(c))
        assertEquals(emptyMap(), damper.lastTried(c))
        damper.failed(c, 1u, now = 2)
        damper.answered(c, 1u)
        damper.answeringRun(3)
        assertEquals(emptyMap(), damper.lastTried(c))
        assertEquals(0, damper.failingRuns(c))
    }
}
