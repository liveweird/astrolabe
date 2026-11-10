package ch.nokillswit

import ch.nokillswit.auth.LoginRequest
import ch.nokillswit.users.PasswordUpdateRequest
import ch.nokillswit.users.UserRole
import io.ktor.client.HttpClient
import io.ktor.client.statement.bodyAsText
import io.ktor.http.HttpHeaders
import io.ktor.http.HttpStatusCode
import io.ktor.server.testing.testApplication
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNotNull
import kotlin.test.assertTrue

/**
 * The per-USER `password-change` token bucket on `PUT /users/{id}/password` (`RateLimits.PASSWORD_CHANGE`, a fixed 10/min):
 * mounted on the route node, so it answers before the lock preflight and the bcrypt verify, keyed by the CALLER.
 */
class PasswordChangeBucketTest {

    private fun path(id: UInt) = "/api/v1/users/$id/password"

    /** A refused new password: 400 before any bcrypt, and it touches no wrong-password counter, so only the bucket can answer 429. */
    private suspend fun HttpClient.refused(id: UInt) =
        putJson(path(id), PasswordUpdateRequest(password = "short", currentPassword = "old-password"))

    private suspend fun HttpClient.correct(id: UInt) =
        putJson(path(id), PasswordUpdateRequest(password = "brand-new-password", currentPassword = "old-password"))

    @Test
    fun `the eleventh request in a minute is 429 even with the correct current password - the bucket answers first`() =
        testApplication {
            usePostgresTestcontainer()
            val email = uniqueEmail("pwbucket")
            val userId = TestUsers.seed(email = email, password = "old-password", role = UserRole.USER)
            val client = authedClient(email, "old-password")

            withAuditCapture { audit ->
                repeat(10) { assertEquals(HttpStatusCode.BadRequest, client.refused(userId).status) }

                // The right password and a valid new one: were bcrypt reached it would be a 204. The bucket answers first.
                val saturated = client.correct(userId)
                assertEquals(HttpStatusCode.TooManyRequests, saturated.status)
                assertNotNull(saturated.headers[HttpHeaders.RetryAfter], "a bucket 429 carries Retry-After")
                assertTrue(saturated.bodyAsText().contains("about:blank"), "the bucket's 429 is not the lock's typed problem")

                assertEquals(
                    HttpStatusCode.OK,
                    jsonClient().postJson("/api/v1/login", LoginRequest(email, "old-password")).status,
                    "the password was not changed",
                )
                assertTrue(
                    audit.events.none { it.message == "password.changed" && it.hasKeyValue("targetUserId", userId.toLong()) },
                    "no change was written",
                )
                val exceeded = audit.events.filter {
                    it.message == "rate_limit.exceeded" && it.hasKeyValue("bucket", "password-change") &&
                        it.hasKeyValue("byUserId", userId.toLong())
                }
                assertEquals(1, exceeded.size, "the rejection is audited once, per user")
            }
        }

    @Test
    fun `two users have independent buckets`() = testApplication {
        usePostgresTestcontainer()
        val emailA = uniqueEmail("pwbucket-a")
        val emailB = uniqueEmail("pwbucket-b")
        val idA = TestUsers.seed(email = emailA, password = "old-password", role = UserRole.USER)
        val idB = TestUsers.seed(email = emailB, password = "old-password", role = UserRole.USER)
        val a = authedClient(emailA, "old-password")
        val b = authedClient(emailB, "old-password")

        repeat(10) { assertEquals(HttpStatusCode.BadRequest, a.refused(idA).status) }
        assertEquals(HttpStatusCode.TooManyRequests, a.correct(idA).status)

        assertEquals(HttpStatusCode.NoContent, b.correct(idB).status, "B's bucket is untouched by A's burst")
    }

    @Test
    fun `an admin reset is keyed by the caller - the target exhausting their own bucket does not starve it`() = testApplication {
        usePostgresTestcontainer()
        val adminEmail = uniqueEmail("pwbucket-admin")
        val victimEmail = uniqueEmail("pwbucket-victim")
        TestUsers.seed(email = adminEmail, password = "admin-password", role = UserRole.ADMIN)
        val victimId = TestUsers.seed(email = victimEmail, password = "old-password", role = UserRole.USER)
        val admin = authedClient(adminEmail, "admin-password")
        val victim = authedClient(victimEmail, "old-password")

        repeat(10) { assertEquals(HttpStatusCode.BadRequest, victim.refused(victimId).status) }
        assertEquals(HttpStatusCode.TooManyRequests, victim.correct(victimId).status)

        val reset = admin.putJson(path(victimId), PasswordUpdateRequest(password = "admin-chosen-password"))
        assertEquals(HttpStatusCode.NoContent, reset.status, "the admin's own bucket is full of tokens")
    }

    @Test
    fun `the bucket precedes the guard - ten refused PUTs at someone else's id, then the eleventh is 429 not 403`() = testApplication {
        usePostgresTestcontainer()
        val email = uniqueEmail("pwbucket-guard")
        TestUsers.seed(email = email, password = "old-password", role = UserRole.USER)
        val otherId = TestUsers.seed(email = uniqueEmail("pwbucket-other"), password = "old-password", role = UserRole.USER)
        val client = authedClient(email, "old-password")

        repeat(10) { assertEquals(HttpStatusCode.Forbidden, client.correct(otherId).status) }
        assertEquals(HttpStatusCode.TooManyRequests, client.correct(otherId).status, "the route node runs before the guard")
    }
}
