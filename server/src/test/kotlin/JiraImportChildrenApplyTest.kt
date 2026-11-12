package ch.nokillswit

import ch.nokillswit.jira.JiraImportAction
import ch.nokillswit.jira.JiraImportDefaults
import ch.nokillswit.jira.JiraImportFilter
import ch.nokillswit.jira.JiraImportOverrides
import ch.nokillswit.jira.JiraImportReason
import ch.nokillswit.jira.JiraImportRoot
import ch.nokillswit.jira.JiraImportRootLevel
import ch.nokillswit.jira.JiraLevel
import io.ktor.client.statement.bodyAsText
import io.ktor.http.HttpStatusCode
import io.ktor.server.testing.testApplication
import org.junit.BeforeClass
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * The rooted apply (1.14) against the stub's `IMC` project: the program's owner writes the root's descendants under the root's own node
 * in ONE plan write (no program is created), a re-import is all `ALREADY_BOUND`, an id outside the root's subtree is `CHANGED` with no
 * key, a root unlinked or an owner revoked while the request waits for the plan lock leaves nothing written, and a project root creates
 * its milestones unscheduled for a caller who manages no team. The under-lock root re-guard is pinned by a caller whose only ticks are
 * `ALREADY_BOUND` rows and who still owns another node of the tree after losing the root; ticking the root's own id is one
 * `ALREADY_BOUND` skip; a non-admin under a filter cannot write what the same-scope preview redacts; no refusal audits an apply.
 * No global program name is created, so nothing is cleaned up.
 */
class JiraImportChildrenApplyTest {
    private fun count(sql: String, vararg params: Any) = jbScalar(sql, *params) { it.getInt(1) }

    @Test
    fun `the program's owner writes the projects and milestones under the root in one bump, and a re-import is all ALREADY_BOUND`() =
        testApplication {
            val f = importFixture("jca1", keys = listOf("IMC"))
            val root = f.linkProgram()
            val owner = f.w.programOwner.client
            val scope = f.scope(root = root)
            val ticks = owner.preview(f.connectionId, scope).previewBody().ticks() +
                createTick(imcId(12), JiraLevel.PROJECT, imcId(11)) // another program's project: outside the root's subtree
            val before = TestPlan.revision()
            withAuditCapture { audit ->
                val result = owner.applyImport(f.connectionId, scope, ticks).applyBody()
                assertEquals(before + 1, result.revision, "ONE bump")
                assertEquals(mapOf(JiraLevel.PROJECT to 3, JiraLevel.MILESTONE to 5), result.created.groupingBy { it.kind }.eachCount())
                val skipped = result.skipped.single()
                assertEquals(listOf(imcId(12), null, JiraImportReason.CHANGED), listOf(skipped.jiraId, skipped.issueKey, skipped.reason))
                assertTrue(result.created.none { it.kind == JiraLevel.PROGRAM }, "a rooted import never creates a program")
                val event = assertNotNull(audit.awaitEvent { it.message == "jira.import_applied" })
                assertTrue(event.hasKeyValue("rootLevel", "PROGRAM"))
                assertTrue(event.hasKeyValue("rootNodeId", f.w.programId.toLong()))
            }
            val projects = count("SELECT count(*) FROM projects WHERE program_id = ? AND NOT marked_as_deleted", f.w.programId.toInt())
            assertEquals(4, projects, "the world's project and the three new ones")
            val milestones = "SELECT count(*) FROM milestones m JOIN projects p ON p.id = m.project_id " +
                "WHERE p.program_id = ? AND NOT m.marked_as_deleted AND p.id <> ?"
            assertEquals(5, count(milestones, f.w.programId.toInt(), f.w.projectId.toInt()))
            assertEquals(9, activeBindingCount(f.connectionId), "the root's link and the eight new ones")
            val observations = "SELECT count(*) FROM jira_observations o JOIN jira_bindings b ON b.id = o.binding_id " +
                "WHERE b.connection_id = ?"
            assertEquals(9, count(observations, f.connectionId.toInt()), "a first observation each")
            val outside = "SELECT count(*) FROM jira_bindings WHERE connection_id = ? AND jira_issue_id = ?"
            assertEquals(0, count(outside, f.connectionId.toInt(), imcId(12)))

            val again = owner.preview(f.connectionId, scope).previewBody()
            val reasons = again.items.associate { it.key() to it.reason }
            val bound = (2..8).map { "IMC-$it" } + "IMC-10"
            assertTrue(bound.all { reasons[it] == JiraImportReason.ALREADY_BOUND }, reasons.toString())
            assertEquals(JiraImportReason.NO_PARENT, reasons["IMC-9"])
            assertTrue(again.items.none { it.action != JiraImportAction.SKIP })
            // A stale client ticks them as CREATEs: each is the kernel's ALREADY_BOUND skip.
            val linked = again.items.filter { it.reason == JiraImportReason.ALREADY_BOUND }
            val stale = linked.map { createTick(it.jiraId, it.level, it.parentJiraId) }
            val none = owner.applyImport(f.connectionId, scope, stale).applyBody()
            assertTrue(none.created.isEmpty() && none.bound.isEmpty())
            assertEquals(8, none.skipped.count { it.reason == JiraImportReason.ALREADY_BOUND })
            assertEquals(9, activeBindingCount(f.connectionId), "nothing written")
        }

    @Test
    fun `a root unlinked before the apply is the 409, and nothing is written`() = testApplication {
        val f = importFixture("jca2", keys = listOf("IMC"))
        val root = f.linkProgram()
        val admin = f.w.admin.client
        val scope = f.scope(root = root)
        val ticks = admin.preview(f.connectionId, scope).previewBody().ticks()
        jbSql("UPDATE jira_bindings SET marked_as_deleted = TRUE WHERE connection_id = ?", f.connectionId.toInt())
        val before = TestPlan.revision()
        val response = admin.applyImport(f.connectionId, scope, ticks)
        assertEquals(HttpStatusCode.Conflict, response.status, response.bodyAsText())
        assertEquals("urn:astrolabe:problem:jira-root-unusable", response.jbProblem().type)
        assertEquals(before, TestPlan.revision())
    }

    @Test
    fun `a root unlinked while the apply waits for the plan lock is the 409 from under the lock, with nothing written and no bump`() =
        testApplication {
            val f = importFixture("jca3", keys = listOf("IMC"))
            val root = f.linkProgram()
            val admin = f.w.admin.client
            val scope = f.scope(root = root)
            val ticks = admin.preview(f.connectionId, scope).previewBody().ticks()
            val before = TestPlan.revision()
            val response = requestHeldAtPlanLock({ admin.applyImport(f.connectionId, scope, ticks) }) { raw ->
                raw.exec("UPDATE jira_bindings SET marked_as_deleted = TRUE WHERE connection_id = ?", f.connectionId.toInt())
            }
            assertEquals(HttpStatusCode.Conflict, response.status, response.bodyAsText())
            assertEquals("urn:astrolabe:problem:jira-root-unusable", response.jbProblem().type)
            assertEquals(before, TestPlan.revision(), "no bump")
            val links = count("SELECT count(*) FROM jira_bindings WHERE connection_id = ?", f.connectionId.toInt())
            assertEquals(1, links, "only the root's old link")
            assertEquals(1, count("SELECT count(*) FROM projects WHERE program_id = ? AND NOT marked_as_deleted", f.w.programId.toInt()))
        }

    @Test
    fun `an owner revoked while the rooted apply waits for the plan lock is a 403 with nothing written and no bump`() = testApplication {
        val f = importFixture("jca4", keys = listOf("IMC"))
        val root = f.linkProgram()
        val owner = f.w.programOwner
        val scope = f.scope(root = root)
        val ticks = owner.client.preview(f.connectionId, scope).previewBody().ticks()
        val before = TestPlan.revision()
        val response = requestHeldAtPlanLock({ owner.client.applyImport(f.connectionId, scope, ticks) }) { raw ->
            raw.exec("UPDATE programs SET owner_person_id = ? WHERE id = ?", f.w.stranger.personId!!.toInt(), f.w.programId.toInt())
        }
        assertEquals(HttpStatusCode.Forbidden, response.status, response.bodyAsText())
        assertEquals(before, TestPlan.revision())
        assertEquals(1, activeBindingCount(f.connectionId), "only the root's link")
    }

    @Test
    fun `a project root creates its milestones unscheduled where the caller manages no team, under the project`() = testApplication {
        val f = importFixture("jca5", keys = listOf("IMC"))
        val root = f.linkProject()
        val owner = f.w.projectOwner.client
        val scope = f.scope(root = root)
        val preview = owner.preview(f.connectionId, scope).previewBody()
        assertEquals(listOf("IMC-5", "IMC-6", "IMC-10"), preview.items.map { it.key() })
        val result = owner.applyImport(f.connectionId, scope, preview.ticks()).applyBody()
        assertEquals(3, result.created.size)
        assertTrue(result.created.all { it.kind == JiraLevel.MILESTONE && !it.scheduled })
        val dated = "SELECT count(*) FROM milestones WHERE project_id = ? AND NOT marked_as_deleted AND start_date IS NOT NULL"
        assertEquals(0, count(dated, f.w.projectId.toInt()))
        val under = "SELECT count(*) FROM milestones WHERE project_id = ? AND NOT marked_as_deleted"
        assertEquals(3, count(under, f.w.projectId.toInt()))
        assertNull(result.skipped.firstOrNull())
    }

    @Test
    fun `a caller who loses the root while the apply waits is a 403 although every tick is ALREADY_BOUND and they own another node`() =
        testApplication {
            val f = importFixture("jca6", keys = listOf("IMC"))
            val root = f.linkProgram()
            val owner = f.w.programOwner
            val scope = f.scope(root = root)
            // The caller owns a project of the program too: once the program changes hands that is still a node of the tree, so the
            // "owns something of the stream" proof and the guards on skipped rows would pass - only the re-guard of the ROOT refuses.
            TestPlan.project(f.w.programId, owner.personId!!)
            val admin = f.w.admin.client
            admin.applyImport(f.connectionId, scope, admin.preview(f.connectionId, scope).previewBody().ticks()).applyBody()
            val rows = owner.client.preview(f.connectionId, scope).previewBody().items
            val linked = rows.filter { it.reason == JiraImportReason.ALREADY_BOUND }
            assertEquals(8, linked.size, "everything under the root is linked now")
            val stale = linked.map { createTick(it.jiraId, it.level, it.parentJiraId) }
            val before = TestPlan.revision()
            val bindings = activeBindingCount(f.connectionId)
            val response = requestHeldAtPlanLock({ owner.client.applyImport(f.connectionId, scope, stale) }) { raw ->
                raw.exec("UPDATE programs SET owner_person_id = ? WHERE id = ?", f.w.stranger.personId!!.toInt(), f.w.programId.toInt())
            }
            assertEquals(HttpStatusCode.Forbidden, response.status, response.bodyAsText())
            assertEquals(before, TestPlan.revision(), "no bump")
            assertEquals(bindings, activeBindingCount(f.connectionId))
        }

    @Test
    fun `ticking the root's own id as a CREATE is one ALREADY_BOUND skip and creates no program, also under a filter for its owner`() =
        testApplication {
            val f = importFixture("jca7", keys = listOf("IMC"))
            val root = f.linkProgram()
            val tick = listOf(createTick(imcId(1), JiraLevel.PROGRAM))
            val streamPrograms = "SELECT count(*) FROM programs WHERE work_stream_id = ? AND NOT marked_as_deleted"
            val before = count(streamPrograms, f.w.streamId.toInt())
            val filter = JiraImportFilter(excludeDone = true, updatedWithinDays = 365)
            val callers = listOf(
                Triple("admin", f.w.admin, null),
                Triple("owner", f.w.programOwner, null),
                Triple("owner, filtered", f.w.programOwner, filter),
            )
            for ((name, caller, narrowed) in callers) {
                val result = caller.client.applyImport(f.connectionId, f.scope(filter = narrowed, root = root), tick).applyBody()
                assertTrue(result.created.isEmpty() && result.bound.isEmpty(), name)
                val skipped = result.skipped.single()
                val answer = listOf(skipped.jiraId, skipped.issueKey, skipped.reason)
                assertEquals(listOf(imcId(1), "IMC-1", JiraImportReason.ALREADY_BOUND), answer, name)
            }
            assertEquals(before, count(streamPrograms, f.w.streamId.toInt()), "no program was created")
            assertEquals(1, activeBindingCount(f.connectionId), "and no second link")
        }

    @Test
    fun `a non-admin's rooted apply under a filter answers what the preview redacts as a keyless CHANGED, an override changes nothing`() =
        testApplication {
            val f = importFixture("jca8", keys = listOf("IMC"))
            val root = f.linkProgram()
            // No default team: a milestone whose Jira team matches nothing is NO_TEAM, which the non-admin's filtered preview redacts.
            val filter = JiraImportFilter(excludeDone = true, updatedWithinDays = 365)
            val scope = f.scope(JiraImportDefaults(projectId = f.w.projectId), filter = filter, root = root)
            val all = f.w.admin.client.preview(f.connectionId, scope).previewBody().items
            val hidden = all.filter { it.reason == JiraImportReason.NO_TEAM }
            assertTrue(hidden.isNotEmpty(), "the scope has rows only a team could turn into a CREATE")
            val ticks = hidden.map {
                createTick(it.jiraId, it.level, it.parentJiraId).copy(overrides = JiraImportOverrides(f.defaultTeam))
            }
            val before = TestPlan.revision()
            val response = f.w.programOwner.client.applyImport(f.connectionId, scope, ticks)
            val text = response.bodyAsText()
            assertEquals(HttpStatusCode.OK, response.status, text)
            val result = jbJson.decodeFromString<ch.nokillswit.jira.JiraImportResult>(text)
            assertTrue(result.created.isEmpty() && result.bound.isEmpty(), text)
            val answer = result.skipped.map { Triple(it.jiraId, it.issueKey, it.reason) }
            assertEquals(hidden.map { Triple(it.jiraId, null, JiraImportReason.CHANGED) }, answer)
            assertTrue(Regex("IMC-[0-9]+").findAll(text).none(), "no key of a redacted row: $text")
            val milestones = "SELECT count(*) FROM milestones WHERE project_id = ? AND NOT marked_as_deleted"
            assertEquals(0, count(milestones, f.w.projectId.toInt()), "the override wrote nothing")
            assertEquals(before + 1, TestPlan.revision(), "the apply itself still bumps once")
        }

    @Test
    fun `no refusal of a rooted apply audits an apply or writes anything`() = testApplication {
        val f = importFixture("jca9", keys = listOf("IMC"))
        val root = f.linkProgram()
        val scope = f.scope(root = root)
        val ticks = listOf(createTick(imcId(2), JiraLevel.PROJECT, imcId(1)))
        val before = TestPlan.revision()
        val absent = JiraImportRoot(JiraImportRootLevel.PROGRAM, 999_999u)
        withAuditCapture { audit ->
            val refused = listOf(
                HttpStatusCode.Forbidden to f.w.stranger.client.applyImport(f.connectionId, scope, ticks),
                HttpStatusCode.NotFound to f.w.personless.client.applyImport(f.connectionId, f.scope(root = absent), ticks),
                HttpStatusCode.BadRequest to f.w.admin.client.applyImport(
                    f.connectionId, f.scope(JiraImportDefaults(programId = f.w.programId), root = root), ticks,
                ),
            )
            refused.forEach { (status, response) -> assertEquals(status, response.status, response.bodyAsText()) }
            jbSql("UPDATE jira_bindings SET marked_as_deleted = TRUE WHERE connection_id = ?", f.connectionId.toInt())
            val unlinked = f.w.admin.client.applyImport(f.connectionId, scope, ticks)
            assertEquals(HttpStatusCode.Conflict, unlinked.status, unlinked.bodyAsText())
            val lines = audit.events.map { it.message.orEmpty() }
            val writes = setOf("jira.import_applied", "jira.binding_released", "jira.import_previewed")
            assertTrue(lines.none { it in writes }, "$lines")
        }
        assertEquals(before, TestPlan.revision())
        assertEquals(1, count("SELECT count(*) FROM projects WHERE program_id = ? AND NOT marked_as_deleted", f.w.programId.toInt()))
    }

    companion object {
        @JvmStatic
        @BeforeClass
        fun warmStub() {
            JiraStubFixture.warm()
        }
    }
}
