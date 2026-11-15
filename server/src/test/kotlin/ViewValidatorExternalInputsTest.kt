package ch.nokillswit

import ch.nokillswit.jira.JiraLevel
import io.ktor.client.HttpClient
import io.ktor.http.HttpHeaders
import io.ktor.http.HttpStatusCode
import io.ktor.server.testing.testApplication
import org.junit.After
import kotlin.test.AfterTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNotEquals
import kotlin.test.assertNotNull

/**
 * `ViewValidatorInputsTest`'s Jira and Flow cases (1.22): an acknowledgement is not plan state, yet it silences a flag on the plan
 * views, so the tag of those views must move with it. Both on the fixtures of the flag-source tests (a Jira connection made through the
 * API with raw bindings and observations; a scripted Flow mirror): no stub is started.
 */
class ViewValidatorExternalInputsTest {
    private val connections = ConnectionLedger()
    private val mirrors = mutableListOf<ScriptedFlowMirror>()

    @After
    fun dropConnections() = connections.drop()

    @AfterTest
    fun cleanUpMirrors() {
        mirrors.forEach { it.cleanUp() }
        mirrors.clear()
        removeFlowFixtureRows(CAPACK_PREFIX)
    }

    private suspend fun HttpClient.moved(url: String, before: String) {
        val response = conditional(url, before)
        assertEquals(HttpStatusCode.OK, response.status, "$url: the old tag no longer matches")
        val tag = assertNotNull(response.headers[HttpHeaders.ETag], url)
        assertNotEquals(before, tag, "$url: a new document, a new tag")
        assertNotModified(url, tag, "$url: the new tag matches")
    }

    @Test
    fun `a Jira acknowledgement that silences a flag moves the project, team and roadmap views`() = testApplication {
        usePostgresTestcontainer()
        val w = planWorld("vijr", teams = true)
        val team = w.requireTeams().teamId
        val connection = connections.track(w.admin.client.dvConnection())
        val name = planName("ms")
        val milestone = TestPlan.milestone(w.projectId, team, name)
        TestPlan.schedule(milestone, "2044-02-07", "2044-02-11")
        val (issueId, key) = nextIssue()
        // The summary differs from the milestone's name: a RENAMED line (INFO) that flags the milestone until it is acknowledged.
        val observation = DvObs("Another name", 1, start = "2044-02-07", end = "2044-02-11")
        val binding = dvBind(connection, JiraLevel.MILESTONE, milestone, issueId, key, observation)
        val views = listOf("/api/v1/views/project/${w.projectId}", "/api/v1/views/team/$team", "/api/v1/views/roadmap")
        val client = w.stranger.client
        val before = views.associateWith { client.assertRevalidates(it) }
        val revision = TestPlan.revision()
        w.admin.client.ack(binding, w.admin.client.ackItem(connection, binding).fingerprint).acknowledgement()
        assertEquals(revision, TestPlan.revision(), "an acknowledgement is not plan state")
        before.forEach { (url, tag) -> client.moved(url, tag) }
    }

    @Test
    fun `a Flow capacity acknowledgement that silences a flag moves the team view`() = testApplication {
        val world = capAckWorld("vifw", mirrors)
        world.refresh()
        val milestone = TestPlan.milestone(world.w.projectId, world.teamId, planName("vifw"), 5.0)
        TestPlan.schedule(milestone, "2049-03-08", "2049-04-09")
        val url = "/api/v1/views/team/${world.teamId}"
        with(world) {
            val before = w.stranger.client.assertRevalidates(url)
            val revision = TestPlan.revision()
            manager.client.capAck(bindingId, 2, w.admin.client.rowOf(2).fingerprint).capAcknowledgement()
            assertEquals(revision, TestPlan.revision(), "an acknowledgement is not plan state")
            w.stranger.client.moved(url, before)
        }
    }
}
