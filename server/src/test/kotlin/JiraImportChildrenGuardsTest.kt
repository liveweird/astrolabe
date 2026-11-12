package ch.nokillswit

import ch.nokillswit.jira.JiraImportDefaults
import ch.nokillswit.jira.JiraImportFilter
import ch.nokillswit.jira.JiraImportReason
import ch.nokillswit.jira.JiraImportRoot
import ch.nokillswit.jira.JiraImportRootLevel
import ch.nokillswit.jira.JiraImportScope
import ch.nokillswit.jira.JiraLevel
import io.ktor.client.statement.bodyAsText
import io.ktor.http.HttpStatusCode
import io.ktor.server.testing.testApplication
import org.junit.BeforeClass
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

/**
 * Who may start a rooted import (1.14, Q2): the root's owner chain or ADMIN - today's "an owner of every target" rule with the root as one
 * more NAMED target. The root is read first (`404`), guarded up front (`403`, before the token is decrypted and before any Jira call) and
 * the redaction for a non-admin is today's (the rooted scope adds no oracle). Each caller makes one or two calls (the bucket is 5).
 */
class JiraImportChildrenGuardsTest {
    private val both = JiraImportFilter(excludeDone = true, updatedWithinDays = 365)

    private fun statuses(f: ImportFixture, callers: List<Pair<String, PlanCaller>>, root: JiraImportRoot) =
        callers.associate { (name, caller) -> name to runBlockingStatus(caller, f, root) }

    private fun runBlockingStatus(caller: PlanCaller, f: ImportFixture, root: JiraImportRoot): HttpStatusCode =
        kotlinx.coroutines.runBlocking { caller.client.preview(f.connectionId, f.scope(root = root)).status }

    private fun everyone(f: ImportFixture) = listOf(
        "admin" to f.w.admin, "streamOwner" to f.w.streamOwner, "programOwner" to f.w.programOwner, "projectOwner" to f.w.projectOwner,
        "teamManager" to f.w.requireTeams().manager,
    ) + f.w.outsiders

    @Test
    fun `a program root may be started by ADMIN and the stream's and the program's owner, and by nobody else`() = testApplication {
        val f = importFixture("jcg1", keys = listOf("IMC"))
        val root = f.linkProgram()
        val answers = statuses(f, everyone(f), root)
        val ok = HttpStatusCode.OK
        val no = HttpStatusCode.Forbidden
        assertEquals(
            mapOf(
                "admin" to ok, "streamOwner" to ok, "programOwner" to ok, "projectOwner" to no, "teamManager" to no,
                "stranger" to no, "personless" to no, "editor" to no,
            ),
            answers,
        )
    }

    @Test
    fun `a project root may be started by ADMIN and the stream's, the program's and the project's owner, and by nobody else`() =
        testApplication {
            val f = importFixture("jcg2", keys = listOf("IMC"))
            val root = f.linkProject()
            val answers = statuses(f, everyone(f), root)
            val ok = HttpStatusCode.OK
            val no = HttpStatusCode.Forbidden
            assertEquals(
                mapOf(
                    "admin" to ok, "streamOwner" to ok, "programOwner" to ok, "projectOwner" to ok, "teamManager" to no,
                    "stranger" to no, "personless" to no, "editor" to no,
                ),
                answers,
            )
        }

    @Test
    fun `a refused caller is refused on the apply too, and a missing root is a 404 before any 403, for every caller`() = testApplication {
        val f = importFixture("jcg3", keys = listOf("IMC"))
        val root = f.linkProgram()
        val tick = listOf(createTick(imcId(2), JiraLevel.PROJECT, imcId(1)))
        for ((name, caller) in listOf("projectOwner" to f.w.projectOwner) + f.w.outsiders) {
            assertEquals(HttpStatusCode.Forbidden, caller.client.applyImport(f.connectionId, f.scope(root = root), tick).status, name)
        }
        // The root is read BEFORE it is guarded: a stranger learns "not found" for an id nothing has, and for a deleted node.
        val deleted = TestPlan.program(f.w.streamId, f.w.programOwner.personId!!)
        jbSql("UPDATE programs SET marked_as_deleted = TRUE WHERE id = ?", deleted.toInt())
        val missing = listOf(
            JiraImportRoot(JiraImportRootLevel.PROGRAM, 999_999u), JiraImportRoot(JiraImportRootLevel.PROJECT, 999_999u),
            JiraImportRoot(JiraImportRootLevel.PROGRAM, deleted),
        )
        for (absent in missing) {
            val preview = f.w.stranger.client.preview(f.connectionId, f.scope(root = absent))
            assertEquals(HttpStatusCode.NotFound, preview.status, "preview $absent")
            val apply = f.w.personless.client.applyImport(f.connectionId, f.scope(root = absent), tick)
            assertEquals(HttpStatusCode.NotFound, apply.status, "apply $absent")
        }
        assertEquals("Project not found", f.w.editor.client.preview(f.connectionId, f.scope(root = missing[1])).jbProblem().detail)
    }

    @Test
    fun `a stranger's root outside the stream stays a 403, an owner's is a 400`() = testApplication {
        val a = importFixture("jcg4", keys = listOf("IMC"))
        val b = planWorld("jcg4b", teams = true)
        val other = JiraImportRoot(JiraImportRootLevel.PROGRAM, b.programId)
        // The picked stream is A's, the root is B's program: the guard on B's chain comes first.
        val defaults = JiraImportDefaults(teamId = a.defaultTeam)
        val scope = JiraImportScope(a.w.streamId, b.programOwner.personId!!, null, defaults, true, null, other)
        assertEquals(HttpStatusCode.Forbidden, a.w.stranger.client.preview(a.connectionId, scope).status)
        val aStreamOwner = a.w.streamOwner.client.preview(a.connectionId, scope)
        assertEquals(HttpStatusCode.Forbidden, aStreamOwner.status, "A's stream owner owns nothing of B")
        val owner = b.programOwner.client.preview(a.connectionId, scope)
        assertEquals(HttpStatusCode.BadRequest, owner.status, owner.bodyAsText())
        assertTrue("root is not a program of the picked work stream" in owner.jbProblem().detail.orEmpty())
    }

    @Test
    fun `a redacted skip reads as today for the program's owner, keyless under a filter, and the root is never a row`() = testApplication {
        val f = importFixture("jcg5", keys = listOf("IMC"))
        val root = f.linkProgram()
        val owner = f.w.programOwner.client
        val plain = owner.preview(f.connectionId, f.scope(root = root)).previewBody()
        val orphan = plain.items.single { it.action == ch.nokillswit.jira.JiraImportAction.SKIP }
        // Without a filter: the key stays, the text goes (the redaction of a whole-scope preview, row for row).
        assertEquals(listOf("IMC-9", "IMC-9", ""), listOf(orphan.issueKey, orphan.name, orphan.summary))
        assertEquals(JiraImportReason.NO_PARENT, orphan.reason)
        assertTrue(plain.items.none { it.issueKey == "IMC-1" }, "the root is not a row")
        // Under a filter: the handle goes too.
        val filtered = owner.preview(f.connectionId, f.scope(filter = both, root = root))
        val body = filtered.bodyAsText()
        val preview = jbJson.decodeFromString<ch.nokillswit.jira.JiraImportPreview>(body)
        val hidden = preview.items.single { it.action == ch.nokillswit.jira.JiraImportAction.SKIP }
        assertEquals(listOf(null, "", ""), listOf(hidden.issueKey, hidden.name, hidden.summary))
        assertTrue(hidden.jiraId.startsWith("hidden-"), hidden.jiraId)
        assertTrue(listOf("IMC-9", imcId(9)).none { it in body }, "no handle of the redacted row: $body")
        assertEquals(listOf("IMC-2", "IMC-3", "IMC-5", "IMC-7"), preview.items.filter { it.issueKey != null }.map { it.issueKey })
    }

    @Test
    fun `a child project linked to a project of ANOTHER program of the stream is a 403 naming it, for an owner of the root only`() =
        testApplication {
            val f = importFixture("jcg6", keys = listOf("IMC"))
            val root = f.linkProgram()
            val elsewhere = TestPlan.program(f.w.streamId, f.w.stranger.personId!!)
            val project = TestPlan.project(elsewhere, f.w.stranger.personId, "IMC Initiative North")
            f.w.admin.client.jbBind(f.connectionId, JiraLevel.PROJECT, project, "IMC-2").jbBinding()
            // IMC-5 now lands under that project, which the root program's owner does not own.
            val denied = f.w.programOwner.client.preview(f.connectionId, f.scope(root = root))
            assertEquals(HttpStatusCode.Forbidden, denied.status, denied.bodyAsText())
            assertTrue("IMC-5" in denied.jbProblem().detail.orEmpty(), denied.jbProblem().detail)
            assertEquals(HttpStatusCode.OK, f.w.streamOwner.client.preview(f.connectionId, f.scope(root = root)).status)
            assertEquals(HttpStatusCode.OK, f.w.admin.client.preview(f.connectionId, f.scope(root = root)).status)
        }

    companion object {
        @JvmStatic
        @BeforeClass
        fun warmStub() {
            JiraStubFixture.warm()
        }
    }
}
