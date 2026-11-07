package ch.nokillswit

import ch.nokillswit.sync.ConnectorConnection
import ch.nokillswit.sync.Decision
import ch.nokillswit.sync.MAX_BACKOFF_MILLIS
import ch.nokillswit.sync.MAX_JITTER_MILLIS
import ch.nokillswit.sync.NO_JITTER
import ch.nokillswit.sync.RunFact
import ch.nokillswit.sync.SyncOutcome
import ch.nokillswit.sync.SyncTrigger
import ch.nokillswit.sync.backoffMillis
import ch.nokillswit.sync.decide
import ch.nokillswit.sync.failureJitterFraction
import ch.nokillswit.sync.failureJitterMillis
import ch.nokillswit.sync.trailingFailures
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

/**
 * The scheduler's pure due rule (`sync/SchedulePolicy.kt`): the back-off table at the two usual intervals, the failure streak, and every
 * way `decide` answers - never, running, due, wait - at the exact boundaries.
 */
class SchedulePolicyTest {
    private val minute = 60_000L
    private val now = 1_000_000_000_000L
    private val maxRun = 10

    private fun connection(
        enabled: Boolean = true,
        ready: Boolean = true,
        interval: Int? = 15,
        changedAt: Long = 0,
    ) = ConnectorConnection(1u, "c", enabled, interval, ready, changedAt)

    private fun finished(startedAt: Long, finishedAt: Long, outcome: SyncOutcome) =
        RunFact(startedAt, finishedAt, outcome, 0u, SyncTrigger.MANUAL, null)

    private fun unfinished(startedAt: Long) = RunFact(startedAt, null, null, 0u, SyncTrigger.MANUAL, null)

    // NO_JITTER: the tables below pin the back-off itself; the jitter has its own tests at the end.
    private fun decision(runs: List<RunFact>, at: Long = now, connection: ConnectorConnection = connection()) =
        decide(connection, runs, at, maxRun, NO_JITTER)

    @Test
    fun `the back-off doubles from the first retry and stops at six hours, for 5 and 15 minutes`() {
        val five = (0..8).map { backoffMillis(5 * minute, it) / minute }
        assertEquals(listOf(5L, 5, 10, 20, 40, 80, 160, 320, 360), five)
        val fifteen = (0..8).map { backoffMillis(15 * minute, it) / minute }
        assertEquals(listOf(15L, 15, 30, 60, 120, 240, 360, 360, 360), fifteen)
        assertEquals(360 * minute, MAX_BACKOFF_MILLIS)
    }

    @Test
    fun `a back-off never shortens the interval and a long failure streak cannot overflow`() {
        // 24 h is longer than the cap: the cap bounds the DOUBLING, never the configured interval.
        assertEquals(1440 * minute, backoffMillis(1440 * minute, 0))
        assertEquals(1440 * minute, backoffMillis(1440 * minute, 9))
        assertEquals(MAX_BACKOFF_MILLIS, backoffMillis(5 * minute, 50_000))
        assertEquals(1440 * minute, backoffMillis(1440 * minute, Int.MAX_VALUE))
    }

    @Test
    fun `the streak counts the newest finished runs that did not succeed, abandoned ones included`() {
        assertEquals(0, trailingFailures(emptyList()))
        assertEquals(0, trailingFailures(listOf(finished(2, 3, SyncOutcome.SUCCEEDED), finished(0, 1, SyncOutcome.FAILED))))
        assertEquals(
            2,
            trailingFailures(
                listOf(finished(6, 7, SyncOutcome.FAILED), finished(4, 5, SyncOutcome.ABANDONED), finished(2, 3, SyncOutcome.SUCCEEDED)),
            ),
        )
        // An unfinished row is not a result: it neither counts nor ends the streak.
        assertEquals(1, trailingFailures(listOf(unfinished(9), finished(6, 7, SyncOutcome.FAILED), finished(2, 3, SyncOutcome.SUCCEEDED))))
    }

    @Test
    fun `a disabled, untested or manual-only connection is never polled, whatever its runs say`() {
        assertEquals(Decision.Never, decision(emptyList(), connection = connection(enabled = false)))
        assertEquals(Decision.Never, decision(emptyList(), connection = connection(ready = false)))
        assertEquals(Decision.Never, decision(emptyList(), connection = connection(interval = null)))
        assertEquals(Decision.Never, decision(listOf(unfinished(now)), connection = connection(enabled = false)))
    }

    @Test
    fun `a tested connection with no run is due at once`() {
        assertEquals(Decision.Due, decision(emptyList()))
    }

    @Test
    fun `an unfinished run younger than the claim's lifetime is running, an older one is a crash and the connection is due`() {
        assertEquals(Decision.Running, decision(listOf(unfinished(now - 1))))
        assertEquals(Decision.Running, decision(listOf(unfinished(now - maxRun * minute))), "exactly at the edge is still running")
        assertEquals(Decision.Due, decision(listOf(unfinished(now - maxRun * minute - 1))))
        // A crash with a failure streak behind it is still due: the claim abandons the row, the abandonment then counts as a failure.
        assertEquals(Decision.Due, decision(listOf(unfinished(now - 11 * minute), finished(1, 2, SyncOutcome.FAILED))))
    }

    @Test
    fun `after a success the next poll is one interval after the run ended, to the millisecond`() {
        val ended = now - 4 * minute
        val runs = listOf(finished(ended - minute, ended, SyncOutcome.SUCCEEDED))
        assertEquals(Decision.Wait(ended + 15 * minute), decision(runs))
        assertEquals(Decision.Wait(ended + 15 * minute), decision(runs, at = ended + 15 * minute - 1))
        assertEquals(Decision.Due, decision(runs, at = ended + 15 * minute))
    }

    @Test
    fun `the first retry waits one interval, the second two, and a success resets`() {
        val ended = now
        val one = listOf(finished(ended - minute, ended, SyncOutcome.FAILED))
        assertEquals(Decision.Wait(ended + 15 * minute), decision(one))
        val two = listOf(finished(ended + 15 * minute, ended + 16 * minute, SyncOutcome.FAILED)) + one
        assertEquals(Decision.Wait(ended + 16 * minute + 30 * minute), decision(two))
        val three = listOf(finished(ended + 50 * minute, ended + 51 * minute, SyncOutcome.ABANDONED)) + two
        assertEquals(Decision.Wait(ended + 51 * minute + 60 * minute), decision(three))
        val reset = listOf(finished(ended + 120 * minute, ended + 121 * minute, SyncOutcome.SUCCEEDED)) + three
        assertEquals(Decision.Wait(ended + 121 * minute + 15 * minute), decision(reset))
    }

    @Test
    fun `a change to the connection after the newest run started makes it due whatever the back-off says`() {
        val runs = listOf(finished(now - 2 * minute, now - minute, SyncOutcome.FAILED))
        assertEquals(Decision.Wait(now - minute + 15 * minute), decision(runs))
        assertEquals(Decision.Wait(now - minute + 15 * minute), decision(runs, connection = connection(changedAt = now - 2 * minute)))
        assertEquals(Decision.Due, decision(runs, connection = connection(changedAt = now - 2 * minute + 1)))
        assertEquals(Decision.Due, decision(runs, connection = connection(changedAt = now)))
    }

    @Test
    fun `a change during a run waits for the run, and the next poll is due at once`() {
        val running = listOf(unfinished(now - minute))
        assertEquals(Decision.Running, decision(running, connection = connection(changedAt = now)))
        val ended = listOf(finished(now - minute, now, SyncOutcome.SUCCEEDED))
        assertEquals(Decision.Due, decision(ended, connection = connection(changedAt = now - 30_000)))
    }

    @Test
    fun `the six-hour cap holds a dead site to a poll every six hours`() {
        val ended = now
        val fails = (0 until 9).map { finished(ended - (it + 2) * minute, ended - (it + 1) * minute, SyncOutcome.FAILED) }
        assertEquals(Decision.Wait(ended - minute + MAX_BACKOFF_MILLIS), decision(fails, at = ended))
    }

    @Test
    fun `the jitter is a share of at most half the interval, never above an hour, and added to the back-off only`() {
        assertEquals(0L, failureJitterMillis(15 * minute, 15 * minute, 0.0))
        assertEquals(225_000L, failureJitterMillis(15 * minute, 15 * minute, 0.5), "half of min(7.5 min, 7.5 min)")
        // A longer back-off does not widen it: interval / 2 bounds it (a back-off is never below the interval).
        assertEquals(225_000L, failureJitterMillis(15 * minute, 240 * minute, 0.5))
        // A 24 h interval is capped at an hour, not 12 h.
        assertEquals(MAX_JITTER_MILLIS / 2, failureJitterMillis(1440 * minute, 1440 * minute, 0.5))
        assertTrue(failureJitterMillis(5 * minute, 5 * minute, 0.999_999) < 150_000L)
    }

    @Test
    fun `a failed connection retries at the back-off plus its jitter, a successful one exactly on the interval`() {
        val ended = now
        val failed = listOf(finished(ended - minute, ended, SyncOutcome.FAILED))
        val half = { _: UInt, _: UInt -> 0.5 }
        assertEquals(Decision.Wait(ended + 15 * minute + 225_000), decide(connection(), failed, now, maxRun, half))
        assertEquals(Decision.Due, decide(connection(), failed, ended + 15 * minute + 225_000, maxRun, half))
        val two = listOf(finished(ended + 15 * minute, ended + 16 * minute, SyncOutcome.FAILED)) + failed
        assertEquals(Decision.Wait(ended + 16 * minute + 30 * minute + 225_000), decide(connection(), two, now, maxRun, half))
        val ok = listOf(finished(ended - minute, ended, SyncOutcome.SUCCEEDED))
        assertEquals(Decision.Wait(ended + 15 * minute), decide(connection(), ok, now, maxRun, half), "a success is never jittered")
        // A change to the connection is due at once, the jitter does not hold a fixed token back.
        assertEquals(Decision.Due, decide(connection(changedAt = now), failed, now, maxRun, half))
    }

    @Test
    fun `connections that failed together retry at different instants, and each one at the same instant every time it is asked`() {
        val ended = now
        val waits = (1u..40u).map { id ->
            val c = ConnectorConnection(id, "c", true, 15, true, 0)
            val failed = listOf(RunFact(ended - minute, ended, SyncOutcome.FAILED, 7u, SyncTrigger.SCHEDULED, null))
            val first = decide(c, failed, now, maxRun)
            assertEquals(first, decide(c, failed, now + 1, maxRun), "deterministic: no draw per read")
            (first as Decision.Wait).until - (ended + 15 * minute)
        }
        assertTrue(waits.all { it in 0 until 450_000 }, "within [0, interval / 2)")
        assertTrue(waits.toSet().size >= 35, "spread, not clustered: ${waits.toSet().size} distinct offsets of 40")
        assertTrue(waits.max() - waits.min() > 300_000, "covers most of the span")
        // The next failure of the same connection is a new run id and draws a new offset.
        assertTrue((1u..40u).any { failureJitterFraction(it, 7u) != failureJitterFraction(it, 8u) })
        assertTrue((1u..1000u).all { failureJitterFraction(it, it) in 0.0..<1.0 })
    }
}
