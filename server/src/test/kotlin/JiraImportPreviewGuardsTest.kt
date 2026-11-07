package ch.nokillswit

import ch.nokillswit.jira.JiraImportAction
import ch.nokillswit.jira.JiraImportDefaults
import ch.nokillswit.jira.JiraImportInfo
import ch.nokillswit.jira.JiraImportParentKind
import ch.nokillswit.jira.JiraImportReason
import ch.nokillswit.jira.JiraImportScope
import ch.nokillswit.jira.JiraLevel
import io.ktor.http.HttpStatusCode
import io.ktor.server.testing.ApplicationTestBuilder
import io.ktor.server.testing.testApplication
import org.junit.BeforeClass
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

/**
 * The preview's resolved-target guards and what a non-admin may read of rows nothing guards (`redactForNonAdmin`), end to end. Two
 * worlds: A holds the connection and the binding of `IMP-1` (so in B's stream `IMP-1` is `ALREADY_BOUND`, held elsewhere, and everything
 * below it skips); B is the caller's. A guard branch removed from the route makes one of these tests fail.
 */
class JiraImportPreviewGuardsTest {
    private class Worlds(val a: ImportFixture, val b: PlanWorld) {
        /** B's stream, B's owner, A's default team (any active team will do). */
        fun scopeB(defaults: JiraImportDefaults? = null) = JiraImportScope(b.streamId, b.streamOwner.personId!!, null, defaults, true)
    }

    private suspend fun ApplicationTestBuilder.worlds(prefix: String): Worlds {
        val a = importFixture("${prefix}a")
        val b = planWorld("${prefix}b", teams = true)
        a.w.admin.client.jbBind(a.connectionId, JiraLevel.PROGRAM, a.w.programId, "IMP-1").jbBinding()
        return Worlds(a, b)
    }

    @Test
    fun `a non-admin sees no Jira text on a skipped row, an ADMIN everything, and ALREADY_BOUND names its holder`() = testApplication {
        val w = worlds("jipred")
        val defaults = JiraImportDefaults(projectId = w.b.projectId, teamId = w.a.defaultTeam)
        // B's project owner owns the default project only: IMP-8 lands there, everything else skips.
        val preview = w.b.projectOwner.client.preview(w.a.connectionId, w.scopeB(defaults)).previewBody()
        val rows = preview.items.associateBy { it.issueKey }
        val landed = rows.getValue("IMP-8")
        assertEquals(listOf(JiraImportAction.CREATE, "IMP Epic Five"), listOf(landed.action, landed.summary))
        assertEquals(listOf(JiraImportParentKind.DEFAULT, w.b.projectId), landed.parent!!.let { listOf(it.kind, it.nodeId) })
        assertEquals("2045-02-06", landed.startDate, "a row on the caller's own target is shown in full")
        val held = rows.getValue("IMP-1")
        assertEquals(listOf(JiraImportReason.ALREADY_BOUND, "IMP Program"), listOf(held.reason, held.summary))
        assertEquals(w.a.w.programId, held.target!!.nodeId)
        val hidden = rows.values.filter { it.action == JiraImportAction.SKIP && it.reason != JiraImportReason.ALREADY_BOUND }
        assertEquals(7, hidden.size)
        assertTrue(hidden.all { it.reason == JiraImportReason.NO_PARENT || it.reason == JiraImportReason.PARENT_SKIPPED })
        assertTrue(hidden.all { it.summary == "" && it.name == it.issueKey && it.infos.isEmpty() }, hidden.toString())
        assertTrue(hidden.all { it.startDate == null && it.team == null && it.estimateMd == null && it.target == null })
        val totals = preview.totals
        assertEquals(listOf(9, 1, 0, 8), listOf(totals.items, totals.create, totals.bind, totals.skip), "the totals are the full ones")
        assertEquals(listOf("IMP Team"), preview.unmatchedTeams, "from the created row")

        // An ADMIN, same request: all of it.
        val admin = w.a.w.admin.client.preview(w.a.connectionId, w.scopeB(defaults)).previewBody().items.associateBy { it.issueKey }
        assertEquals("IMP Initiative Alpha", admin.getValue("IMP-2").summary)
        assertTrue(admin.getValue("IMP-7").summary.length == 110 && JiraImportInfo.NAME_TRUNCATED in admin.getValue("IMP-7").infos)
        assertEquals(JiraImportReason.PARENT_SKIPPED, admin.getValue("IMP-4").reason)
    }

    @Test
    fun `with nothing to create or bind, an owner of a node of the tree sees redacted rows, one who owns nothing in it is refused`() =
        testApplication {
            val w = worlds("jipall")
            // Every row skips in B's stream. A's project owner owns a node elsewhere only: refused.
            val refused = w.a.w.projectOwner.client.preview(w.a.connectionId, w.scopeB())
            assertEquals(HttpStatusCode.Forbidden, refused.status)
            assertEquals("Owner or admin role required", refused.jbProblem().detail)
            // B's project owner owns a node of the tree (no stream, no target): the rows come, redacted (ALREADY_BOUND keep text, C4).
            val partial = w.b.projectOwner.client.preview(w.a.connectionId, w.scopeB()).previewBody()
            assertEquals(9, partial.items.size)
            val others = partial.items.filter { it.reason != JiraImportReason.ALREADY_BOUND }
            assertTrue(others.isNotEmpty() && others.all { it.summary == "" && it.name == it.issueKey && it.infos.isEmpty() }, "blank")
            val owner = w.b.streamOwner.client.preview(w.a.connectionId, w.scopeB()).previewBody()
            assertEquals(listOf(9, 0, 0, 9), owner.totals.let { listOf(it.items, it.create, it.bind, it.skip) })
        }

    @Test
    fun `a BIND onto a node somebody else owns is refused with the bound-to wording`() = testApplication {
        val f = importFixture("jipbg")
        f.w.admin.client.jbBind(f.connectionId, JiraLevel.PROGRAM, f.w.programId, "IMP-1").jbBinding()
        // An unbound project named like IMP-2, owned by the project owner; the caller owns only a SIBLING project of the same program.
        TestPlan.project(f.w.programId, f.w.projectOwner.personId!!, "IMP Initiative Alpha")
        val sibling = secondProject(f.w, "jipbg2")
        val refused = sibling.owner.client.preview(f.connectionId, f.scope())
        assertEquals(HttpStatusCode.Forbidden, refused.status)
        val detail = refused.jbProblem().detail.orEmpty()
        assertTrue("IMP-2" in detail && "would be bound to" in detail && "project IMP Initiative Alpha" in detail, detail)
    }

    companion object {
        @JvmStatic
        @BeforeClass
        fun warmStub() {
            JiraStubFixture.warm()
        }
    }
}
