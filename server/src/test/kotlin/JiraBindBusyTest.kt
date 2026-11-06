package ch.nokillswit

import ch.nokillswit.jira.JiraLevel
import com.github.tomakehurst.wiremock.client.WireMock.aResponse
import com.github.tomakehurst.wiremock.client.WireMock.get
import com.github.tomakehurst.wiremock.client.WireMock.urlPathEqualTo
import io.ktor.client.request.post
import io.ktor.http.HttpStatusCode
import io.ktor.server.testing.testApplication
import kotlinx.coroutines.async
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.delay
import org.junit.AfterClass
import org.junit.BeforeClass
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

/**
 * The route-level half of `PermitContentionTest` (1.1.0 F1): with ONE outbound permit held by a slow Test connection, a bind answers the
 * `502` upstream problem carrying the code `BUSY` after `jira.bindPermitWaitMillis` instead of queueing behind it. Without the route's
 * `PermitWait` the bind would wait for the permit and succeed (or time out) - this test fails then.
 */
class JiraBindBusyTest {
    companion object {
        @JvmStatic
        @BeforeClass
        fun warmStub() {
            JiraStubFixture.warm()
        }

        @JvmStatic
        @AfterClass
        fun leaveStubAsFound() {
            JiraStubServer.resetScenarios()
        }
    }

    @Test
    fun `a bind queued behind a held outbound permit answers 502 BUSY after its short wait`() = testApplication {
        configureApp(
            "jira.stubBaseUrl" to JiraStubFixture.warm(), "jira.maxRetries" to "0",
            "jira.maxConcurrentRequests" to "1", "jira.bindPermitWaitMillis" to "300",
        )
        startApplication()
        val w = planWorld("jrbusy", teams = true)
        val admin = w.admin.client
        val connectionId = admin.jbConnection().id
        val milestone = TestPlan.milestone(w.projectId, w.requireTeams().teamId, planName("ms"))

        // The Test connection's first call (tenant_info) takes the single permit and holds it for 4 s.
        val slow = JiraStubServer.addOverride(
            get(urlPathEqualTo("/_edge/tenant_info")).atPriority(1)
                .willReturn(aResponse().withStatus(200).withBody("{}").withFixedDelay(4_000)),
        )
        try {
            coroutineScope {
                val held = async { admin.post("$JB_CONNECTIONS/$connectionId/test").status }
                delay(1_000) // the Test connection is on the wire with the permit; a slow CI runner still has 3 s of hold left
                val began = System.nanoTime()
                val refused = admin.jbBind(connectionId, JiraLevel.MILESTONE, milestone, "E2E-5")
                val waitedMillis = (System.nanoTime() - began) / 1_000_000
                assertEquals(HttpStatusCode.BadGateway, refused.status)
                val problem = refused.jbProblem()
                assertEquals("urn:astrolabe:problem:jira-upstream", problem.type)
                assertTrue("(BUSY)" in problem.detail.orEmpty(), problem.detail)
                assertTrue(waitedMillis < 2_000, "it gave up after its own short wait, not the holder's (waited $waitedMillis ms)")
                assertEquals(0, jbScalar("SELECT count(*) FROM jira_bindings WHERE milestone_id = ?", milestone.toInt()) { it.getInt(1) })
                held.await()
            }
        } finally {
            JiraStubServer.removeOverride(slow)
        }
        // Once the permit is free again the same bind goes through.
        admin.jbBind(connectionId, JiraLevel.MILESTONE, milestone, "E2E-5").jbBinding()
    }
}
