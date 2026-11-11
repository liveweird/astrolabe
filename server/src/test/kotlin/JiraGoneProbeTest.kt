package ch.nokillswit

import ch.nokillswit.infra.time.MILLIS_PER_HOUR
import ch.nokillswit.jira.BoundIssue
import ch.nokillswit.jira.JiraLevel
import ch.nokillswit.jira.goneProbeQueue
import ch.nokillswit.jira.goneReasonFor
import ch.nokillswit.jira.isInScope
import ch.nokillswit.jira.wireGoneReason
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

class JiraGoneProbeTest {
    @Test
    fun `a 404 reads as deleted and a 403 as forbidden`() {
        assertEquals("DELETED", goneReasonFor("NOT_FOUND"))
        assertEquals("FORBIDDEN", goneReasonFor("FORBIDDEN_SCOPE"))
    }

    @Test
    fun `any other failure says nothing about the issue`() {
        assertNull(goneReasonFor("INVALID_RESPONSE"))
        assertNull(goneReasonFor("RATE_LIMITED"))
    }

    @Test
    fun `the wire reason is derived from the stored one, the probe stamp and the key against the connection's keys`() {
        val keys = listOf("E2E", "AB_C")
        // Not gone, or no verdict to refine: returned as stored, whatever the stamp and the key say.
        assertNull(wireGoneReason(null, null, null, keys))
        assertNull(wireGoneReason(null, 5, "OUT-1", keys))
        assertEquals("OUT_OF_SCOPE", wireGoneReason("OUT_OF_SCOPE", null, null, keys), "not yet answered: the sweep's wide phrase")
        assertEquals("OUT_OF_SCOPE", wireGoneReason("OUT_OF_SCOPE", null, "OUT-1", keys), "a key without a stamp is not an answer")
        assertEquals("DELETED", wireGoneReason("DELETED", 5, "E2E-1", keys), "a 404 verdict is final, any key")
        assertEquals("FORBIDDEN", wireGoneReason("FORBIDDEN", 5, null, keys))
        // A 200: no key = 1.12's inference, a key outside the projects = moved out, inside = not listed (the project is everything
        // before the LAST dash, so an underscore key is matched whole).
        assertEquals("MOVED_OUT", wireGoneReason("OUT_OF_SCOPE", 5, null, keys))
        assertEquals("MOVED_OUT", wireGoneReason("OUT_OF_SCOPE", 5, "OUT-3", keys))
        assertEquals("NOT_LISTED", wireGoneReason("OUT_OF_SCOPE", 5, "E2E-9", keys))
        assertEquals("NOT_LISTED", wireGoneReason("OUT_OF_SCOPE", 5, "AB_C-12", keys))
        assertEquals("MOVED_OUT", wireGoneReason("OUT_OF_SCOPE", 5, "AB_C-12", listOf("AB")), "derived against the CURRENT keys")
    }

    @Test
    fun `a key is in scope when its project, everything before the last dash, is one of the connection's keys`() {
        assertTrue(isInScope("E2E-1", listOf("E2E")))
        assertTrue(isInScope("AB_C-12", listOf("X", "AB_C")))
        assertFalse(isInScope("AB_C-12", listOf("AB")))
        assertFalse(isInScope("E2E-1", emptyList()))
        assertFalse(isInScope("OUT-1", setOf("E2E")))
        assertFalse(isInScope("E2E", listOf("E2E")), "a dash-less value is no key, even when it equals a project key")
        assertFalse(isInScope("e2e-1", listOf("e2e")), "nor is a value without the issue-key shape")
    }

    private val now = 1_000 * MILLIS_PER_HOUR

    /** A binding as the run-start snapshot holds it: the STORED [reason] when [gone], answered [hoursAgo] hours before [now]. */
    private fun bound(id: Int, gone: Boolean = true, reason: String? = "OUT_OF_SCOPE", hoursAgo: Long? = null) = BoundIssue(
        bindingId = id.toUInt(), level = JiraLevel.MILESTONE, issueId = "$id", issueKey = "E2E-$id", observed = true, gone = gone,
        typeId = "10004", goneReason = reason.takeIf { gone }, probedAt = hoursAgo?.let { now - it * MILLIS_PER_HOUR },
    )

    private fun queue(vararg rows: BoundIssue, manual: Boolean = false, hours: Int = 24, cap: Int = 100) =
        goneProbeQueue(rows.toList(), manual, now, hours, cap).map { it.bindingId.toInt() }

    @Test
    fun `the queue ranks newly flagged first, then never answered, then the readable ones due, each oldest answer first then by id`() {
        val rows = arrayOf(
            bound(9, hoursAgo = 30), bound(8, hoursAgo = 50), bound(7, hoursAgo = 50), bound(6),
            bound(5), bound(4, gone = false), bound(3, gone = false),
        )
        assertEquals(listOf(3, 4, 5, 6, 7, 8, 9), queue(*rows), "rank 0 by id, rank 1 by id, rank 2 by oldest answer then id")
        assertEquals(listOf(3, 4, 5, 6, 7, 8, 9), queue(*rows.reversedArray()), "the input order does not matter")
    }

    @Test
    fun `a readable answer is asked again once the interval has passed, exactly at the interval included`() {
        assertEquals(emptyList(), queue(bound(1, hoursAgo = 23)), "23 hours of 24")
        assertEquals(listOf(1), queue(bound(1, hoursAgo = 24)), "exactly the interval")
        assertEquals(listOf(1), queue(bound(1, hoursAgo = 25)))
        val almost = BoundIssue(1u, JiraLevel.MILESTONE, "1", "E2E-1", true, true, "10004", "OUT_OF_SCOPE", now - 24 * MILLIS_PER_HOUR + 1)
        assertEquals(emptyList(), goneProbeQueue(listOf(almost), false, now, 24, 100), "one millisecond short")
        assertEquals(emptyList(), queue(bound(1, hoursAgo = 47), hours = 48), "the configured hours decide")
        assertEquals(listOf(1), queue(bound(1, hoursAgo = 48), hours = 48))
    }

    @Test
    fun `a manual run asks every readable answer again, however young`() {
        val rows = arrayOf(bound(1, hoursAgo = 0), bound(2, hoursAgo = 1), bound(3, hoursAgo = 23), bound(4, hoursAgo = 100))
        assertEquals(emptyList(), queue(*rows.take(3).toTypedArray()), "a scheduled run: none of the young ones")
        assertEquals(listOf(4, 3, 2, 1), queue(*rows, manual = true), "a manual run: all, the oldest answer first")
    }

    @Test
    fun `a 404 or 403 verdict is never asked again, a manual run included`() {
        val rows = arrayOf(bound(1, reason = "DELETED", hoursAgo = 500), bound(2, reason = "FORBIDDEN", hoursAgo = 500))
        assertEquals(emptyList(), queue(*rows, manual = true))
        assertEquals(emptyList(), queue(*rows))
        assertEquals(listOf(3), queue(*rows, bound(3), manual = true), "while a never-answered one is")
    }

    @Test
    fun `the cap counts all three groups, the first ones in rank order win`() {
        val rows = arrayOf(bound(1, hoursAgo = 99), bound(2), bound(3, gone = false), bound(4, gone = false), bound(5, hoursAgo = 98))
        assertEquals(listOf(3, 4, 2, 1, 5), queue(*rows, manual = true))
        assertEquals(listOf(3, 4, 2), queue(*rows, manual = true, cap = 3))
        assertEquals(listOf(3), queue(*rows, manual = true, cap = 1))
        assertEquals(emptyList(), queue(*rows, manual = true, cap = 0))
    }

    @Test
    fun `the least recently tried goes first within a rank - a failed read queues behind the others`() {
        val stuck = arrayOf(bound(1), bound(2), bound(3))
        val fresh = arrayOf(bound(4), bound(5))
        val tried = mapOf(1u to 500L, 2u to 100L, 3u to 300L)
        fun order(rows: Array<BoundIssue>) =
            goneProbeQueue(rows.toList(), false, now, 24, 100, tried).map { it.bindingId.toInt() }
        assertEquals(listOf(4, 5, 2, 3, 1), order(stuck + fresh), "never tried first (by id), then the oldest failed read")
        // Rank still decides first: a newly flagged binding goes ahead of an older failed one.
        assertEquals(listOf(6, 4, 5, 2, 3, 1), order(stuck + fresh + bound(6, gone = false)))
        // Rank 2 (readable, due): the failed re-ask queues behind the others due, whatever the age of its answer.
        val readable = arrayOf(bound(1, hoursAgo = 90), bound(2, hoursAgo = 30), bound(3, hoursAgo = 60))
        assertEquals(
            listOf(3, 2, 1),
            goneProbeQueue(readable.toList(), true, now, 24, 100, mapOf(1u to now)).map { it.bindingId.toInt() },
            "1 failed just now: after 3 (answered 60 h ago) and 2 (30 h ago)",
        )
        assertEquals(
            listOf(1, 3, 2),
            goneProbeQueue(readable.toList(), true, now, 24, 100).map { it.bindingId.toInt() },
            "without the memory: the oldest answer first",
        )
        assertEquals(
            listOf(4, 5),
            goneProbeQueue((stuck + fresh).toList(), false, now, 24, 2, tried).map { it.bindingId.toInt() },
            "the cap keeps the rotation's front: the stuck ones wait for a later run",
        )
    }

    @Test
    fun `rows whose read failed queue behind every row not yet tried, across ranks 1 and 2 alike`() {
        val rows = arrayOf(
            bound(1), bound(2), bound(3), // rank 1, all stuck
            bound(4, hoursAgo = 30), // rank 2, never failed
            bound(5, hoursAgo = 90), // rank 2, stuck
            bound(6, gone = false), // rank 0
            bound(7), // rank 1, never tried
        )
        val tried = mapOf(1u to 500L, 2u to 100L, 3u to 300L, 5u to 200L)
        fun order(cap: Int = 100) = goneProbeQueue(rows.toList(), false, now, 24, cap, tried).map { it.bindingId.toInt() }
        assertEquals(
            listOf(6, 7, 4, 2, 5, 3, 1),
            order(),
            "rank 0, untried rank 1, untried rank 2, then every failed row by the time of its failure, rank ignored",
        )
        assertEquals(listOf(6, 7, 4), order(cap = 3), "three stuck rank-1 rows do not keep the due re-ask out of a cap that would fit it")
        val tie = arrayOf(bound(9), bound(8), bound(10, hoursAgo = 40))
        assertEquals(
            listOf(8, 9, 10),
            goneProbeQueue(tie.toList(), false, now, 24, 100, mapOf(8u to 7L, 9u to 7L, 10u to 7L)).map { it.bindingId.toInt() },
            "equal failure times: by id",
        )
    }

    @Test
    fun `without retries only the newly flagged bindings are queued, a manual run included`() {
        val rows = arrayOf(bound(1), bound(2, hoursAgo = 50), bound(3, gone = false), bound(4, gone = false))
        fun order(manual: Boolean, retries: Boolean) =
            goneProbeQueue(rows.toList(), manual, now, 24, 100, retries = retries).map { it.bindingId.toInt() }
        assertEquals(listOf(3, 4), order(manual = false, retries = false), "a tripped scheduled run")
        assertEquals(listOf(3, 4), order(manual = true, retries = false), "the flag is the caller's to lift for a manual run")
        assertEquals(listOf(3, 4, 1, 2), order(manual = true, retries = true))
    }
}
