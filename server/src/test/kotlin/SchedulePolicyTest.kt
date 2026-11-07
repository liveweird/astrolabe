package ch.nokillswit

import ch.nokillswit.sync.ConnectorConnection
import ch.nokillswit.sync.Decision
import ch.nokillswit.sync.MAX_BACKOFF_MILLIS
import ch.nokillswit.sync.RunFact
import ch.nokillswit.sync.SyncOutcome
import ch.nokillswit.sync.SyncTrigger
import ch.nokillswit.sync.backoffMillis
import ch.nokillswit.sync.decide
import ch.nokillswit.sync.trailingFailures
import kotlin.test.Test
import kotlin.test.assertEquals

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

    private fun decision(runs: List<RunFact>, at: Long = now, connection: ConnectorConnection = connection()) =
        decide(connection, runs, at, maxRun)

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
}
