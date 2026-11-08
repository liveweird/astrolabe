package ch.nokillswit

import ch.nokillswit.infra.crypto.FieldCipher
import ch.nokillswit.infra.crypto.decryptOrNull
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue
import org.slf4j.LoggerFactory

/** Pure unit tests for the one unreadable-token rule (`decryptOrNull`): no container, no Ktor. */
class UnreadableTokenTest {

    private val cipher = FieldCipher("0000000000000000000000000000000000000000000000000000000000000001")
    private val loggerName = "ch.nokillswit.UnreadableTokenTest"
    private val log = LoggerFactory.getLogger(loggerName)

    private fun <T> captured(block: () -> T): Pair<T, List<ch.qos.logback.classic.spi.ILoggingEvent>> {
        val capture = LogCapture(loggerName)
        try {
            val result = block()
            return result to capture.events.toList()
        } finally {
            capture.detach()
        }
    }

    @Test
    fun `a null envelope reads as null and logs nothing`() {
        val (token, events) = captured { cipher.decryptOrNull(null, log, "API token of Jira", 7u) }
        assertNull(token)
        assertTrue(events.isEmpty())
    }

    @Test
    fun `a valid envelope reads as its plaintext and logs nothing`() {
        val (token, events) = captured { cipher.decryptOrNull(cipher.encrypt("s3cret-token"), log, "API token of Jira", 7u) }
        assertEquals("s3cret-token", token)
        assertTrue(events.isEmpty())
    }

    @Test
    fun `a tampered envelope reads as null with one WARN naming the class and never the envelope`() {
        val envelope = cipher.encrypt("integrity matters")
        val tampered = envelope.dropLast(2) + if (envelope[envelope.length - 2] == 'A') "B=" else "A="
        val (token, events) = captured { cipher.decryptOrNull(tampered, log, "service token of Flow", 42u) }
        assertNull(token)
        val event = events.single()
        assertEquals(ch.qos.logback.classic.Level.WARN, event.level)
        assertEquals("The stored service token of Flow connection 42 cannot be decrypted (AEADBadTagException)", event.formattedMessage)
        assertFalse(tampered in event.formattedMessage)
        assertFalse("enc:v1:" in event.formattedMessage)
    }

    @Test
    fun `a malformed envelope reads as null`() {
        // Truncated body (IllegalArgumentException from the size check) and invalid base64 (IllegalArgumentException from the decoder).
        val (truncated, truncatedEvents) = captured { cipher.decryptOrNull("enc:v1:AAAA", log, "API token of Jira", 1u) }
        assertNull(truncated)
        assertEquals(
            "The stored API token of Jira connection 1 cannot be decrypted (IllegalArgumentException)",
            truncatedEvents.single().formattedMessage,
        )
        val (notBase64, _) = captured { cipher.decryptOrNull("enc:v1:!!not base64!!", log, "API token of Jira", 1u) }
        assertNull(notBase64)
    }

    @Test
    fun `a value without the envelope prefix is legacy plaintext and passes through unchanged`() {
        // FieldCipher.decrypt passes a non-enveloped value through; only an `enc:v1:` envelope can fail
        // (the V21 and V24 CHECKs keep others out).
        val (token, events) = captured { cipher.decryptOrNull("not-an-envelope", log, "API token of Jira", 1u) }
        assertEquals("not-an-envelope", token)
        assertTrue(events.isEmpty())
    }
}
