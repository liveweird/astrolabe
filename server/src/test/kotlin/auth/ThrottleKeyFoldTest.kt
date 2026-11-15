package ch.nokillswit.auth

import ch.nokillswit.infra.validation.canonicalEmail
import java.security.MessageDigest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNotEquals

/**
 * Pins that both throttle keys (the login lockout's [loginIdentityKey] and [PasswordResetThrottle]'s cooldown) identify an address by its
 * canonical form (`canonicalEmail`: trimmed + case-folded), so one mailbox is one bucket in each. Pure; no server, no database.
 */
class ThrottleKeyFoldTest {

    /** Raw addresses differing from their canonical form by case, padding, a non-ASCII capital, or all three. */
    private val rawAddresses = listOf(
        "Admin@Example.COM",
        "  admin@example.com  ",
        "\tADMIN@example.com\n",
        "Élodie@Exämple.PL",
        "  ÉLODIE@EXÄMPLE.pl ",
        "İstanbul@Example.com",
        "ßtrasse@Example.COM",
        "already@canonical.test",
        "",
        "   ",
    )

    private fun sha256Hex(text: String): String =
        MessageDigest.getInstance("SHA-256").digest(text.toByteArray(Charsets.UTF_8)).joinToString("") { "%02x".format(it) }

    @Test
    fun `the login key of a raw address equals the key of its canonical form`() {
        for (raw in rawAddresses) {
            val canonical = canonicalEmail(raw)
            assertEquals(loginIdentityKey(canonical), loginIdentityKey(raw), "login key of <$raw>")
            assertEquals(sha256Hex(canonical), loginIdentityKey(raw), "login key is sha256 of the canonical form of <$raw>")
        }
    }

    @Test
    fun `the login key tells different mailboxes apart`() {
        assertNotEquals(loginIdentityKey("a@x.test"), loginIdentityKey("b@x.test"))
    }

    @Test
    fun `the reset throttle shares one cooldown between a raw address and its canonical form`() {
        for (raw in rawAddresses) {
            val canonical = canonicalEmail(raw)
            val rawFirst = PasswordResetThrottle(60_000) { 1_000L }
            assertEquals(PasswordResetThrottle.AcquireResult.ACQUIRED, rawFirst.tryAcquire(raw))
            assertEquals(PasswordResetThrottle.AcquireResult.COOLDOWN, rawFirst.tryAcquire(canonical), "canonical after <$raw>")

            val canonicalFirst = PasswordResetThrottle(60_000) { 1_000L }
            assertEquals(PasswordResetThrottle.AcquireResult.ACQUIRED, canonicalFirst.tryAcquire(canonical))
            assertEquals(PasswordResetThrottle.AcquireResult.COOLDOWN, canonicalFirst.tryAcquire(raw), "<$raw> after canonical")
        }
    }

    @Test
    fun `the reset throttle keeps different mailboxes apart`() {
        val throttle = PasswordResetThrottle(60_000) { 1_000L }
        assertEquals(PasswordResetThrottle.AcquireResult.ACQUIRED, throttle.tryAcquire("a@x.test"))
        assertEquals(PasswordResetThrottle.AcquireResult.ACQUIRED, throttle.tryAcquire("b@x.test"))
    }
}
