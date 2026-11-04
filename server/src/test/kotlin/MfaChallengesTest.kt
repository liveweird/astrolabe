package ch.nokillswit

import ch.nokillswit.auth.MfaChallenges
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertIs
import kotlin.test.assertNotEquals
import kotlin.test.assertTrue

/** Unit tests for the in-memory email-MFA challenge store (deterministic via an injected clock). */
class MfaChallengesTest {

    private var now = 1_000_000L
    private fun store(
        ttlMillis: Long = 300_000,
        maxAttempts: Int = 5,
        maxTracked: Int = 10_000,
        maxLivePerAccount: Int = 3,
    ) = MfaChallenges(ttlMillis, maxAttempts, clock = { now }, maxTracked = maxTracked, maxLivePerAccount = maxLivePerAccount)

    @Test
    fun `a correct code succeeds exactly once - the challenge is single-use`() {
        val s = store()
        val issued = s.issue(42u, credentialRevision = 7)
        assertEquals(6, issued.code.length)
        assertTrue(issued.code.all { it.isDigit() })
        assertEquals(now + 300_000, issued.expiresAt)

        val outcome = s.verify(issued.challengeId, issued.code)
        assertIs<MfaChallenges.Outcome.Success>(outcome)
        assertEquals(42u, outcome.userId)
        assertEquals(7L, outcome.credentialRevision)

        // Replay of the consumed challenge is indistinguishable from an unknown one.
        val replay = s.verify(issued.challengeId, issued.code)
        assertIs<MfaChallenges.Outcome.Failure>(replay)
        assertEquals("unknown_challenge", replay.reason)
    }

    @Test
    fun `an expired challenge fails and is dropped`() {
        val s = store(ttlMillis = 60_000)
        val issued = s.issue(7u, credentialRevision = 0)
        now += 60_000
        val outcome = s.verify(issued.challengeId, issued.code)
        assertIs<MfaChallenges.Outcome.Failure>(outcome)
        assertEquals("expired", outcome.reason)
        // The drop is permanent — a later attempt sees unknown, not expired.
        assertEquals(
            "unknown_challenge",
            (s.verify(issued.challengeId, issued.code) as MfaChallenges.Outcome.Failure).reason,
        )
    }

    @Test
    fun `wrong codes count toward the attempt cap and exhausting it kills the challenge`() {
        val s = store(maxAttempts = 3)
        val issued = s.issue(7u, credentialRevision = 0)
        assertEquals("wrong_code", (s.verify(issued.challengeId, "x") as MfaChallenges.Outcome.Failure).reason)
        assertEquals("wrong_code", (s.verify(issued.challengeId, "x") as MfaChallenges.Outcome.Failure).reason)
        assertEquals(
            "too_many_attempts",
            (s.verify(issued.challengeId, "x") as MfaChallenges.Outcome.Failure).reason,
        )
        // Even the correct code no longer works — the challenge is gone.
        assertEquals(
            "unknown_challenge",
            (s.verify(issued.challengeId, issued.code) as MfaChallenges.Outcome.Failure).reason,
        )
    }

    @Test
    fun `an unknown challenge id fails uniformly`() {
        val s = store()
        val outcome = s.verify("no-such-challenge", "123456")
        assertIs<MfaChallenges.Outcome.Failure>(outcome)
        assertEquals("unknown_challenge", outcome.reason)
    }

    @Test
    fun `challenge ids are unique and opaque`() {
        val s = store()
        val a = s.issue(1u, credentialRevision = 0)
        val b = s.issue(1u, credentialRevision = 0)
        assertNotEquals(a.challengeId, b.challengeId)
        assertEquals(32, a.challengeId.length)
        // Both stay independently verifiable (repeated logins may coexist within the TTL).
        assertIs<MfaChallenges.Outcome.Success>(s.verify(b.challengeId, b.code))
        assertIs<MfaChallenges.Outcome.Success>(s.verify(a.challengeId, a.code))
    }

    @Test
    fun `the store prunes expired entries once oversized instead of growing without bound`() {
        val s = store(ttlMillis = 1_000, maxTracked = 2)
        val stale = (1..2).map { s.issue(it.toUInt(), credentialRevision = 0) }
        assertFailsWith<MfaChallenges.CapacityExceededException> { s.issue(3u, credentialRevision = 0) }
        now += 2_000
        val fresh = s.issue(99u, credentialRevision = 0)
        assertEquals(
            "unknown_challenge",
            (s.verify(stale.first().challengeId, stale.first().code) as MfaChallenges.Outcome.Failure).reason,
        )
        assertIs<MfaChallenges.Outcome.Success>(s.verify(fresh.challengeId, fresh.code))
    }

    @Test
    fun `capacity keeps existing challenges verifiable`() {
        val s = store(maxTracked = 1)
        val issued = s.issue(1u, credentialRevision = 9)
        assertFailsWith<MfaChallenges.CapacityExceededException> { s.issue(2u, credentialRevision = 0) }
        val outcome = assertIs<MfaChallenges.Outcome.Success>(s.verify(issued.challengeId, issued.code))
        assertEquals(9L, outcome.credentialRevision)
        assertTrue(s.issue(2u, credentialRevision = 0).challengeId.isNotBlank())
    }

    @Test
    fun `discarding an undelivered challenge immediately releases its slot`() {
        val s = store(maxTracked = 1)
        val undelivered = s.issue(1u, credentialRevision = 0)
        s.discard(undelivered.challengeId)
        val replacement = s.issue(2u, credentialRevision = 0)
        assertEquals(
            "unknown_challenge",
            (s.verify(undelivered.challengeId, undelivered.code) as MfaChallenges.Outcome.Failure).reason,
        )
        assertIs<MfaChallenges.Outcome.Success>(s.verify(replacement.challengeId, replacement.code))
    }

    @Test
    fun `the 4th issue evicts the oldest challenge and another account is unaffected`() {
        val s = store()
        val other = s.issue(6u, credentialRevision = 0)
        val live = (1..3).map { s.issue(5u, credentialRevision = 0) }
        val fourth = s.issue(5u, credentialRevision = 0)
        assertEquals(1, fourth.evicted)
        assertEquals(0, live[1].evicted)
        assertEquals(
            "unknown_challenge",
            (s.verify(live[0].challengeId, live[0].code) as MfaChallenges.Outcome.Failure).reason,
        )
        (live.drop(1) + fourth + other).forEach {
            assertIs<MfaChallenges.Outcome.Success>(s.verify(it.challengeId, it.code))
        }
    }

    @Test
    fun `oldest means issue order, not expiry - even when the clock ties or runs backwards`() {
        val s = store(maxLivePerAccount = 2)
        val a = s.issue(5u, credentialRevision = 0)
        now -= 10_000 // b expires EARLIER than a: an expiry-ordered "oldest" would evict b
        val b = s.issue(5u, credentialRevision = 0)
        now += 10_000 // back to a's time: c ties with a
        val c = s.issue(5u, credentialRevision = 0)
        assertEquals("unknown_challenge", (s.verify(a.challengeId, a.code) as MfaChallenges.Outcome.Failure).reason)
        assertIs<MfaChallenges.Outcome.Success>(s.verify(b.challengeId, b.code))
        assertIs<MfaChallenges.Outcome.Success>(s.verify(c.challengeId, c.code))
    }

    @Test
    fun `a stale-revision challenge is dropped on issue and does not count toward the limit`() {
        val s = store(maxLivePerAccount = 2)
        val stale = s.issue(5u, credentialRevision = 1)
        val kept = s.issue(5u, credentialRevision = 2)
        val fresh = s.issue(5u, credentialRevision = 2)
        // stale went (an older revision), so kept survived: only 1 live entry then, under the limit of 2.
        assertEquals(1, kept.evicted)
        assertEquals(0, fresh.evicted)
        assertEquals("unknown_challenge", (s.verify(stale.challengeId, stale.code) as MfaChallenges.Outcome.Failure).reason)
        assertIs<MfaChallenges.Outcome.Success>(s.verify(kept.challengeId, kept.code))
        assertIs<MfaChallenges.Outcome.Success>(s.verify(fresh.challengeId, fresh.code))
    }

    @Test
    fun `a late login at an older revision cannot evict the owner's current challenge`() {
        val s = store(maxLivePerAccount = 1)
        val current = s.issue(5u, credentialRevision = 2)
        val late = s.issue(5u, credentialRevision = 1)
        assertEquals(0, late.evicted)
        assertIs<MfaChallenges.Outcome.Success>(s.verify(current.challengeId, current.code))
    }

    @Test
    fun `an account at its limit succeeds when the global store is full, a stranger does not`() {
        val s = store(maxTracked = 3, maxLivePerAccount = 3)
        val live = (1..3).map { s.issue(5u, credentialRevision = 0) }
        assertFailsWith<MfaChallenges.CapacityExceededException> { s.issue(6u, credentialRevision = 0) }
        val replacement = s.issue(5u, credentialRevision = 0) // eviction frees the slot first
        assertEquals(1, replacement.evicted)
        assertIs<MfaChallenges.Outcome.Success>(s.verify(replacement.challengeId, replacement.code))
        assertIs<MfaChallenges.Outcome.Success>(s.verify(live[2].challengeId, live[2].code))
    }

    @Test
    fun `a verified, exhausted or expired challenge frees its account slot and a late discard of an evicted one is a no-op`() {
        val s = store(maxAttempts = 1, ttlMillis = 60_000, maxLivePerAccount = 2)
        val a = s.issue(5u, credentialRevision = 0)
        val b = s.issue(5u, credentialRevision = 0)
        assertIs<MfaChallenges.Outcome.Success>(s.verify(a.challengeId, a.code))
        assertEquals(0, s.issue(5u, credentialRevision = 0).evicted, "the verified slot was free")
        assertIs<MfaChallenges.Outcome.Failure>(s.verify(b.challengeId, "x")) // maxAttempts = 1 kills it
        assertEquals(0, s.issue(5u, credentialRevision = 0).evicted, "the exhausted slot was free")
        now += 60_000
        assertEquals(0, s.issue(5u, credentialRevision = 0).evicted, "expired entries are pruned, not evicted")

        // A failed delivery's discard of an already-evicted challenge changes nothing.
        val x = s.issue(7u, credentialRevision = 0)
        val y = s.issue(7u, credentialRevision = 0)
        val z = s.issue(7u, credentialRevision = 0) // evicts x
        s.discard(x.challengeId)
        assertIs<MfaChallenges.Outcome.Success>(s.verify(y.challengeId, y.code))
        assertIs<MfaChallenges.Outcome.Success>(s.verify(z.challengeId, z.code))
    }

    @Test
    fun `concurrent issuance for ONE account never leaves more than the limit live`() {
        val s = store(maxLivePerAccount = 3)
        val threads = 8
        val ready = CountDownLatch(threads)
        val go = CountDownLatch(1)
        val executor = Executors.newFixedThreadPool(threads)
        try {
            val futures = (1..threads).map {
                executor.submit<MfaChallenges.IssuedChallenge> {
                    ready.countDown()
                    go.await()
                    s.issue(5u, credentialRevision = 0)
                }
            }
            ready.await()
            go.countDown()
            val issued = futures.map { it.get() }
            val verifying = issued.count { s.verify(it.challengeId, it.code) is MfaChallenges.Outcome.Success }
            assertEquals(3, verifying)
        } finally {
            executor.shutdownNow()
        }
    }

    @Test
    fun `a non-positive per-account cap is refused at construction`() {
        assertFailsWith<IllegalArgumentException> { store(maxLivePerAccount = 0) }
    }

    @Test
    fun `concurrent issuance cannot exceed capacity`() {
        val s = store(maxTracked = 1)
        val ready = CountDownLatch(2)
        val go = CountDownLatch(1)
        val executor = Executors.newFixedThreadPool(2)
        try {
            val results = (1..2).map { userId ->
                executor.submit<Boolean> {
                    ready.countDown()
                    go.await()
                    runCatching { s.issue(userId.toUInt(), credentialRevision = 0) }.isSuccess
                }
            }
            ready.await()
            go.countDown()
            assertEquals(listOf(false, true), results.map { it.get() }.sorted())
        } finally {
            executor.shutdownNow()
        }
    }
}
