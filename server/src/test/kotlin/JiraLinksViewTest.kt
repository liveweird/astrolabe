package ch.nokillswit

import ch.nokillswit.jira.DeviationViewService
import ch.nokillswit.jira.JiraLevel
import ch.nokillswit.jira.JiraLinksView
import ch.nokillswit.jira.JiraNodeLink
import ch.nokillswit.sync.SyncRunService
import io.ktor.client.call.body
import io.ktor.client.request.get
import io.ktor.client.statement.bodyAsText
import io.ktor.http.HttpStatusCode
import io.ktor.server.testing.testApplication
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import org.jetbrains.exposed.v1.r2dbc.transactions.suspendTransaction
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * `GET /views/jira-links` (1.15): the narrow links read. Every assertion is on this test's OWN node and connection ids (the shared
 * container holds other suites' links); observations are raw INSERTs and no test touches the Jira stub.
 */
class JiraLinksViewTest {
    private val path = "/api/v1/views/jira-links"

    private fun JiraLinksView.link(level: JiraLevel, nodeId: UInt): JiraNodeLink? =
        links.singleOrNull { it.level == level && it.nodeId == nodeId }

    private fun JiraLinksView.connection(id: UInt) = connections.singleOrNull { it.id == id }

    @Test
    fun `any login reads it and the JSON carries exactly the documented members`() = testApplication {
        usePostgresTestcontainer()
        val w = planWorld("jlk", teams = true)
        val c = w.admin.client.dvConnection()
        val bindingId = dvBind(c, JiraLevel.PROJECT, w.projectId, "9101", "ABC-9101", DvObs("p"))
        for (caller in listOf(w.stranger, w.personless, w.admin)) {
            val response = caller.client.get(path)
            assertEquals(HttpStatusCode.OK, response.status)
            val root = Json.parseToJsonElement(response.bodyAsText()).jsonObject
            assertEquals(setOf("connections", "links", "truncated"), root.keys, "no revision, no can")
            val link = root.getValue("links").jsonArray.map { it as JsonObject }
                .single { it.getValue("nodeId").toString() == w.projectId.toString() && it.getValue("level").toString() == "\"PROJECT\"" }
            assertEquals(setOf("level", "nodeId", "bindingId", "connectionId", "issueKey", "gone"), link.keys)
            assertEquals(bindingId.toString(), link.getValue("bindingId").toString())
            val connection = root.getValue("connections").jsonArray.map { it as JsonObject }
                .single { it.getValue("id").toString() == c.toString() }
            assertEquals(setOf("id", "name", "siteUrl", "enabled", "projectKeys", "mappingOk"), connection.keys)
        }
    }

    @Test
    fun `programs and projects are listed, programs first and each by node id, a milestone link never`() = testApplication {
        usePostgresTestcontainer()
        val w = planWorld("jlo", teams = true)
        val c = w.admin.client.dvConnection()
        val program2 = TestPlan.program(w.streamId, w.programOwner.personId!!)
        val project2 = TestPlan.project(w.programId, w.projectOwner.personId!!)
        val milestone = TestPlan.milestone(w.projectId, w.requireTeams().teamId)
        dvBind(c, JiraLevel.PROJECT, project2, "9202", "ABC-9202", DvObs("p2"))
        dvBind(c, JiraLevel.PROGRAM, program2, "9203", "ABC-9203", DvObs("g2"))
        dvBind(c, JiraLevel.PROJECT, w.projectId, "9204", "ABC-9204", DvObs("p1"))
        dvBind(c, JiraLevel.PROGRAM, w.programId, "9205", "ABC-9205", DvObs("g1"))
        dvBind(c, JiraLevel.MILESTONE, milestone, "9206", "ABC-9206", DvObs("m"))
        val view = w.stranger.client.get(path).body<JiraLinksView>()
        val mine = view.links.filter { it.connectionId == c }
        val programs = listOf(w.programId, program2).sorted().map { JiraLevel.PROGRAM to it }
        val projects = listOf(w.projectId, project2).sorted().map { JiraLevel.PROJECT to it }
        assertEquals(programs + projects, mine.map { it.level to it.nodeId })
        assertEquals(listOf("ABC-9205", "ABC-9203").sorted(), mine.filter { it.level == JiraLevel.PROGRAM }.map { it.issueKey }.sorted())
        assertTrue(mine.none { it.nodeId == milestone && it.issueKey == "ABC-9206" }, "a milestone link is not listed")
        assertEquals(4, mine.size)
    }

    @Test
    fun `a binding of a deleted node, of a node under a deleted ancestor and of a deleted connection is hidden`() = testApplication {
        usePostgresTestcontainer()
        val w = planWorld("jlh", teams = true)
        val c = w.admin.client.dvConnection()
        val gone = w.admin.client.dvConnection()
        val unbound = TestPlan.project(w.programId, w.projectOwner.personId!!)
        val deadProgram2 = TestPlan.program(w.streamId, w.programOwner.personId!!)
        val underDeadProgram = TestPlan.project(deadProgram2, w.projectOwner.personId)
        val deadProject = TestPlan.project(w.programId, w.projectOwner.personId!!)
        val deadStream = TestPlan.workStream(w.streamOwner.personId!!)
        val deadProgram = TestPlan.program(deadStream, w.programOwner.personId!!)
        val underDead = TestPlan.project(deadProgram, w.projectOwner.personId)
        val onGoneConnection = TestPlan.project(w.programId, w.projectOwner.personId)
        dvBind(c, JiraLevel.PROJECT, w.projectId, "9301", "ABC-9301", DvObs("live"))
        dvBind(c, JiraLevel.PROJECT, deadProject, "9302", "ABC-9302", DvObs("dead"))
        dvBind(c, JiraLevel.PROJECT, underDead, "9303", "ABC-9303", DvObs("under"))
        dvBind(gone, JiraLevel.PROJECT, onGoneConnection, "9304", "ABC-9304", DvObs("conn"))
        val unboundBinding = dvBind(c, JiraLevel.PROJECT, unbound, "9305", "ABC-9305", DvObs("unbound"))
        dvBind(c, JiraLevel.PROGRAM, deadProgram2, "9306", "ABC-9306", DvObs("deadprog"))
        dvBind(c, JiraLevel.PROJECT, underDeadProgram, "9307", "ABC-9307", DvObs("underprog"))
        jbSql("UPDATE jira_bindings SET marked_as_deleted = TRUE WHERE id = ?", unboundBinding.toInt())
        jbSql("UPDATE programs SET marked_as_deleted = TRUE WHERE id = ?", deadProgram2.toInt())
        jbSql("UPDATE projects SET marked_as_deleted = TRUE WHERE id = ?", deadProject.toInt())
        jbSql("UPDATE work_streams SET marked_as_deleted = TRUE WHERE id = ?", deadStream.toInt())
        jbSql("UPDATE jira_connections SET marked_as_deleted = TRUE WHERE id = ?", gone.toInt())
        val view = w.stranger.client.get(path).body<JiraLinksView>()
        assertNotNull(view.link(JiraLevel.PROJECT, w.projectId))
        assertNull(view.link(JiraLevel.PROJECT, deadProject), "the node is deleted")
        assertNull(view.link(JiraLevel.PROJECT, underDead), "an ancestor is deleted")
        assertNull(view.link(JiraLevel.PROJECT, onGoneConnection), "the connection is deleted")
        assertNull(view.link(JiraLevel.PROJECT, unbound), "the binding is unbound (live node, live connection)")
        assertNull(view.link(JiraLevel.PROGRAM, deadProgram2), "the program is deleted under a live stream")
        assertNull(view.link(JiraLevel.PROJECT, underDeadProgram), "the program above it is deleted")
        assertNull(view.connection(gone), "a deleted connection is not listed")
        assertNotNull(view.connection(c))
    }

    @Test
    fun `a disabled connection's link is listed, a connection with no link too, mappingOk follows the discovery, gone the observation`() =
        testApplication {
            usePostgresTestcontainer()
            val w = planWorld("jld", teams = true)
            val enabled = w.admin.client.dvConnection()
            val disabled = w.admin.client.dvConnection(enabled = false)
            val empty = w.admin.client.dvConnection()
            val undiscovered = w.admin.client.dvConnection(discovery = null, mapping = null)
            val second = TestPlan.project(w.programId, w.projectOwner.personId!!)
            val third = TestPlan.project(w.programId, w.projectOwner.personId)
            dvBind(enabled, JiraLevel.PROJECT, w.projectId, "9401", "ABC-9401", DvObs("a", gone = true, goneReason = "DELETED"))
            dvBind(disabled, JiraLevel.PROJECT, second, "9402", "ABC-9402", DvObs("b"))
            dvBind(enabled, JiraLevel.PROJECT, third, "9403", "ABC-9403", obs = null)
            val view = w.stranger.client.get(path).body<JiraLinksView>()
            assertTrue(assertNotNull(view.link(JiraLevel.PROJECT, w.projectId)).gone)
            assertFalse(assertNotNull(view.link(JiraLevel.PROJECT, second)).gone)
            assertFalse(assertNotNull(view.link(JiraLevel.PROJECT, third)).gone, "never observed reads as not gone")
            assertEquals(disabled, view.link(JiraLevel.PROJECT, second)?.connectionId)
            assertFalse(assertNotNull(view.connection(disabled)).enabled)
            assertTrue(assertNotNull(view.connection(enabled)).enabled)
            assertTrue(view.links.none { it.connectionId == empty }, "no link")
            assertNotNull(view.connection(empty), "a connection with no link is still listed")
            assertTrue(assertNotNull(view.connection(enabled)).mappingOk)
            assertFalse(assertNotNull(view.connection(undiscovered)).mappingOk, "no discovery, no usable mapping")
            val order = view.connections.map { it.name.lowercase() to it.id }
            assertEquals(order.sortedWith(compareBy({ it.first }, { it.second })), order, "connections by name, then id")
        }

    @Test
    fun `the cap sets truncated`() = testApplication {
        usePostgresTestcontainer()
        val w = planWorld("jlc", teams = true)
        val c = w.admin.client.dvConnection()
        val second = TestPlan.project(w.programId, w.projectOwner.personId!!)
        dvBind(c, JiraLevel.PROJECT, w.projectId, "9501", "ABC-9501", DvObs("a"))
        dvBind(c, JiraLevel.PROJECT, second, "9502", "ABC-9502", DvObs("b"))
        val db = sharedDatabaseForTests()
        val capped = DeviationViewService(db, SyncRunService(db, 10), maxLinks = 1).links()
        assertEquals(1, capped.links.size)
        assertTrue(capped.truncated)
        assertFalse(DeviationViewService(db, SyncRunService(db, 10)).links().truncated)
    }

    @Test
    fun `the read sends two statements with one link and with many, none of them the deviation computation's tables`() = testApplication {
        usePostgresTestcontainer()
        val w = planWorld("jls", teams = true)
        val c = w.admin.client.dvConnection()
        suspend fun statements(): List<String> {
            val counter = StatementCounter()
            suspendTransaction(sharedDatabaseForTests()) {
                registerInterceptor(counter)
                sharedDeviationView().linksInTransaction()
            }
            return counter.sql
        }
        dvBind(c, JiraLevel.PROJECT, w.projectId, "9601", "ABC-9601", DvObs("a"))
        val one = statements()
        repeat(6) { n ->
            val project = TestPlan.project(w.programId, w.projectOwner.personId!!)
            dvBind(c, JiraLevel.PROJECT, project, "962$n", "ABC-962$n", DvObs("p$n"))
        }
        val many = statements()
        assertEquals(2, one.size, one.joinToString("\n"))
        assertEquals(one.size, many.size, "the statement count must not follow the number of links")
        val forbidden = listOf("jira_deviation_acknowledgements", "public_holidays", "milestones", "jira_issues", "sync_runs", "plan_state")
        for (name in forbidden) {
            assertTrue(many.none { Regex("""\b$name\b""").containsMatchIn(it) }, "$name must not be read:\n${many.joinToString("\n")}")
        }
    }

    private fun sharedDeviationView() = DeviationViewService(sharedDatabaseForTests(), SyncRunService(sharedDatabaseForTests(), 10))
}
