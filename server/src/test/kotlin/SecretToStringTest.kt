package ch.nokillswit

import ch.nokillswit.auth.IssuedToken
import ch.nokillswit.auth.LoginRequest
import ch.nokillswit.auth.LoginResponse
import ch.nokillswit.auth.LogoutRequest
import ch.nokillswit.auth.MfaChallengeResponse
import ch.nokillswit.auth.MfaChallenges
import ch.nokillswit.auth.MfaVerifyRequest
import ch.nokillswit.auth.PasswordResetConfirmRequest
import ch.nokillswit.auth.RefreshRequest
import ch.nokillswit.flow.FlowConnectionRequest
import ch.nokillswit.flow.FlowConnectionTarget
import ch.nokillswit.jira.JiraAuthScheme
import ch.nokillswit.jira.JiraConnectionRequest
import ch.nokillswit.jira.JiraTestTarget
import ch.nokillswit.users.User
import ch.nokillswit.users.UserCreateRequest
import ch.nokillswit.users.UserRole
import ch.nokillswit.users.PasswordUpdateRequest
import ch.nokillswit.infra.maskedSecret
import ch.nokillswit.plugins.JwtConfig
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

/**
 * Checkup 3, D7-5: every data class that carries a password, token, hash, MFA code or signing key renders it
 * as `***` in `toString()`, so a templated request/response/config object can never put a secret into a log
 * line. The secrets below are distinctive markers; each object's rendering must contain none of them but must
 * still contain its non-secret fields (the override is not just an empty string).
 */
class SecretToStringTest {
    private val secret = "S3CR3T-MARKER-9f2c"

    private fun assertMasked(rendered: String, keeps: String) {
        assertFalse(secret in rendered, "the secret leaked into: $rendered")
        assertTrue("***" in rendered, "a present secret must render as ***: $rendered")
        assertTrue(keeps in rendered, "the non-secret fields must stay visible: $rendered")
    }

    @Test
    fun `maskedSecret hides a value and keeps only its presence`() {
        assertEquals("***", maskedSecret(secret))
        assertEquals("***", maskedSecret(""))
        assertEquals("null", maskedSecret(null))
    }

    @Test
    fun `auth request and response shapes mask their credentials`() {
        assertMasked(LoginRequest("a@b.c", secret).toString(), "a@b.c")
        assertMasked(MfaVerifyRequest(secret, secret).toString(), "MfaVerifyRequest")
        assertMasked(RefreshRequest(secret).toString(), "RefreshRequest")
        assertMasked(PasswordResetConfirmRequest(secret, secret).toString(), "PasswordResetConfirmRequest")
        assertMasked(LogoutRequest(secret).toString(), "LogoutRequest")
        assertEquals("LogoutRequest(refreshToken=null)", LogoutRequest().toString())
        assertMasked(MfaChallengeResponse(challengeId = secret, expiresAt = 42).toString(), "expiresAt=42")
        val login = LoginResponse(
            token = secret,
            expiresAt = 1,
            refreshToken = secret,
            refreshExpiresAt = 2,
            userId = 7u,
            roles = listOf(UserRole.ADMIN),
            disabledFeatures = emptyList(),
            language = "pl",
        )
        assertMasked(login.toString(), "userId=7")
        assertFalse(secret in login.toString())
        assertMasked(IssuedToken(secret, expiresAt = 9).toString(), "expiresAt=9")
    }

    @Test
    fun `an issued MFA challenge masks its code and id`() {
        val issued = MfaChallenges(ttlMillis = 60_000, maxAttempts = 3).issue(userId = 1u, credentialRevision = 0)
        val rendered = issued.toString()
        assertFalse(issued.code in rendered, "the MFA code leaked into: $rendered")
        assertFalse(issued.challengeId in rendered, "the challenge id leaked into: $rendered")
        assertTrue("expiresAt=${issued.expiresAt}" in rendered)
    }

    @Test
    fun `user shapes mask passwords and the password hash`() {
        val user = User(name = "Ann", email = "ann@example.test", passwordHash = secret)
        assertMasked(user.toString(), "ann@example.test")
        assertMasked(UserCreateRequest("Ann", "ann@example.test", secret).toString(), "ann@example.test")
        val update = PasswordUpdateRequest(password = secret, currentPassword = secret).toString()
        assertMasked(update, "PasswordUpdateRequest")
        assertEquals("PasswordUpdateRequest(password=***, currentPassword=null)", PasswordUpdateRequest(secret).toString())
    }

    @Test
    fun `configuration shapes mask their secrets`() {
        val jwt = JwtConfig(secret, "issuer-x", "aud-x", "realm-x", 900, 86_400)
        assertMasked(jwt.toString(), "issuer-x")
    }

    @Test
    fun `a Jira connection request masks its API token and keeps the rest`() {
        val request = JiraConnectionRequest(
            name = "Main", siteUrl = "https://sample.atlassian.net", email = "jira@example.test", apiToken = secret,
            authScheme = JiraAuthScheme.BEARER, projectKeys = listOf("SP"), enabled = true,
        )
        assertMasked(request.toString(), "sample.atlassian.net")
        assertTrue("authScheme=BEARER" in request.toString() && "projectKeys=[SP]" in request.toString())
        assertTrue("apiToken=null" in request.copy(apiToken = null).toString(), "an absent token renders as null, not ***")
    }

    @Test
    fun `a Jira test target masks the decrypted API token and keeps the rest`() {
        val target = JiraTestTarget("https://sample.atlassian.net", "jira@example.test", secret, JiraAuthScheme.BASIC, listOf("SP"), 7L)
        assertMasked(target.toString(), "sample.atlassian.net")
        assertTrue("apiToken=***" in target.toString() && "projectKeys=[SP]" in target.toString())
        val unreadable = JiraTestTarget("https://s.atlassian.net", "a@b.c", null, JiraAuthScheme.BEARER, listOf("SP"))
        assertTrue("apiToken=null" in unreadable.toString())
    }

    @Test
    fun `a Flow connection request masks its service token and keeps the rest`() {
        val request = FlowConnectionRequest(
            name = "Main", baseUrl = "http://flow.test:8080", timeZone = "Europe/Warsaw", apiToken = secret, enabled = true,
            pollIntervalMinutes = 60,
        )
        assertMasked(request.toString(), "flow.test:8080")
        assertTrue("timeZone=Europe/Warsaw" in request.toString() && "pollIntervalMinutes=60" in request.toString())
        assertTrue("apiToken=null" in request.copy(apiToken = null).toString(), "an absent token renders as null, not ***")
        // A real-looking token, not just the marker: the rendering must not contain any part of it.
        val real = flowToken('Q')
        assertFalse("Q".repeat(10) in request.copy(apiToken = real).toString())
    }

    @Test
    fun `a decrypted Flow connection target masks the token and keeps the rest`() {
        val target = FlowConnectionTarget(7u, "Main", "http://flow.test:8080", "UTC", secret, enabled = true, expectedUpdatedAt = 9L)
        assertMasked(target.toString(), "flow.test:8080")
        assertTrue("apiToken=***" in target.toString() && "expectedUpdatedAt=9" in target.toString())
        assertTrue("apiToken=null" in target.copy(apiToken = null).toString(), "an unreadable token renders as null")
    }
}
