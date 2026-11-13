package ch.nokillswit

import ch.nokillswit.jira.JiraImportAction
import ch.nokillswit.jira.JiraImportDefaults
import ch.nokillswit.jira.JiraImportFilter
import ch.nokillswit.jira.JiraImportPreview
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
    fun `a project root under a deleted program is a 404 for every caller, on the preview and the apply`() = testApplication {
        val f = importFixture("jcg7", keys = listOf("IMC"))
        val root = f.linkProject()
        val tick = listOf(createTick(imcId(5), JiraLevel.MILESTONE, imcId(2)))
        assertEquals(HttpStatusCode.OK, f.w.projectOwner.client.preview(f.connectionId, f.scope(root = root)).status)
        // The project itself is active, its program is not: the chain read is the named-target 404, before any 403.
        jbSql("UPDATE programs SET marked_as_deleted = TRUE WHERE id = ?", f.w.programId.toInt())
        for ((name, caller) in listOf("admin" to f.w.admin, "projectOwner" to f.w.projectOwner, "stranger" to f.w.stranger)) {
            val preview = caller.client.preview(f.connectionId, f.scope(root = root))
            assertEquals(HttpStatusCode.NotFound, preview.status, "$name: ${preview.bodyAsText()}")
            assertEquals("Project not found", preview.jbProblem().detail, name)
        }
        val apply = f.w.personless.client.applyImport(f.connectionId, f.scope(root = root), tick)
        assertEquals(HttpStatusCode.NotFound, apply.status, apply.bodyAsText())
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
        val preview = jbJson.decodeFromString<JiraImportPreview>(body)
        val hidden = preview.items.single { it.action == ch.nokillswit.jira.JiraImportAction.SKIP }
        assertEquals(listOf(null, "", ""), listOf(hidden.issueKey, hidden.name, hidden.summary))
        assertTrue(hidden.jiraId.startsWith("hidden-"), hidden.jiraId)
        assertTrue(listOf("IMC-9", imcId(9)).none { it in body }, "no handle of the redacted row: $body")
        assertEquals(listOf("IMC-2", "IMC-3", "IMC-5", "IMC-7"), preview.items.filter { it.issueKey != null }.map { it.issueKey })
    }

    /** The world's stream with a SECOND program holding a project linked to `IMC-2`: what hangs under it (IMC-5, 6, 10) is outside. */
    private suspend fun ImportFixture.linkNorthElsewhere() {
        val elsewhere = TestPlan.program(w.streamId, w.stranger.personId!!)
        val project = TestPlan.project(elsewhere, w.stranger.personId, "IMC Initiative North")
        w.admin.client.jbBind(connectionId, JiraLevel.PROJECT, project, "IMC-2").jbBinding()
    }

    @Test
    fun `what hangs under a child project linked to another program's project is OUTSIDE_ROOT, redacted, and a 200 for the owner`() =
        testApplication {
            val f = importFixture("jcg6", keys = listOf("IMC"))
            val root = f.linkProgram()
            f.linkNorthElsewhere()
            val owner = f.w.programOwner.client
            val plain = owner.preview(f.connectionId, f.scope(root = root)).previewBody()
            val bound = plain.items.single { it.issueKey == "IMC-2" }
            assertEquals(listOf(JiraImportAction.SKIP, JiraImportReason.ALREADY_BOUND), listOf(bound.action, bound.reason))
            assertEquals("IMC Initiative North", bound.target?.nodeName, "the holder is named, as for any ALREADY_BOUND row")
            val outside = plain.items.filter { it.reason == JiraImportReason.OUTSIDE_ROOT }
            assertEquals(listOf("IMC-10", "IMC-5", "IMC-6"), outside.map { it.key() }.sorted())
            // Redacted like every skip but ALREADY_BOUND: no summary, the key as the name, nothing lands anywhere.
            assertTrue(outside.all { it.summary.isEmpty() && it.name == it.key() && it.parent == null })
            assertTrue(outside.all { it.action == JiraImportAction.SKIP })
            // Under a filter the handle goes too: no key, no Jira id.
            val body = owner.preview(f.connectionId, f.scope(filter = both, root = root)).bodyAsText()
            val filtered = jbJson.decodeFromString<JiraImportPreview>(body)
            val hidden = filtered.items.filter { it.reason == JiraImportReason.OUTSIDE_ROOT }
            assertEquals(1, hidden.size, "IMC-6 is done and IMC-10 is old: the filter leaves only IMC-5 under IMC-2")
            assertEquals(listOf(null, "", ""), listOf(hidden.single().issueKey, hidden.single().summary, hidden.single().name))
            assertTrue(listOf("IMC-5", imcId(5)).none { it in body }, "no handle of the redacted row: $body")
            // ADMIN sees the same verdicts in full.
            val admin = f.w.admin.client.preview(f.connectionId, f.scope(root = root)).previewBody()
            val adminOutside = admin.items.filter { it.reason == JiraImportReason.OUTSIDE_ROOT }
            assertEquals(listOf("IMC Epic One", "IMC Epic Six", "IMC Epic Two"), adminOutside.map { it.summary }.sorted())
            assertEquals(JiraImportReason.ALREADY_BOUND, admin.items.single { it.issueKey == "IMC-2" }.reason)
        }

    /** Whoever passes the root's guard gets a 200; everyone else a 403 from that guard, never the resolved-target one. */
    private fun assertRootGuardOnly(f: ImportFixture, root: JiraImportRoot, passers: Set<String>, filter: JiraImportFilter? = null) {
        val answers = kotlinx.coroutines.runBlocking {
            everyone(f).associate { (name, caller) -> name to caller.client.preview(f.connectionId, f.scope(filter = filter, root = root)) }
        }
        for ((name, response) in answers) {
            if (name in passers) {
                assertEquals(HttpStatusCode.OK, response.status, "$name: ${kotlinx.coroutines.runBlocking { response.bodyAsText() }}")
            } else {
                assertEquals(HttpStatusCode.Forbidden, response.status, name)
                val detail = kotlinx.coroutines.runBlocking { response.jbProblem().detail.orEmpty() }
                assertTrue("You do not own" !in detail, "$name: refused by the root's guard, not by a target")
            }
        }
    }

    @Test
    fun `no caller who passes a program root's guard ever meets the resolved-target 403, whatever is linked elsewhere, filtered or not`() =
        testApplication {
            val f = importFixture("jcg7", keys = listOf("IMC"))
            val root = f.linkProgram()
            f.linkNorthElsewhere()
            val passers = setOf("admin", "streamOwner", "programOwner")
            assertRootGuardOnly(f, root, passers)
            assertRootGuardOnly(f, root, passers, filter = both)
        }

    @Test
    fun `no caller who passes a project root's guard ever meets the resolved-target 403, filtered or not`() = testApplication {
        val f = importFixture("jcg8", keys = listOf("IMC"))
        val root = f.linkProject()
        val passers = setOf("admin", "streamOwner", "programOwner", "projectOwner")
        assertRootGuardOnly(f, root, passers)
        assertRootGuardOnly(f, root, passers, filter = both)
    }

    companion object {
        @JvmStatic
        @BeforeClass
        fun warmStub() {
            JiraStubFixture.warm()
        }
    }
}
