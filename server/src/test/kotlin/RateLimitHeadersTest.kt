package ch.nokillswit

import ch.nokillswit.plugins.perIpBuckets
import ch.nokillswit.plugins.perUserBuckets
import ch.nokillswit.plugins.retryAfterSeconds
import ch.nokillswit.sync.SyncKind
import ch.nokillswit.sync.SyncRunRequest
import ch.nokillswit.users.UserRole
import io.ktor.client.HttpClient
import io.ktor.client.request.get
import io.ktor.client.request.post
import io.ktor.client.statement.HttpResponse
import io.ktor.http.HttpHeaders
import io.ktor.http.HttpStatusCode
import io.ktor.server.auth.authenticate
import io.ktor.server.plugins.ratelimit.RateLimitName
import io.ktor.server.plugins.ratelimit.rateLimit
import io.ktor.server.response.respondText
import io.ktor.server.routing.get
import io.ktor.server.routing.routing
import io.ktor.server.testing.testApplication
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNotEquals
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * Ktor's RateLimit plugin adds `X-RateLimit-Limit/-Remaining/-Reset` to every ADMITTED answer on a bucketed route unless the
 * provider's `modifyResponse` says otherwise; the API guidelines (API-RATE-001) and the spec declare no budget headers, and a
 * `Retry-After` on the 429 is the one rate header the API speaks. `RateLimits.kt` strips them for every provider, once, in the loop
 * that registers the buckets: the first test walks the REGISTERED buckets (`perIpBuckets`, `perUserBuckets`), so a new bucket is
 * covered without touching it; the second rides a few real routes of different bucket shapes.
 */
class RateLimitHeadersTest {

    private fun HttpResponse.budgetHeaders() =
        headers.names().filter { it.startsWith("X-RateLimit", ignoreCase = true) || it.startsWith("RateLimit", ignoreCase = true) }

    private fun HttpResponse.assertNoBudget(what: String) =
        assertEquals(emptyList(), budgetHeaders(), "$what must carry no RateLimit headers")

    /** Rides [path] until the bucket refuses (never more than [limit] + 1 calls): every admitted answer, then the 429, is checked. */
    private suspend fun HttpClient.probe(path: String, limit: Int, what: String) {
        var admitted = 0
        var refused: HttpResponse? = null
        while (refused == null && admitted <= limit) {
            val answer = get(path)
            if (answer.status == HttpStatusCode.TooManyRequests) {
                refused = answer
            } else {
                assertEquals(HttpStatusCode.OK, answer.status, "$what admitted request ${admitted + 1}")
                answer.assertNoBudget("$what admitted answer ${admitted + 1}")
                admitted++
            }
        }
        assertNotNull(refused, "$what is refused within ${limit + 1} calls")
        assertTrue(admitted > 0, "$what admits at least one call")
        val retryAfter = refused.headers.getAll(HttpHeaders.RetryAfter).orEmpty()
        assertEquals(1, retryAfter.size, "$what 429 carries exactly one Retry-After")
        assertTrue(retryAfter.single().toLong() in 1..60, "$what Retry-After ${retryAfter.single()} is 1..60")
        refused.assertNoBudget("$what 429")
    }

    @Test
    fun `every registered bucket admits without RateLimit headers and refuses with Retry-After only`() = testApplication {
        configureApp()
        application {
            routing {
                perIpBuckets().keys.forEach { name ->
                    rateLimit(RateLimitName(name)) { get("/zz-ratelimit/ip/$name") { call.respondText("ok") } }
                }
                authenticate {
                    perUserBuckets().keys.forEach { name ->
                        rateLimit(RateLimitName(name)) { get("/zz-ratelimit/user/$name") { call.respondText("ok") } }
                    }
                }
            }
        }
        startApplication()
        val ip = createClient { }
        val user = seededClient("rlheaders", UserRole.ADMIN)
        application.perIpBuckets().forEach { (name, limit) -> ip.probe("/zz-ratelimit/ip/$name", limit, "per-IP bucket $name") }
        application.perUserBuckets().forEach { (name, limit) -> user.probe("/zz-ratelimit/user/$name", limit, "per-user bucket $name") }
    }

    @Test
    fun `real routes on the login, jira-test, sync-run, import and ready buckets admit without RateLimit headers`() = testApplication {
        configureApp()
        startApplication()
        val anonymous = jsonClient()
        val admin = seededClient("rlheaders-real", UserRole.ADMIN)

        val login = anonymous.login(uniqueEmail("rlheaders"), "whatever")
        assertEquals(HttpStatusCode.Unauthorized, login.status)
        login.assertNoBudget("an admitted login")

        val jiraTest = admin.post("$JB_CONNECTIONS/999999/test")
        assertNotEquals(HttpStatusCode.TooManyRequests, jiraTest.status)
        jiraTest.assertNoBudget("an admitted Jira test")

        val syncRun = admin.postJson(SYNC_RUNS, SyncRunRequest(SyncKind.JIRA, 999_999u))
        assertEquals(HttpStatusCode.BadRequest, syncRun.status)
        syncRun.assertNoBudget("an admitted sync-run press")

        val importPreview = admin.post("$JB_CONNECTIONS/999999/import-preview")
        assertNotEquals(HttpStatusCode.TooManyRequests, importPreview.status)
        importPreview.assertNoBudget("an admitted import preview")

        val ready = anonymous.get("/api/v1/ready")
        assertNotEquals(HttpStatusCode.TooManyRequests, ready.status)
        ready.assertNoBudget("an admitted ready probe")
        assertNull(ready.headers[HttpHeaders.RetryAfter])
    }

    @Test
    fun `Retry-After rounds the wait up to whole seconds and never says 0`() {
        assertEquals(1, retryAfterSeconds(1))
        assertEquals(1, retryAfterSeconds(1_000))
        assertEquals(2, retryAfterSeconds(1_001))
        assertEquals(60, retryAfterSeconds(59_001))
        assertEquals(60, retryAfterSeconds(60_000))
    }
}
