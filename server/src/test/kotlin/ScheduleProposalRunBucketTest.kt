package ch.nokillswit

import ch.nokillswit.planning.CrossTeamAcceptRequest
import ch.nokillswit.planning.CrossTeamProposalRequest
import ch.nokillswit.planning.ScheduleCheckRequest
import ch.nokillswit.planning.TeamScheduleBatchItem
import ch.nokillswit.users.UserRole
import io.ktor.client.HttpClient
import io.ktor.client.statement.HttpResponse
import io.ktor.client.statement.bodyAsText
import io.ktor.http.ContentType
import io.ktor.http.HttpHeaders
import io.ktor.http.HttpStatusCode
import io.ktor.server.testing.testApplication
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNotNull
import kotlin.test.assertTrue

/**
 * The per-USER `schedule-proposal-run` token bucket (`RateLimits.SCHEDULE_PROPOSAL_RUN`, a fixed 30/min) on `POST /schedule-proposals`
 * and `POST /schedule-proposals/accept`: ONE bucket for the two kernel-running POSTs, mounted on the route nodes so it answers before
 * the body and the guard, keyed by the CALLER. The check rides none. Every call names a team no row has: a cheap `404` that still
 * spends a token and runs nothing, so only the bucket can answer `429`.
 */
class ScheduleProposalRunBucketTest {
    private val runPath = "/api/v1/schedule-proposals"
    private val acceptPath = "/api/v1/schedule-proposals/accept"
    private val checkPath = "/api/v1/schedule-proposals/check"
    private val missingTeam = listOf(2_000_000_000u)

    private suspend fun HttpClient.run(): HttpResponse = postJson(runPath, CrossTeamProposalRequest("2027-01-31", missingTeam))

    private suspend fun HttpClient.accept(): HttpResponse = postJson(
        acceptPath,
        CrossTeamAcceptRequest(0, "0".repeat(64), missingTeam, listOf(TeamScheduleBatchItem(1u, "2027-02-01", "2027-02-02"))),
    )

    private suspend fun HttpClient.check(): HttpResponse =
        postJson(checkPath, ScheduleCheckRequest(missingTeam, listOf(TeamScheduleBatchItem(1u, "2027-02-01", "2027-02-02"))))

    @Test
    fun `the thirty-first run in a minute is 429 with Retry-After - the check is never throttled`() = testApplication {
        usePostgresTestcontainer()
        val user = seededClient("runbucket", UserRole.USER)

        repeat(30) { assertEquals(HttpStatusCode.NotFound, user.run().status, "run ${it + 1} reaches the team check") }
        val saturated = user.run()
        assertEquals(HttpStatusCode.TooManyRequests, saturated.status)
        val retryAfter = assertNotNull(saturated.headers[HttpHeaders.RetryAfter], "a bucket 429 carries Retry-After").toIntOrNull()
        assertTrue(retryAfter in 1..60, "Retry-After is whole seconds within the 60-second window, was $retryAfter")
        assertTrue(
            saturated.headers[HttpHeaders.ContentType].orEmpty().startsWith(ContentType.Application.ProblemJson.toString()),
            "the 429 is an RFC 7807 body",
        )
        assertTrue(saturated.bodyAsText().contains("about:blank"), "the bucket's 429 is the generic problem")

        repeat(35) { assertEquals(HttpStatusCode.NotFound, user.check().status, "the check rides no bucket (call ${it + 1})") }
    }

    @Test
    fun `the run and the accept share ONE bucket`() = testApplication {
        usePostgresTestcontainer()
        val user = seededClient("runbucket-shared", UserRole.USER)

        repeat(15) { assertEquals(HttpStatusCode.NotFound, user.run().status) }
        repeat(15) { assertEquals(HttpStatusCode.NotFound, user.accept().status) }

        assertEquals(HttpStatusCode.TooManyRequests, user.run().status, "fifteen of each spent all thirty")
        assertEquals(HttpStatusCode.TooManyRequests, user.accept().status)
    }

    @Test
    fun `the bucket precedes the body - a malformed body spends a token too`() = testApplication {
        usePostgresTestcontainer()
        val user = seededClient("runbucket-body", UserRole.USER)

        repeat(30) { assertEquals(HttpStatusCode.BadRequest, user.postJson(runPath, "{ not json").status) }
        assertEquals(HttpStatusCode.TooManyRequests, user.run().status, "the route node runs before the body is read")
    }

    @Test
    fun `a second user has a bucket of their own`() = testApplication {
        usePostgresTestcontainer()
        val a = seededClient("runbucket-a", UserRole.USER)
        val b = seededClient("runbucket-b", UserRole.USER)

        repeat(30) { assertEquals(HttpStatusCode.NotFound, a.run().status) }
        assertEquals(HttpStatusCode.TooManyRequests, a.run().status)

        assertEquals(HttpStatusCode.NotFound, b.run().status, "B's bucket is untouched by A's burst")
        assertEquals(HttpStatusCode.NotFound, b.accept().status)
    }
}
