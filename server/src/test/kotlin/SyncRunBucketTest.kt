package ch.nokillswit

import ch.nokillswit.sync.SyncKind
import ch.nokillswit.sync.SyncRunList
import ch.nokillswit.sync.SyncRunRequest
import ch.nokillswit.users.UserRole
import io.ktor.client.HttpClient
import io.ktor.client.request.get
import io.ktor.client.statement.bodyAsText
import io.ktor.http.ContentType
import io.ktor.http.HttpHeaders
import io.ktor.http.HttpStatusCode
import io.ktor.server.testing.testApplication
import org.junit.BeforeClass
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNotNull
import kotlin.test.assertTrue

/**
 * The per-USER `sync-run` token bucket on `POST /integrations/sync/runs` (`RateLimits.SYNC_RUN`, a fixed 10/min, ONE bucket for both
 * kinds): mounted on the route node, so it answers before the guard and the body, keyed by the CALLER; the list GET rides none. Most
 * presses name a connection that does not exist (a cheap `400` that still spends a token and starts nothing); the first test makes its
 * eleventh press at a REAL connection (the Jira stub), so "nothing was claimed or audited" is a claim the bucket, not the 400, earns.
 */
class SyncRunBucketTest {

    /** A connection id no row has: the press is a `400` after the guard, never a claim, so only the bucket can answer `429`. */
    private suspend fun HttpClient.press(kind: SyncKind = SyncKind.JIRA) =
        postJson(SYNC_RUNS, SyncRunRequest(kind, UNKNOWN_CONNECTION))

    @Test
    fun `the eleventh press in a minute is 429 with Retry-After and starts nothing - the list is never throttled`() = testApplication {
        configureApp("jira.stubBaseUrl" to JiraStubFixture.warm(), "jira.maxRetries" to "0")
        startApplication()
        val email = uniqueEmail("syncbucket")
        val userId = TestUsers.seed(email = email, password = "pw", role = UserRole.ADMIN)
        val admin = authedClient(email, "pw")
        // A REAL runnable connection: were the bucket not first, the eleventh press would claim a run and audit it.
        val connectionId = admin.jbConnection(jbRequest()).id

        withAuditCapture { audit ->
            repeat(10) { assertEquals(HttpStatusCode.BadRequest, admin.press().status, "press ${it + 1} reaches the connection check") }

            val saturated = admin.postJson(SYNC_RUNS, SyncRunRequest(SyncKind.JIRA, connectionId))
            assertEquals(HttpStatusCode.TooManyRequests, saturated.status)
            val retryAfter = assertNotNull(saturated.headers[HttpHeaders.RetryAfter], "a bucket 429 carries Retry-After").toIntOrNull()
            assertTrue(retryAfter in 1..60, "Retry-After is whole seconds within the 60-second window, was $retryAfter")
            assertTrue(
                saturated.headers[HttpHeaders.ContentType].orEmpty().startsWith(ContentType.Application.ProblemJson.toString()),
                "the 429 is an RFC 7807 body",
            )
            assertTrue(saturated.bodyAsText().contains("about:blank"), "the bucket's 429 is the generic problem")

            repeat(15) { assertEquals(HttpStatusCode.OK, admin.get(SYNC_RUNS).status, "the list GET rides no bucket") }
            val runs = jbJson.decodeFromString<SyncRunList>(admin.get("$SYNC_RUNS?kind=JIRA&connectionId=$connectionId").bodyAsText())
            assertTrue(runs.items.isEmpty(), "the throttled press claimed no run")

            val exceeded = audit.events.filter { it.message == "rate_limit.exceeded" && it.hasKeyValue("bucket", "sync-run") }
            assertEquals(1, exceeded.size, "the rejection is audited once")
            assertTrue(exceeded.single().hasKeyValue("byUserId", userId.toLong()), "and names the user")
            assertTrue(audit.events.none { it.message == "jira.sync_requested" }, "a throttled press requests nothing")
        }
    }

    @Test
    fun `Jira and Flow presses share the one bucket`() = testApplication {
        usePostgresTestcontainer()
        val admin = seededClient("syncbucket-kinds", UserRole.ADMIN)

        repeat(5) { assertEquals(HttpStatusCode.BadRequest, admin.press(SyncKind.JIRA).status) }
        repeat(5) { assertEquals(HttpStatusCode.BadRequest, admin.press(SyncKind.FLOW).status) }

        assertEquals(HttpStatusCode.TooManyRequests, admin.press(SyncKind.FLOW).status, "five of each spent all ten")
        assertEquals(HttpStatusCode.TooManyRequests, admin.press(SyncKind.JIRA).status)
    }

    @Test
    fun `a second administrator has a bucket of their own`() = testApplication {
        usePostgresTestcontainer()
        val a = seededClient("syncbucket-a", UserRole.ADMIN)
        val b = seededClient("syncbucket-b", UserRole.ADMIN)

        repeat(10) { assertEquals(HttpStatusCode.BadRequest, a.press().status) }
        assertEquals(HttpStatusCode.TooManyRequests, a.press().status)

        assertEquals(HttpStatusCode.BadRequest, b.press().status, "B's bucket is untouched by A's burst (B reaches the connection check)")
    }

    @Test
    fun `the bucket precedes the guard - ten 403s of a non-admin, then the eleventh is 429 not 403`() = testApplication {
        usePostgresTestcontainer()
        val user = seededClient("syncbucket-user", UserRole.USER)

        repeat(10) { assertEquals(HttpStatusCode.Forbidden, user.press().status) }
        assertEquals(HttpStatusCode.TooManyRequests, user.press().status, "the route node runs before the guard")
    }

    companion object {
        const val UNKNOWN_CONNECTION = 2_000_000_000u

        @JvmStatic
        @BeforeClass
        fun warmStub() {
            JiraStubFixture.warm()
        }
    }
}
