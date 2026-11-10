package ch.nokillswit

import ch.nokillswit.auth.LoginRequest
import ch.nokillswit.auth.PasswordResetConfirmRequest
import ch.nokillswit.auth.LoginThrottle
import ch.nokillswit.plugins.RateLimitAuditThrottle
import ch.nokillswit.users.PasswordChangeThrottle
import ch.nokillswit.users.PasswordChangeThrottleKey
import ch.nokillswit.users.PasswordUpdateRequest
import ch.nokillswit.users.UserRole
import io.ktor.client.request.put
import io.ktor.client.request.setBody
import io.ktor.client.statement.bodyAsText
import io.ktor.http.ContentType
import io.ktor.http.contentType
import io.ktor.http.HttpHeaders
import io.ktor.http.HttpStatusCode
import io.ktor.server.testing.testApplication
import kotlin.test.Test
import kotlin.test.assertContains
import kotlin.test.assertEquals
import kotlin.test.assertNotNull
import kotlin.test.assertNull

class PasswordChangeTest {

    @Test
    fun `self change with the correct current password works and the new password logs in`() = testApplication {
        usePostgresTestcontainer()
        val email = uniqueEmail("self")
        val userId = TestUsers.seed(email = email, password = "old-password", role = UserRole.USER)
        val client = authedClient(email, "old-password")

        val response = client.putJson(
            "/api/v1/users/$userId/password",
            PasswordUpdateRequest(password = "brand-new-password", currentPassword = "old-password"),
        )
        assertEquals(HttpStatusCode.NoContent, response.status)

        val login = jsonClient().postJson("/api/v1/login", LoginRequest(email, "brand-new-password"))
        assertEquals(HttpStatusCode.OK, login.status)
    }

    @Test
    fun `self change with a wrong or missing current password is 403 and mutates nothing`() = testApplication {
        usePostgresTestcontainer()
        val email = uniqueEmail("wrongcur")
        val userId = TestUsers.seed(email = email, password = "old-password", role = UserRole.USER)
        val client = authedClient(email, "old-password")

        val wrong = client.putJson(
            "/api/v1/users/$userId/password",
            PasswordUpdateRequest(password = "brand-new-password", currentPassword = "not-it"),
        )
        assertEquals(HttpStatusCode.Forbidden, wrong.status)

        val missing = client.putJson("/api/v1/users/$userId/password", PasswordUpdateRequest(password = "brand-new-password"))
        assertEquals(HttpStatusCode.Forbidden, missing.status)

        val oldStillWorks = jsonClient().postJson("/api/v1/login", LoginRequest(email, "old-password"))
        assertEquals(HttpStatusCode.OK, oldStillWorks.status)
    }

    @Test
    fun `an admin resets another user's password without the current one`() = testApplication {
        usePostgresTestcontainer()
        val adminEmail = uniqueEmail("resetter")
        val targetEmail = uniqueEmail("target")
        TestUsers.seed(email = adminEmail, password = "admin-pw", role = UserRole.ADMIN)
        val targetId = TestUsers.seed(email = targetEmail, password = "old-password", role = UserRole.USER)
        val client = authedClient(adminEmail, "admin-pw")

        val response = client.putJson("/api/v1/users/$targetId/password", PasswordUpdateRequest(password = "admin-chosen-pw"))
        assertEquals(HttpStatusCode.NoContent, response.status)

        val login = jsonClient().postJson("/api/v1/login", LoginRequest(targetEmail, "admin-chosen-pw"))
        assertEquals(HttpStatusCode.OK, login.status)
    }

    @Test
    fun `a regular user may not change somebody else's password`() = testApplication {
        usePostgresTestcontainer()
        val callerEmail = uniqueEmail("caller")
        val otherEmail = uniqueEmail("other")
        TestUsers.seed(email = callerEmail, password = "pw", role = UserRole.USER)
        val otherId = TestUsers.seed(email = otherEmail, password = "pw", role = UserRole.USER)
        val client = authedClient(callerEmail, "pw")

        val response = client.putJson("/api/v1/users/$otherId/password", PasswordUpdateRequest(password = "hijacked-pw!"))
        assertEquals(HttpStatusCode.Forbidden, response.status)
    }

    @Test
    fun `a too-short new password is 400`() = testApplication {
        usePostgresTestcontainer()
        val adminEmail = uniqueEmail("short")
        val targetId = TestUsers.seed(email = uniqueEmail("shorttarget"), password = "pw", role = UserRole.USER)
        TestUsers.seed(email = adminEmail, password = "admin-pw", role = UserRole.ADMIN)
        val client = authedClient(adminEmail, "admin-pw")

        val response = client.putJson("/api/v1/users/$targetId/password", PasswordUpdateRequest(password = "tiny"))
        assertEquals(HttpStatusCode.BadRequest, response.status)
    }

    @Test
    fun `resetting an unknown user is 404`() = testApplication {
        usePostgresTestcontainer()
        val adminEmail = uniqueEmail("notfound")
        TestUsers.seed(email = adminEmail, password = "admin-pw", role = UserRole.ADMIN)
        val client = authedClient(adminEmail, "admin-pw")

        val response = client.putJson("/api/v1/users/999999999/password", PasswordUpdateRequest(password = "whatever-works"))
        assertEquals(HttpStatusCode.NotFound, response.status)
    }

    private fun userPasswordPath(id: UInt) = "/api/v1/users/$id/password"

    private suspend fun io.ktor.client.HttpClient.selfChange(id: UInt, current: String, new: String = "brand-new-password") =
        putJson(userPasswordPath(id), PasswordUpdateRequest(password = new, currentPassword = current))

    @Test
    fun `threshold wrong current passwords lock the self change with 429 - and never touch login`() = testApplication {
        usePostgresTestcontainer()
        val email = uniqueEmail("pwlock")
        val userId = TestUsers.seed(email = email, password = "old-password", role = UserRole.USER)
        val client = authedClient(email, "old-password")

        withAuditCapture { audit ->
            repeat(5) {
                assertEquals(HttpStatusCode.Forbidden, client.selfChange(userId, "not-it").status)
            }
            // The right current password no longer helps while locked; the detail survives StatusPages' generic 429 handler.
            repeat(3) {
                val locked = client.selfChange(userId, "old-password")
                assertEquals(HttpStatusCode.TooManyRequests, locked.status)
                val body = locked.bodyAsText()
                assertContains(body, "wrong current passwords")
                // The SPA tells this 429 from the rate bucket's on the type, not the prose; the lock sends no Retry-After.
                assertContains(body, "urn:astrolabe:problem:password-change-locked")
                assertNull(locked.headers[HttpHeaders.RetryAfter])
            }
            // The load-bearing property: the lock is the password change's own, so the owner can still sign in.
            assertEquals(HttpStatusCode.OK, jsonClient().login(email, "old-password").status)

            fun events(name: String) =
                audit.events.filter { it.message == name && it.hasKeyValue("targetUserId", userId.toLong()) }
            assertEquals(5, events("password.change_denied").size, "the lock bounds the per-attempt event at the threshold")
            assertEquals(1, events("password.change_locked").size, "the lock trips once")
            assertEquals(1, events("password.change_rejected_locked").size, "three locked attempts write ONE coalesced event")
            assertNotNull(events("password.change_rejected_locked").single().keyValuePairs?.singleOrNull { it.key == "suppressed" })
            assertEquals(0, events("password.change_capacity_rejected").size)
        }
    }

    @Test
    fun `the coalesced locked-attempt event reports what the window folded in`() = testApplication {
        var now = 1_000_000L
        configureApp("security.lockout.threshold" to "2")
        application {
            attributes.put(
                PasswordChangeThrottleKey,
                PasswordChangeThrottle(
                    LoginThrottle(threshold = 2, lockoutMillis = 900_000, clock = { now }),
                    RateLimitAuditThrottle(intervalMs = 60_000, clock = { now }),
                ),
            )
        }
        startApplication()
        val email = uniqueEmail("pwcoalesce")
        val userId = TestUsers.seed(email = email, password = "old-password", role = UserRole.USER)
        val client = authedClient(email, "old-password")

        withAuditCapture { audit ->
            repeat(2) { client.selfChange(userId, "not-it") }
            repeat(5) { assertEquals(HttpStatusCode.TooManyRequests, client.selfChange(userId, "old-password").status) }
            fun events() = audit.events.filter {
                it.message == "password.change_rejected_locked" && it.hasKeyValue("targetUserId", userId.toLong())
            }
            assertEquals(1, events().size)
            assertEquals(true, events().single().hasKeyValue("suppressed", 0L))

            now += 60_000
            assertEquals(HttpStatusCode.TooManyRequests, client.selfChange(userId, "old-password").status)
            assertEquals(2, events().size)
            assertEquals(true, events().last().hasKeyValue("suppressed", 4L), "the four folded rejections ride the next event")
        }
    }

    @Test
    fun `a correct change clears the wrong-password counter`() = testApplication {
        usePostgresTestcontainer()
        val email = uniqueEmail("pwclear")
        val userId = TestUsers.seed(email = email, password = "old-password", role = UserRole.USER)
        val first = authedClient(email, "old-password")

        repeat(4) { assertEquals(HttpStatusCode.Forbidden, first.selfChange(userId, "not-it").status) }
        assertEquals(HttpStatusCode.NoContent, first.selfChange(userId, "old-password", "second-password").status)

        // The change ended the first session: sign in again. Had the counter survived, the first wrong attempt would trip the lock.
        val second = authedClient(email, "second-password")
        repeat(4) { assertEquals(HttpStatusCode.Forbidden, second.selfChange(userId, "not-it").status) }
        assertEquals(HttpStatusCode.NoContent, second.selfChange(userId, "second-password", "third-password").status)
    }

    @Test
    fun `a non-self caller gets 403 before any 429 - and an admin reset never trips or meets the lock`() = testApplication {
        usePostgresTestcontainer()
        val victimEmail = uniqueEmail("pwvictim")
        val victimId = TestUsers.seed(email = victimEmail, password = "old-password", role = UserRole.USER)
        val otherEmail = uniqueEmail("pwother")
        TestUsers.seed(email = otherEmail, password = "other-password", role = UserRole.USER)
        val adminEmail = uniqueEmail("pwadmin")
        val adminId = TestUsers.seed(email = adminEmail, password = "admin-password", role = UserRole.ADMIN)
        val victim = authedClient(victimEmail, "old-password")
        val other = authedClient(otherEmail, "other-password")
        val admin = authedClient(adminEmail, "admin-password")

        repeat(5) { victim.selfChange(victimId, "not-it") }
        assertEquals(HttpStatusCode.TooManyRequests, victim.selfChange(victimId, "old-password").status)

        // Guard first: a stranger sees the same 403 whether or not the account is locked (and cannot probe the lock).
        assertEquals(
            HttpStatusCode.Forbidden,
            other.putJson(userPasswordPath(victimId), PasswordUpdateRequest(password = "hijacked-pw!")).status,
        )

        // The admin path ignores the throttle: it neither trips it (wrong currentPassword values are never checked)
        // nor is blocked by a lock already in place.
        repeat(6) {
            val reset = admin.putJson(
                userPasswordPath(victimId),
                PasswordUpdateRequest(password = "admin-chosen-$it-pw", currentPassword = "ignored-for-others"),
            )
            assertEquals(HttpStatusCode.NoContent, reset.status)
        }
        assertEquals(HttpStatusCode.OK, jsonClient().login(victimEmail, "admin-chosen-5-pw").status)

        // And an admin resetting someone else leaves THEIR OWN counter untouched: a fresh self change still works.
        assertEquals(HttpStatusCode.NoContent, admin.selfChange(adminId, "admin-password", "admin-new-password").status)
    }

    @Test
    fun `a full throttle store answers 429 for an untracked user and keeps the tracked one working`() = testApplication {
        configureApp("security.lockout.maxTracked" to "1")
        startApplication()
        val trackedEmail = uniqueEmail("pwcap-tracked")
        val trackedId = TestUsers.seed(email = trackedEmail, password = "old-password", role = UserRole.USER)
        val rejectedEmail = uniqueEmail("pwcap-rejected")
        val rejectedId = TestUsers.seed(email = rejectedEmail, password = "old-password", role = UserRole.USER)
        val tracked = authedClient(trackedEmail, "old-password")
        val rejected = authedClient(rejectedEmail, "old-password")

        withAuditCapture { audit ->
            assertEquals(HttpStatusCode.Forbidden, tracked.selfChange(trackedId, "not-it").status)
            assertEquals(HttpStatusCode.TooManyRequests, rejected.selfChange(rejectedId, "old-password").status)
            assertNotNull(
                audit.awaitEvent {
                    it.message == "password.change_capacity_rejected" && it.hasKeyValue("targetUserId", rejectedId.toLong())
                },
                "capacity rejection is audited",
            )
            // The tracked identity continues its normal flow.
            assertEquals(HttpStatusCode.Forbidden, tracked.selfChange(trackedId, "still-not-it").status)
        }
    }

    private fun auditNamed(audit: LogCapture, name: String, userId: UInt) =
        audit.events.filter { it.message == name && it.hasKeyValue("targetUserId", userId.toLong()) }

    @Test
    fun `a malformed body while locked is 429, not 400 - the lock rides before the body`() = testApplication {
        usePostgresTestcontainer()
        val email = uniqueEmail("pwmalformed")
        val userId = TestUsers.seed(email = email, password = "old-password", role = UserRole.USER)
        val client = authedClient(email, "old-password")
        repeat(5) { assertEquals(HttpStatusCode.Forbidden, client.selfChange(userId, "not-it").status) }

        val locked = client.put(userPasswordPath(userId)) {
            contentType(ContentType.Application.Json)
            setBody("{not json")
        }
        assertEquals(HttpStatusCode.TooManyRequests, locked.status)
    }

    @Test
    fun `five requests with the current password missing lock the account`() = testApplication {
        usePostgresTestcontainer()
        val email = uniqueEmail("pwmissing")
        val userId = TestUsers.seed(email = email, password = "old-password", role = UserRole.USER)
        val client = authedClient(email, "old-password")

        repeat(5) {
            val missing = client.putJson(userPasswordPath(userId), PasswordUpdateRequest(password = "brand-new-password"))
            assertEquals(HttpStatusCode.Forbidden, missing.status)
        }
        assertEquals(HttpStatusCode.TooManyRequests, client.selfChange(userId, "old-password").status)
    }

    @Test
    fun `a wrong current password with a refused new password is 400 and does not count`() = testApplication {
        usePostgresTestcontainer()
        val email = uniqueEmail("pwshortwrong")
        val userId = TestUsers.seed(email = email, password = "old-password", role = UserRole.USER)
        val client = authedClient(email, "old-password")

        withAuditCapture { audit ->
            repeat(7) { assertEquals(HttpStatusCode.BadRequest, client.selfChange(userId, "not-it", "tiny").status) }
            assertEquals(0, auditNamed(audit, "password.change_denied", userId).size)
        }
        // Never locked: the real change still goes through.
        assertEquals(HttpStatusCode.NoContent, client.selfChange(userId, "old-password").status)
    }

    @Test
    fun `a right current password with a refused new password is 400, audits nothing and keeps the counter`() = testApplication {
        usePostgresTestcontainer()
        val email = uniqueEmail("pwshortright")
        val userId = TestUsers.seed(email = email, password = "old-password", role = UserRole.USER)
        val client = authedClient(email, "old-password")

        withAuditCapture { audit ->
            repeat(4) { assertEquals(HttpStatusCode.Forbidden, client.selfChange(userId, "not-it").status) }
            assertEquals(HttpStatusCode.BadRequest, client.selfChange(userId, "old-password", "tiny").status)
            assertEquals(4, auditNamed(audit, "password.change_denied", userId).size, "the 400 audits nothing new")
            assertEquals(0, auditNamed(audit, "password.changed", userId).size)
            // The counter was NOT cleared by the refused attempt: the very next wrong one is the fifth and locks.
            assertEquals(HttpStatusCode.Forbidden, client.selfChange(userId, "not-it").status)
            assertEquals(HttpStatusCode.TooManyRequests, client.selfChange(userId, "old-password").status)
        }
    }

    @Test
    fun `the lock expires through the route and the counter is usable again`() = testApplication {
        var now = 1_000_000L
        configureApp()
        application {
            attributes.put(
                PasswordChangeThrottleKey,
                PasswordChangeThrottle(LoginThrottle(threshold = 2, lockoutMillis = 900_000, clock = { now })),
            )
        }
        startApplication()
        val email = uniqueEmail("pwexpiry")
        val userId = TestUsers.seed(email = email, password = "old-password", role = UserRole.USER)
        val client = authedClient(email, "old-password")

        repeat(2) { assertEquals(HttpStatusCode.Forbidden, client.selfChange(userId, "not-it").status) }
        assertEquals(HttpStatusCode.TooManyRequests, client.selfChange(userId, "old-password").status)

        now += 900_000
        // Fresh window: one wrong attempt counts from zero (403, not 429), then the right one succeeds.
        assertEquals(HttpStatusCode.Forbidden, client.selfChange(userId, "not-it").status)
        assertEquals(HttpStatusCode.NoContent, client.selfChange(userId, "old-password").status)
    }

    @Test
    fun `an admin reset lifts an active lock`() = testApplication {
        usePostgresTestcontainer()
        val victimEmail = uniqueEmail("pwadminlift")
        val victimId = TestUsers.seed(email = victimEmail, password = "old-password", role = UserRole.USER)
        val adminEmail = uniqueEmail("pwadminlifter")
        TestUsers.seed(email = adminEmail, password = "admin-password", role = UserRole.ADMIN)
        val victim = authedClient(victimEmail, "old-password")
        val admin = authedClient(adminEmail, "admin-password")

        repeat(5) { victim.selfChange(victimId, "not-it") }
        assertEquals(HttpStatusCode.TooManyRequests, victim.selfChange(victimId, "old-password").status)

        val reset = admin.putJson(userPasswordPath(victimId), PasswordUpdateRequest(password = "admin-chosen-pw"))
        assertEquals(HttpStatusCode.NoContent, reset.status)

        val fresh = authedClient(victimEmail, "admin-chosen-pw")
        assertEquals(HttpStatusCode.NoContent, fresh.selfChange(victimId, "admin-chosen-pw", "owner-chosen-pw").status)
    }

    @Test
    fun `a completed emailed reset lifts an active lock`() = testApplication {
        usePostgresTestcontainer()
        val email = uniqueEmail("pwemaillift")
        val userId = TestUsers.seed(email = email, password = "old-password", role = UserRole.USER)
        val client = authedClient(email, "old-password")

        repeat(5) { client.selfChange(userId, "not-it") }
        assertEquals(HttpStatusCode.TooManyRequests, client.selfChange(userId, "old-password").status)

        val token = assertNotNull(newPasswordResetService().issueToken(userId, 0, email))
        val confirm = jsonClient().postJson("/api/v1/password-reset/confirm", PasswordResetConfirmRequest(token, "emailed-chosen-pw"))
        assertEquals(HttpStatusCode.NoContent, confirm.status)

        val fresh = authedClient(email, "emailed-chosen-pw")
        assertEquals(HttpStatusCode.NoContent, fresh.selfChange(userId, "emailed-chosen-pw", "owner-chosen-pw").status)
    }
}
