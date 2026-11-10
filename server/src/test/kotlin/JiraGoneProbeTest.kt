package ch.nokillswit

import ch.nokillswit.jira.goneReasonFor
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull

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
}
