package ch.nokillswit

import ch.nokillswit.jira.JiraImportDefaults
import ch.nokillswit.jira.JiraImportOverrides
import ch.nokillswit.jira.JiraLevel
import com.github.tomakehurst.wiremock.client.MappingBuilder
import com.github.tomakehurst.wiremock.client.WireMock.aResponse
import com.github.tomakehurst.wiremock.client.WireMock.get
import com.github.tomakehurst.wiremock.client.WireMock.urlPathMatching
import io.ktor.client.request.delete
import io.ktor.client.statement.bodyAsText
import io.ktor.http.HttpStatusCode
import io.ktor.server.testing.testApplication
import org.junit.BeforeClass
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

/**
 * The refusals of `POST …/connections/{id}/import`: every status the spec declares, in the preview's order, and the guards that run
 * under the lock. Each refused apply writes nothing and leaves the plan revision alone. One caller makes at most five calls.
 */
class JiraImportApplyErrorsTest {
    private fun search(): MappingBuilder = get(urlPathMatching(".*/rest/api/3/search/jql")).atPriority(1)

    private inline fun <T> withOverride(stub: MappingBuilder, block: () -> T): T {
        val registered = JiraStubServer.addOverride(stub)
        try {
            return block()
        } finally {
            JiraStubServer.removeOverride(registered)
        }
    }

    private val one = listOf(createTick("95002", JiraLevel.PROJECT, "95001"))

    @Test
    fun `an unknown or deleted connection, work stream or default is a 404 before any guard`() = testApplication {
        val f = importFixture("jiae404")
        val admin = f.w.admin.client
        val revision = TestPlan.revision()
        assertEquals(HttpStatusCode.NotFound, admin.applyImport(999_999u, f.scope(), one).status)
        val gone = admin.jbConnection(jbRequest(keys = listOf("IMP")))
        assertEquals(HttpStatusCode.NoContent, admin.delete("$JB_CONNECTIONS/${gone.id}").status)
        assertEquals(HttpStatusCode.NotFound, admin.applyImport(gone.id, f.scope(), one).status)
        assertEquals(HttpStatusCode.NotFound, admin.applyImport(f.connectionId, f.scope().copy(workStreamId = 999_999u), one).status)
        val program = f.scope(JiraImportDefaults(programId = 999_999u))
        assertEquals(HttpStatusCode.NotFound, admin.applyImport(f.connectionId, program, one).status)
        assertEquals(revision, TestPlan.revision())
    }

    @Test
    fun `a default under another's program is a 403, and so is a ticked target the caller does not own`() = testApplication {
        val f = importFixture("jiae403")
        val caller = f.w.projectOwner
        val otherProgram = TestPlan.program(f.w.streamId, f.w.stranger.personId!!)
        val otherProject = TestPlan.project(otherProgram, f.w.stranger.personId)
        f.bindImpProgram()
        val revision = TestPlan.revision()
        // The named default is read and guarded before the browse.
        val named = f.scope(JiraImportDefaults(projectId = otherProject, teamId = f.defaultTeam))
        assertEquals(HttpStatusCode.Forbidden, caller.client.applyImport(f.connectionId, named, one).status)
        assertEquals(revision, TestPlan.revision())
        // A ticked CREATE of IMP-2 lands under the world's program, which this project owner does not own: refused under the lock.
        val under = caller.client.applyImport(f.connectionId, f.scope(), one)
        assertEquals(HttpStatusCode.Forbidden, under.status)
        assertTrue("program" in under.jbProblem().detail.orEmpty(), under.bodyAsText())
        assertEquals(revision, TestPlan.revision(), "nothing was written, no bump")
        assertEquals(1, activeBindingCount(f.connectionId), "only the world's program binding")
    }

    @Test
    fun `an untested connection is a 409 and an upstream failure a 502 with the code only`() = testApplication {
        val f = importFixture("jiae409")
        val admin = f.w.admin.client
        val untested = jbConnection(f)
        val revision = TestPlan.revision()
        val notDiscovered = admin.applyImport(untested, f.scope(), one)
        assertEquals(HttpStatusCode.Conflict, notDiscovered.status)
        assertEquals("urn:astrolabe:problem:jira-not-discovered", notDiscovered.jbProblem().type)
        withOverride(search().willReturn(aResponse().withStatus(503))) {
            val outage = admin.applyImport(f.connectionId, f.scope(), one)
            assertEquals(HttpStatusCode.BadGateway, outage.status)
            val body = outage.bodyAsText()
            assertTrue("UPSTREAM_UNAVAILABLE" in body && f.token !in body)
        }
        assertEquals(revision, TestPlan.revision())
    }

    private suspend fun jbConnection(f: ImportFixture): UInt {
        val created = f.w.admin.client.postJson(JB_CONNECTIONS, jbRequest(keys = listOf("IMP")))
        assertEquals(HttpStatusCode.Created, created.status)
        return jbJson.decodeFromString<ch.nokillswit.jira.JiraConnectionResponse>(created.bodyAsText()).id
    }

    @Test
    fun `the items must be sound and every team active - a 400 before the browse - and a truncated scope is a 400 with nothing written`() =
        testApplication {
            val f = importFixture("jiae400")
            val admin = f.w.admin.client
            val revision = TestPlan.revision()
            val deletedTeam = TestTeams.seed(planName("jiae400-team"))
            jbSql("UPDATE teams SET marked_as_deleted = TRUE WHERE id = ?", deletedTeam.toInt())
            val override = one.map { it.copy(overrides = JiraImportOverrides(deletedTeam)) }
            assertEquals(HttpStatusCode.BadRequest, admin.applyImport(f.connectionId, f.scope(), override).status)
            assertEquals(HttpStatusCode.BadRequest, admin.applyImport(f.connectionId, f.scope(), emptyList()).status)
            assertEquals(HttpStatusCode.BadRequest, admin.applyImport(f.connectionId, f.scope(), one + one).status)
            val skip = one.map { it.copy(expected = it.expected.copy(action = ch.nokillswit.jira.JiraImportAction.SKIP)) }
            assertEquals(HttpStatusCode.BadRequest, admin.applyImport(f.connectionId, f.scope(), skip).status)

            val padding = "x".repeat(80)
            val docs = (1..2_001).map {
                val type = """{"id":"10004","name":"Epic","hierarchyLevel":1}"""
                """{"id":"${100_000 + it}","key":"IMP-$it","fields":{"summary":"$padding $it","issuetype":$type}}"""
            }
            withOverride(search().willReturn(aResponse().withStatus(200).withBody(searchPage(*docs.toTypedArray())))) {
                val scope = f.scope(JiraImportDefaults(projectId = f.w.projectId, teamId = f.defaultTeam))
                val truncated = freshAdmin().applyImport(f.connectionId, scope, listOf(createTick("100001", JiraLevel.MILESTONE)))
                assertEquals(HttpStatusCode.BadRequest, truncated.status)
                assertTrue("narrow projectKeys" in truncated.jbProblem().detail.orEmpty())
            }
            assertEquals(revision, TestPlan.revision())
            assertEquals(0, activeBindingCount(f.connectionId))
        }

    companion object {
        @JvmStatic
        @BeforeClass
        fun warmStub() {
            JiraStubFixture.warm()
        }
    }
}
