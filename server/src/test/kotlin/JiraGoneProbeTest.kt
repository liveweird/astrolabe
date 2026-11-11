package ch.nokillswit

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
    }
}
