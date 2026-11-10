package ch.nokillswit

import ch.nokillswit.authz.ConflictException
import ch.nokillswit.sync.SyncCounts
import ch.nokillswit.sync.SyncKind
import ch.nokillswit.sync.SyncOutcome
import ch.nokillswit.sync.SyncResult
import ch.nokillswit.sync.SyncRunService
import ch.nokillswit.sync.SyncTrigger
import ch.nokillswit.sync.clampErrorDetail
import ch.nokillswit.sync.MAX_LISTED_RUNS
import ch.nokillswit.sync.RUN_IN_PROGRESS_PROBLEM
import kotlinx.coroutines.runBlocking
import java.util.concurrent.ThreadLocalRandom
import kotlin.test.AfterTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * The run registry over the shared database (`sync_runs.connection_id` has no foreign key, so a throwaway connection id isolates a test;
 * `requested_by_user_id` does reference `users`, so a requester is a seeded user): the claim and
 * its 409, abandonment by age, the prune to the last 50, what `finish` stores and clamps, and the watermark read.
 */
class SyncRunServiceTest {
    private val connections = mutableListOf<UInt>()

    /** A connection id no other test uses (the table has no FK; the cleanup removes the rows). */
    private fun connection(): UInt = ThreadLocalRandom.current().nextInt(1_000_000, Int.MAX_VALUE).toUInt().also { connections += it }

    @AfterTest
    fun cleanup() {
        connections.forEach { jbSql("DELETE FROM sync_runs WHERE connection_id = ?", it.toInt()) }
        connections.clear()
    }

    private class Clock(var now: Long = 1_800_000_000_000L) : () -> Long {
        override fun invoke() = now
    }

    private fun service(clock: Clock = Clock(), maxRunMinutes: Int = 10) = SyncRunService(sharedDatabaseForTests(), maxRunMinutes, clock)

    @Test
    fun `a claim writes the unfinished row and a second claim of the same connection is a 409 run-in-progress`() = runBlocking {
        val runs = service()
        val id = connection()
        val requester = TestUsers.seed(uniqueEmail("syncrun"), "sync-run-pass-1")
        val claimed = runs.claimUnchecked(SyncKind.JIRA, id, SyncTrigger.MANUAL, requester)
        val listed = runs.list(SyncKind.JIRA, id).single()
        assertEquals(claimed.id, listed.id)
        assertNull(listed.finishedAt)
        assertNull(listed.outcome)
        assertEquals(SyncTrigger.MANUAL, listed.trigger)
        assertEquals(requester, listed.requestedByUserId)
        val refused = assertFailsWith<ConflictException> { runs.claimUnchecked(SyncKind.JIRA, id, SyncTrigger.SCHEDULED, null) }
        assertEquals(RUN_IN_PROGRESS_PROBLEM, refused.problemType)
        assertEquals(1, runs.list(SyncKind.JIRA, id).size, "the refused claim left nothing behind")
        // Another connection is independent; a finished run frees its own.
        runs.claimUnchecked(SyncKind.JIRA, connection(), SyncTrigger.MANUAL, null)
        assertTrue(runs.finish(claimed.id, SyncResult.succeeded(SyncCounts())))
        runs.claimUnchecked(SyncKind.JIRA, id, SyncTrigger.SCHEDULED, null)
        assertEquals(setOf(SyncTrigger.MANUAL, SyncTrigger.SCHEDULED), runs.list(SyncKind.JIRA, id).map { it.trigger }.toSet())
    }

    @Test
    fun `an unfinished run older than maxRunMinutes is abandoned by the next claim, and its late finish changes nothing`() = runBlocking {
        val clock = Clock()
        val runs = service(clock, maxRunMinutes = 10)
        val id = connection()
        val stale = runs.claimUnchecked(SyncKind.JIRA, id, SyncTrigger.MANUAL, null)
        clock.now += 10 * 60_000L // exactly the limit: still valid (the bound is strict)
        assertFailsWith<ConflictException> { runs.claimUnchecked(SyncKind.JIRA, id, SyncTrigger.MANUAL, null) }
        assertNull(runs.list(SyncKind.JIRA, id).single().outcome)
        clock.now += 1
        val fresh = runs.claimUnchecked(SyncKind.JIRA, id, SyncTrigger.MANUAL, null)
        val byId = runs.list(SyncKind.JIRA, id).associateBy { it.id }
        val abandoned = byId.getValue(stale.id)
        assertEquals(SyncOutcome.ABANDONED, abandoned.outcome)
        assertEquals("ABANDONED", abandoned.errorCode)
        assertEquals(clock.now, abandoned.finishedAt)
        assertNull(byId.getValue(fresh.id).finishedAt, "the new claim is the unfinished one")
        // The original run wakes up and finishes: the abandonment stands.
        assertFalse(runs.finish(stale.id, SyncResult.succeeded(SyncCounts(observed = 5))))
        val after = runs.list(SyncKind.JIRA, id).associateBy { it.id }.getValue(stale.id)
        assertEquals(SyncOutcome.ABANDONED, after.outcome)
        assertEquals(0, after.observedCount)
    }

    @Test
    fun `the claim prunes finished runs to the last 50 per connection and spares other connections`() = runBlocking {
        val clock = Clock()
        val runs = service(clock)
        val id = connection()
        val other = connection()
        val otherRun = runs.claimUnchecked(SyncKind.JIRA, other, SyncTrigger.MANUAL, null)
        runs.finish(otherRun.id, SyncResult.succeeded(SyncCounts()))
        val ids = (1..MAX_LISTED_RUNS + 5).map {
            clock.now += 1_000
            val run = runs.claimUnchecked(SyncKind.JIRA, id, SyncTrigger.MANUAL, null)
            runs.finish(run.id, SyncResult.succeeded(SyncCounts()))
            run.id
        }
        val kept = runs.list(SyncKind.JIRA, id)
        assertEquals(MAX_LISTED_RUNS, kept.size)
        assertEquals(ids.takeLast(MAX_LISTED_RUNS).reversed(), kept.map { it.id }, "the newest 50, newest first")
        assertEquals(1, runs.list(SyncKind.JIRA, other).size, "another connection's history is not pruned")
        // 50 finished + one unfinished claim: the claim leaves room for itself, so the unfinished row is the 50th.
        clock.now += 1_000
        val running = runs.claimUnchecked(SyncKind.JIRA, id, SyncTrigger.MANUAL, null)
        val withRunning = runs.list(SyncKind.JIRA, id)
        assertEquals(MAX_LISTED_RUNS, withRunning.size)
        assertEquals(running.id, withRunning.first().id)
        assertNull(withRunning.first().finishedAt)
    }

    @Test
    fun `finish stores the outcome, the counters and a clamped detail`() = runBlocking {
        val runs = service()
        val id = connection()
        val ok = runs.claimUnchecked(SyncKind.JIRA, id, SyncTrigger.MANUAL, null)
        val counts = SyncCounts(observed = 12, gone = 3, calls = 9, rateLimited = 2, backoffMs = 4_500)
        assertTrue(runs.finish(ok.id, SyncResult.succeeded(counts)))
        val longDetail = "x".repeat(2_000) + " https://acme.atlassian.net/rest/api/3/search/jql?jql=secret&fields=id Bearer abc.def-ghi"
        val failed = runs.claimUnchecked(SyncKind.JIRA, id, SyncTrigger.MANUAL, null)
        assertTrue(runs.finish(failed.id, SyncResult.failed("A".repeat(80), longDetail, SyncCounts(calls = 4))))
        val rows = runs.list(SyncKind.JIRA, id).associateBy { it.id }
        val success = rows.getValue(ok.id)
        assertEquals(SyncOutcome.SUCCEEDED, success.outcome)
        assertEquals(listOf(12, 3, 9, 2), listOf(success.observedCount, success.goneCount, success.callCount, success.rateLimitedCount))
        assertEquals(4_500L, success.backoffMs)
        assertNull(success.errorCode)
        val failure = rows.getValue(failed.id)
        assertEquals(SyncOutcome.FAILED, failure.outcome)
        assertEquals(40, failure.errorCode?.length, "the code is cut to its column")
        assertEquals(500, failure.errorDetail?.length)
        assertEquals(4, failure.callCount)
    }

    @Test
    fun `lastSucceededStart is the newest succeeded run's start, not a failed or unfinished one's`() = runBlocking {
        val clock = Clock()
        val runs = service(clock)
        val id = connection()
        assertNull(runs.lastSucceededStart(SyncKind.JIRA, id))
        val first = runs.claimUnchecked(SyncKind.JIRA, id, SyncTrigger.MANUAL, null)
        runs.finish(first.id, SyncResult.succeeded(SyncCounts()))
        clock.now += 60_000
        val failed = runs.claimUnchecked(SyncKind.JIRA, id, SyncTrigger.MANUAL, null)
        runs.finish(failed.id, SyncResult.failed("TIMEOUT"))
        clock.now += 60_000
        runs.claimUnchecked(SyncKind.JIRA, id, SyncTrigger.MANUAL, null)
        assertEquals(first.startedAt, runs.lastSucceededStart(SyncKind.JIRA, id))
    }

    @Test
    fun `a stored error text never holds a URL, a query string, a credential or control characters`() {
        assertNull(clampErrorDetail(null))
        assertNull(clampErrorDetail("  \n\t "))
        assertEquals(
            "GET [url] failed",
            clampErrorDetail("GET https://api.atlassian.com/ex/jira/abc/rest/api/3/search/jql?jql=project%20in%20(X)&fields=id failed"),
        )
        assertEquals(
            "sent Basic [redacted] and Bearer [redacted]",
            clampErrorDetail("sent Basic dXNlcjpzZWNyZXQ= and Bearer eyJ.abc-def_1"),
        )
        assertEquals(
            "Jira fetch failed: NOT_FOUND @ /rest/api/3/issue/{id}",
            clampErrorDetail("Jira fetch failed: NOT_FOUND @ /rest/api/3/issue/{id}?fields=a,b"),
        )
        assertEquals("a b c", clampErrorDetail("a\u0000b\r\n  c"))
        // The cut never leaves half a surrogate pair.
        val cut = clampErrorDetail("y".repeat(499) + "😀") ?: error("expected a text")
        assertEquals(499, cut.length)
        assertTrue(cut.all { it == 'y' })
    }

    @Test
    fun `running is the registry's verdict - true only for an unfinished run inside the claim window`() = runBlocking {
        val clock = Clock()
        val runs = service(clock, maxRunMinutes = 10)
        val id = connection()
        val claimed = runs.claimUnchecked(SyncKind.JIRA, id, SyncTrigger.MANUAL, null)
        assertTrue(runs.list(SyncKind.JIRA, id).single().running, "just claimed")
        clock.now += 10 * 60_000L
        assertTrue(runs.list(SyncKind.JIRA, id).single().running, "exactly at the limit: still inside the window")
        clock.now += 1
        assertFalse(runs.list(SyncKind.JIRA, id).single().running, "unfinished and older than maxRunMinutes: interrupted")
        assertFalse(runs.isRunning(finishedAt = null, startedAt = claimed.startedAt, now = clock.now))
        assertTrue(runs.finish(claimed.id, SyncResult.succeeded(SyncCounts())))
        assertFalse(runs.list(SyncKind.JIRA, id).single().running, "finished")
        assertFalse(runs.isRunning(finishedAt = clock.now, startedAt = clock.now, now = clock.now), "a finished run is never running")
    }
}
