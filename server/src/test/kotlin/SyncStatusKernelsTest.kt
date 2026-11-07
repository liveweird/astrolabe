package ch.nokillswit

import ch.nokillswit.sync.ConnectorConnection
import ch.nokillswit.sync.Decision
import ch.nokillswit.sync.RunFact
import ch.nokillswit.sync.STALE_INTERVAL_MULTIPLIER
import ch.nokillswit.sync.SyncLastRun
import ch.nokillswit.sync.SyncOutcome
import ch.nokillswit.sync.SyncState
import ch.nokillswit.sync.SyncStatusKernels
import ch.nokillswit.sync.SyncTrigger
import ch.nokillswit.sync.decide
import ch.nokillswit.sync.failureJitterFraction
import ch.nokillswit.sync.failureJitterMillis
import ch.nokillswit.sync.isRunLive
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * The connection status (`sync/SyncStatus.kt`), pure: every state in the order the rule judges them, STALE at exactly three intervals,
 * a manual-only connection, the failure streak, `lastRun` and its running verdict, and `nextPollAt` pinned EQUAL to the scheduler's own
 * [decide] (including the back-off), never a second copy of the formula.
 */
class SyncStatusKernelsTest {
    private val minute = 60_000L
    private val interval = 15
    private val now = 1_000_000_000_000L
    private val maxRun = 10

    private fun connection(
        enabled: Boolean = true,
        ready: Boolean = true,
        interval: Int? = this.interval,
        changedAt: Long = 0,
    ) = ConnectorConnection(1u, "c", enabled, interval, ready, changedAt)

    private fun finished(
        startedAt: Long,
        outcome: SyncOutcome,
        id: UInt = 1u,
        code: String? = null,
        trigger: SyncTrigger = SyncTrigger.MANUAL,
    ) = RunFact(startedAt, startedAt + 5_000, outcome, id, trigger, code)

    private fun unfinished(startedAt: Long, id: UInt = 1u) = RunFact(startedAt, null, null, id, SyncTrigger.SCHEDULED, null)

    private fun derive(runs: List<RunFact>, connection: ConnectorConnection = connection(), at: Long = now) =
        SyncStatusKernels.derive(connection, runs, at, maxRun)

    @Test
    fun `a connection nothing has run for is NEVER_SYNCED, untested or not`() {
        val untested = derive(emptyList(), connection(ready = false))
        assertEquals(SyncState.NEVER_SYNCED, untested.state)
        assertNull(untested.lastRun)
        assertNull(untested.lastSucceededAt)
        assertEquals(0, untested.consecutiveFailures)
        assertNull(untested.nextPollAt, "an untested connection is never polled")
        val tested = derive(emptyList())
        assertEquals(SyncState.NEVER_SYNCED, tested.state)
        assertEquals(now, tested.nextPollAt, "tested and never run: due at once")
    }

    @Test
    fun `a run that has not finished yet does not make the connection synced or failed`() {
        val status = derive(listOf(unfinished(now - minute)))
        assertEquals(SyncState.NEVER_SYNCED, status.state)
        assertTrue(status.lastRun!!.running)
        assertNull(status.nextPollAt, "a run in flight: the claim would be a 409")
        assertEquals(0, status.consecutiveFailures)
    }

    @Test
    fun `a success is CURRENT with its start as lastSucceededAt, and the next poll one interval after it finished`() {
        val run = finished(now - 5 * minute, SyncOutcome.SUCCEEDED, id = 7u)
        val status = derive(listOf(run))
        assertEquals(SyncState.CURRENT, status.state)
        assertEquals(now - 5 * minute, status.lastSucceededAt)
        assertEquals(0, status.consecutiveFailures)
        val expectedRun = SyncLastRun(7u, run.startedAt, run.finishedAt, SyncOutcome.SUCCEEDED, null, SyncTrigger.MANUAL, running = false)
        assertEquals(expectedRun, status.lastRun)
        assertEquals(run.finishedAt!! + interval * minute, status.nextPollAt)
    }

    @Test
    fun `STALE begins strictly after three intervals since the last success started`() {
        val limit = STALE_INTERVAL_MULTIPLIER * interval * minute
        assertEquals(3, STALE_INTERVAL_MULTIPLIER)
        fun at(age: Long) = derive(listOf(finished(now - age, SyncOutcome.SUCCEEDED))).state
        assertEquals(SyncState.CURRENT, at(limit - 1))
        assertEquals(SyncState.CURRENT, at(limit), "exactly three intervals is still current")
        assertEquals(SyncState.STALE, at(limit + 1))
        // The same instant, an interval of 5 minutes: the boundary follows the connection's own interval.
        val five = connection(interval = 5)
        assertEquals(SyncState.CURRENT, derive(listOf(finished(now - 15 * minute, SyncOutcome.SUCCEEDED)), five).state)
        assertEquals(SyncState.STALE, derive(listOf(finished(now - 15 * minute - 1, SyncOutcome.SUCCEEDED)), five).state)
    }

    @Test
    fun `a manual-only connection stays CURRENT after any success and is never due`() {
        val ancient = finished(now - 400 * 24 * 60 * minute, SyncOutcome.SUCCEEDED)
        val status = derive(listOf(ancient), connection(interval = null))
        assertEquals(SyncState.CURRENT, status.state)
        assertEquals(ancient.startedAt, status.lastSucceededAt, "the age is the administrator's to read")
        assertNull(status.nextPollAt)
        assertEquals(SyncState.NEVER_SYNCED, derive(emptyList(), connection(interval = null)).state)
    }

    @Test
    fun `the newest finished run failing or being abandoned is FAILED with the streak counted back to the last success`() {
        val runs = listOf(
            finished(now - 10 * minute, SyncOutcome.ABANDONED, id = 5u, code = "ABANDONED", trigger = SyncTrigger.SCHEDULED),
            finished(now - 20 * minute, SyncOutcome.FAILED, id = 4u, code = "TIMEOUT"),
            finished(now - 30 * minute, SyncOutcome.SUCCEEDED, id = 3u),
            finished(now - 40 * minute, SyncOutcome.FAILED, id = 2u, code = "TIMEOUT"),
        )
        val status = derive(runs)
        assertEquals(SyncState.FAILED, status.state)
        assertEquals(2, status.consecutiveFailures)
        assertEquals(now - 30 * minute, status.lastSucceededAt, "an earlier success is still reported")
        val last = status.lastRun!!
        assertEquals(5u, last.id)
        assertEquals(SyncOutcome.ABANDONED, last.outcome)
        assertEquals("ABANDONED", last.errorCode)
        assertEquals(SyncTrigger.SCHEDULED, last.trigger)
        assertEquals(SyncState.FAILED, derive(runs.drop(1).take(1)).state, "a failure with no success before it")
    }

    @Test
    fun `a success after failures resets the streak, and an unfinished row on top neither fails nor clears the state`() {
        val recovered = derive(listOf(finished(now - minute, SyncOutcome.SUCCEEDED), finished(now - 9 * minute, SyncOutcome.FAILED)))
        assertEquals(0, recovered.consecutiveFailures)
        val failedThenRunning = derive(listOf(unfinished(now - minute, id = 9u), finished(now - 20 * minute, SyncOutcome.FAILED, id = 8u)))
        assertEquals(SyncState.FAILED, failedThenRunning.state, "the newest FINISHED run decides")
        val newest = assertNotNull(failedThenRunning.lastRun)
        assertEquals(9u, newest.id, "lastRun is the newest row, running or not")
        assertTrue(newest.running)
        assertEquals(1, failedThenRunning.consecutiveFailures)
    }

    @Test
    fun `DISABLED outranks every other state and clears the next poll`() {
        val failing = listOf(finished(now - minute, SyncOutcome.FAILED, code = "TIMEOUT"))
        val status = derive(failing, connection(enabled = false))
        assertEquals(SyncState.DISABLED, status.state)
        assertNull(status.nextPollAt)
        assertEquals(1, status.consecutiveFailures, "the run facts are still reported")
        assertEquals(SyncState.DISABLED, derive(emptyList(), connection(enabled = false)).state)
    }

    @Test
    fun `an unfinished row is running for exactly maxRunMinutes, older it was interrupted`() {
        val atLimit = derive(listOf(unfinished(now - maxRun * minute)))
        assertTrue(atLimit.lastRun!!.running)
        assertTrue(isRunLive(null, now - maxRun * minute, now, maxRun))
        val past = derive(listOf(unfinished(now - maxRun * minute - 1)))
        assertFalse(past.lastRun!!.running)
        assertFalse(isRunLive(now, now - 1, now, maxRun), "a finished run is never running")
        assertEquals(now, past.nextPollAt, "an interrupted run is a crash: due, the claim abandons it")
        assertNull(atLimit.nextPollAt)
    }

    @Test
    fun `an interrupted newest row counts like an abandonment before any claim writes one`() {
        val crashed = unfinished(now - maxRun * minute - 1, id = 6u)
        val bare = derive(listOf(crashed))
        assertEquals(SyncState.FAILED, bare.state)
        assertEquals(1, bare.consecutiveFailures)
        val last = assertNotNull(bare.lastRun)
        assertEquals(6u, last.id)
        assertFalse(last.running)
        assertNull(last.finishedAt)
        assertNull(last.outcome)
        assertEquals(now, bare.nextPollAt, "decide is unchanged: a polled connection is due, the claim abandons the row")

        val afterFailure = derive(listOf(crashed, finished(now - 40 * minute, SyncOutcome.FAILED, id = 5u)))
        assertEquals(2, afterFailure.consecutiveFailures, "the interrupted row joins the failures behind it")
        val afterSuccess = derive(listOf(crashed, finished(now - 40 * minute, SyncOutcome.SUCCEEDED, id = 5u)))
        assertEquals(SyncState.FAILED, afterSuccess.state, "FAILED outranks CURRENT")
        assertEquals(1, afterSuccess.consecutiveFailures)
        assertEquals(now - 40 * minute, afterSuccess.lastSucceededAt)

        // The case that matters: a manual-only connection, which no claim ever abandons.
        val manual = derive(listOf(crashed), connection(interval = null))
        assertEquals(SyncState.FAILED, manual.state)
        assertNull(manual.nextPollAt)
        assertEquals(SyncState.DISABLED, derive(listOf(crashed), connection(enabled = false)).state)
        // Still inside the claim window it is a live run, not a failure.
        assertEquals(0, derive(listOf(unfinished(now - maxRun * minute))).consecutiveFailures)
    }

    @Test
    fun `nextPollAt is exactly what the scheduler's decide says, back-off and a changed connection included`() {
        val c = connection()
        val tableau = mapOf(
            "one failure" to listOf(finished(now - 5 * minute, SyncOutcome.FAILED)),
            "two failures" to List(2) { finished(now - (5 + 10L * it) * minute, SyncOutcome.FAILED) },
            "five failures" to List(5) { finished(now - (5 + 10L * it) * minute, SyncOutcome.FAILED) },
            "twelve failures" to List(12) { finished(now - (5 + 10L * it) * minute, SyncOutcome.ABANDONED) },
            "success" to listOf(finished(now - 5 * minute, SyncOutcome.SUCCEEDED)),
            "due" to listOf(finished(now - 3 * interval * minute, SyncOutcome.SUCCEEDED)),
        )
        for ((label, runs) in tableau) {
            val expected = when (val decision = decide(c, runs, now, maxRun)) {
                Decision.Due -> now
                is Decision.Wait -> decision.until
                else -> null
            }
            assertEquals(expected, derive(runs, c).nextPollAt, label)
        }
        // The back-off is real: after two failures the next poll is two intervals after the newest finish, plus the connection's jitter.
        val two = tableau.getValue("two failures")
        val jitter = failureJitterMillis(interval * minute, 2 * interval * minute, failureJitterFraction(c.id, two.first().id))
        assertTrue(jitter in 1 until interval * minute / 2, "this connection's jitter is not zero: $jitter")
        assertEquals(two.first().finishedAt!! + 2 * interval * minute + jitter, derive(two, c).nextPollAt)
        // A connection changed after the newest run started is due at once, whatever the back-off.
        val changed = connection(changedAt = now - 2 * minute)
        assertEquals(now, derive(tableau.getValue("one failure"), changed).nextPollAt)
    }
}
