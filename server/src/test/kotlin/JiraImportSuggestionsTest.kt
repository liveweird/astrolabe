package ch.nokillswit

import ch.nokillswit.jira.JiraImportAction
import ch.nokillswit.jira.JiraImportFilter
import ch.nokillswit.jira.JiraImportInfo
import ch.nokillswit.jira.JiraImportMatch
import ch.nokillswit.jira.JiraImportParentKind
import ch.nokillswit.jira.JiraImportPreview
import ch.nokillswit.jira.JiraImportReason
import ch.nokillswit.jira.JiraImportScope
import ch.nokillswit.jira.JiraLevel
import io.ktor.client.statement.bodyAsText
import io.ktor.http.HttpStatusCode
import io.ktor.server.testing.ApplicationTestBuilder
import io.ktor.server.testing.testApplication
import org.junit.BeforeClass
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * Suggested matches (1.15) over HTTP against the stub's `IMC` project, rooted at `IMC-1` (the world's program), with an UNLINKED plan
 * project "Initiative North" under it: the preview's `IMC-2` ("IMC Initiative North") is a CREATE that looks like it, a confirmation
 * (`matches`) turns it into a BIND whose children land under the existing project, an apply writes exactly that (no project created, one
 * bump, the audit line), and a confirmation that is stale, missing or not the server's own suggestion changes nothing. Each caller makes
 * at most five calls a minute.
 */
class JiraImportSuggestionsTest {
    private class World(val f: ImportFixture, val north: UInt, val root: ch.nokillswit.jira.JiraImportRoot) {
        fun scope(vararg matches: JiraImportMatch, filter: JiraImportFilter? = null): JiraImportScope =
            f.scope(filter = filter, root = root, matches = matches.toList().takeIf { it.isNotEmpty() })
    }

    private suspend fun ApplicationTestBuilder.world(prefix: String): World {
        val f = importFixture(prefix, keys = listOf("IMC"))
        val root = f.linkProgram()
        val north = TestPlan.project(f.w.programId, f.w.projectOwner.personId!!, "Initiative North")
        return World(f, north, root)
    }

    private fun count(sql: String, vararg params: Any) = jbScalar(sql, *params) { it.getInt(1) }

    private fun JiraImportPreview.byKey() = items.associateBy { it.key() }

    @Test
    fun `the first preview offers the link, the second shows it as a BIND under the existing project, the apply writes it`() =
        testApplication {
            val w = world("jsg1")
            val f = w.f
            val owner = f.w.programOwner.client
            val revision = TestPlan.revision()
            val plain = owner.preview(f.connectionId, w.scope()).previewBody().byKey()
            val offered = plain.getValue("IMC-2")
            assertEquals(JiraImportAction.CREATE, offered.action)
            assertEquals(listOf(w.north, "Initiative North"), offered.suggestion!!.let { listOf(it.nodeId, it.nodeName) })
            assertEquals(listOf("IMC-2"), plain.values.filter { it.suggestion != null }.map { it.key() }, "only IMC-2 looks alike")
            assertEquals(revision, TestPlan.revision(), "a preview links nothing and bumps nothing")

            val scope = w.scope(JiraImportMatch(imcId(2), w.north))
            val confirmed = owner.preview(f.connectionId, scope).previewBody()
            val linked = confirmed.byKey().getValue("IMC-2")
            assertEquals(listOf(JiraImportAction.BIND, listOf(JiraImportInfo.MATCH_CONFIRMED)), listOf(linked.action, linked.infos))
            assertEquals(w.north, linked.target!!.nodeId)
            assertNull(linked.suggestion)
            val epic = confirmed.byKey().getValue("IMC-5")
            assertEquals(listOf(JiraImportParentKind.EXISTING, w.north), epic.parent!!.let { listOf(it.kind, it.nodeId) })
            assertEquals(1, confirmed.totals.bind, "the confirmed project is the only BIND")

            val before = TestPlan.revision()
            val projects = "SELECT count(*) FROM projects WHERE program_id = ? AND NOT marked_as_deleted"
            val projectsBefore = count(projects, f.w.programId.toInt())
            withAuditCapture { audit ->
                val result = owner.applyImport(f.connectionId, scope, confirmed.ticks()).applyBody()
                assertEquals(before + 1, result.revision, "ONE bump")
                val bound = result.bound.single()
                assertEquals(listOf(imcId(2), w.north), listOf(bound.jiraId, bound.id))
                assertTrue(result.created.none { it.name == "IMC Initiative North" }, "no duplicate project")
                assertEquals(
                    listOf("IMC Initiative East", "IMC Initiative South"),
                    result.created.filter { it.kind == JiraLevel.PROJECT }.map { it.name }.sorted(),
                )
                assertEquals(5, result.created.count { it.kind == JiraLevel.MILESTONE && it.name.startsWith("IMC Epic") })
                val event = assertNotNull(audit.awaitEvent { it.message == "jira.import_applied" })
                assertTrue(event.hasKeyValue("confirmedMatchBindingIds", bound.bindingId.toString()))
                assertTrue(event.hasKeyValue("boundCount", 1))
                val all = (result.created.map { it.bindingId } + bound.bindingId).sorted().joinToString(",")
                assertTrue(event.hasKeyValue("bindingIds", all))
            }
            assertEquals(projectsBefore + 2, count(projects, f.w.programId.toInt()))
            val sql = "SELECT count(*) FROM jira_bindings WHERE project_id = ? AND jira_issue_id = ? AND NOT marked_as_deleted"
            assertEquals(1, count(sql, w.north.toInt(), imcId(2)))
            val observed = "SELECT count(*) FROM jira_observations o JOIN jira_bindings b ON b.id = o.binding_id WHERE b.project_id = ?"
            assertEquals(1, count(observed, w.north.toInt()), "the first observation was written")
            val under = "SELECT count(*) FROM milestones WHERE project_id = ? AND NOT marked_as_deleted"
            assertEquals(3, count(under, w.north.toInt()), "IMC-5, IMC-6 and IMC-10 landed under the existing project")
        }

    @Test
    fun `a confirmation the plan no longer supports, or the apply leaves out, is CHANGED and writes nothing`() = testApplication {
        val w = world("jsg2")
        val f = w.f
        val admin = f.w.admin.client
        val scope = w.scope(JiraImportMatch(imcId(2), w.north))
        val ticks = admin.preview(f.connectionId, scope).previewBody().ticks()
        // The project is renamed between the preview and the apply: it is no longer the server's own suggestion.
        jbSql("UPDATE projects SET name = 'Initiative Northwest' WHERE id = ?", w.north.toInt())
        val before = TestPlan.revision()
        val stale = admin.applyImport(f.connectionId, scope, ticks).applyBody()
        assertEquals(before + 1, stale.revision, "an apply bumps once, also when it skips")
        val skipped = stale.skipped.associate { it.jiraId to it.reason }
        assertEquals(JiraImportReason.CHANGED, skipped[imcId(2)])
        assertTrue(stale.bound.isEmpty() && stale.created.none { it.name == "IMC Initiative North" })
        val sql = "SELECT count(*) FROM jira_bindings WHERE project_id = ?"
        assertEquals(0, count(sql, w.north.toInt()), "nothing was linked")

        // And the same apply with the confirmation left out of the request.
        jbSql("UPDATE projects SET name = 'Initiative North' WHERE id = ?", w.north.toInt())
        val missing = admin.applyImport(f.connectionId, w.scope(), ticks).applyBody()
        assertEquals(JiraImportReason.CHANGED, missing.skipped.single { it.jiraId == imcId(2) }.reason)
        assertEquals(0, count(sql, w.north.toInt()))
    }

    @Test
    fun `an entry that is not the server's own suggestion changes nothing in the preview`() = testApplication {
        val w = world("jsg3")
        val f = w.f
        val admin = f.w.admin.client
        val other = TestPlan.project(f.w.programId, f.w.projectOwner.personId!!, "Initiative Elsewhere")
        val plain = admin.preview(f.connectionId, w.scope()).previewBody()
        val stray = admin.preview(
            f.connectionId,
            w.scope(JiraImportMatch(imcId(2), other), JiraImportMatch(imcId(3), w.north), JiraImportMatch("424242", w.north)),
        ).previewBody()
        assertEquals(plain.items.map { it.jiraId to it.action }, stray.items.map { it.jiraId to it.action })
        assertEquals(plain.items.map { it.suggestion }, stray.items.map { it.suggestion })
        assertEquals(plain.totals, stray.totals)
    }

    @Test
    fun `the shape 400s come after the up-front 403s`() = testApplication {
        val w = world("jsg4")
        val f = w.f
        val duplicate = w.scope(JiraImportMatch(imcId(2), w.north), JiraImportMatch(imcId(2), w.north))
        val notNumeric = w.scope(JiraImportMatch("hidden-1", w.north))
        val tooMany = f.scope(root = w.root, matches = (1..2_001).map { JiraImportMatch("$it", w.north) })
        val denied = f.w.stranger.client.preview(f.connectionId, duplicate)
        assertEquals(HttpStatusCode.Forbidden, denied.status, "the 403 wins over the 400")
        val admin = f.w.admin.client
        for ((label, scope) in mapOf("a duplicate" to duplicate, "a handle" to notNumeric, "too many" to tooMany)) {
            val response = admin.preview(f.connectionId, scope)
            assertEquals(HttpStatusCode.BadRequest, response.status, "$label: ${response.bodyAsText()}")
        }
    }

    @Test
    fun `the shape 400s of matches come after the up-front 403s on the apply route too`() = testApplication {
        val w = world("jsg6")
        val f = w.f
        val tick = createTick(imcId(2), JiraLevel.PROJECT, imcId(1))
        val duplicate = w.scope(JiraImportMatch(imcId(2), w.north), JiraImportMatch(imcId(2), w.north))
        val handle = w.scope(JiraImportMatch("hidden-1", w.north))
        val denied = f.w.stranger.client.applyImport(f.connectionId, duplicate, listOf(tick))
        assertEquals(HttpStatusCode.Forbidden, denied.status, "the 403 wins over the 400")
        val admin = f.w.admin.client
        for ((label, scope) in mapOf("a duplicate" to duplicate, "a handle" to handle)) {
            val response = admin.applyImport(f.connectionId, scope, listOf(tick))
            assertEquals(HttpStatusCode.BadRequest, response.status, "$label: ${response.bodyAsText()}")
        }
        assertEquals(1, activeBindingCount(f.connectionId), "nothing was written: only the root's link")
    }

    @Test
    fun `an apply without matches audits an empty confirmedMatchBindingIds`() = testApplication {
        val w = world("jsg7")
        val f = w.f
        val admin = f.w.admin.client
        val scope = w.scope()
        val preview = admin.preview(f.connectionId, scope).previewBody()
        withAuditCapture { audit ->
            val result = admin.applyImport(f.connectionId, scope, preview.ticks()).applyBody()
            assertTrue(result.bound.isEmpty())
            val event = assertNotNull(audit.awaitEvent { it.message == "jira.import_applied" })
            assertTrue(event.hasKeyValue("confirmedMatchBindingIds", ""))
        }
    }

    @Test
    fun `a non-admin under a filter links a confirmed match too - the withheld ids are computed with the same confirmations`() =
        testApplication {
            val w = world("jsg5")
            val f = w.f
            val owner = f.w.programOwner.client
            val filter = JiraImportFilter(excludeDone = true, updatedWithinDays = 365)
            val scope = w.scope(JiraImportMatch(imcId(2), w.north), filter = filter)
            val preview = owner.preview(f.connectionId, scope).previewBody()
            val linked = preview.items.single { it.issueKey == "IMC-2" }
            assertEquals(JiraImportAction.BIND, linked.action)
            assertTrue(preview.items.filter { it.issueKey == null }.all { it.suggestion == null && it.action == JiraImportAction.SKIP })
            val result = owner.applyImport(f.connectionId, scope, preview.ticks()).applyBody()
            assertEquals(listOf(imcId(2)), result.bound.map { it.jiraId })
            assertEquals(1, count("SELECT count(*) FROM jira_bindings WHERE project_id = ? AND NOT marked_as_deleted", w.north.toInt()))
        }

    companion object {
        @JvmStatic
        @BeforeClass
        fun warmStub() {
            JiraStubFixture.warm()
        }
    }
}
