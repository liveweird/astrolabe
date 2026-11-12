package ch.nokillswit

import ch.nokillswit.jira.JiraImportAction
import ch.nokillswit.jira.JiraImportApplyItem
import ch.nokillswit.jira.JiraImportDefaults
import ch.nokillswit.jira.JiraImportOverrides
import ch.nokillswit.jira.JiraImportReason
import ch.nokillswit.jira.JiraLevel
import io.ktor.client.statement.bodyAsText
import io.ktor.http.HttpStatusCode
import io.ktor.server.testing.testApplication
import org.junit.BeforeClass
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNotNull
import kotlin.test.assertTrue

/**
 * The per-row owner override of the Jira import's apply (1.14, `overrides.ownerPersonId`) against the stub's `IMP` and `IMC` projects.
 * It names the owner of a PROGRAM or PROJECT the apply CREATES, instead of the dialog's owner; it is IGNORED on a milestone, a BIND and
 * a skipped row (as `overrides.teamId` is on a row it does not fit); an unknown or deleted person is a `400` wherever it is sent; and
 * it adds no guard of its own: whoever may name the dialog's owner may name a row's, and the up-front `403`s still win over the `400`.
 * A caller makes at most five calls (the `jira-import` bucket).
 */
class JiraImportOwnerOverrideTest {
    private fun ownerOf(table: String, id: UInt): Int =
        jbScalar("SELECT owner_person_id FROM $table WHERE id = ?", id.toInt()) { it.getInt(1) }

    private suspend fun deletedPerson(name: String): UInt = TestPeople.seed(planName(name)).also { TestPeople.softDelete(it) }

    private fun List<JiraImportApplyItem>.overriding(vararg owners: Pair<String, UInt>): List<JiraImportApplyItem> {
        val byId = owners.toMap()
        return map { tick -> byId[tick.jiraId]?.let { tick.copy(overrides = JiraImportOverrides(ownerPersonId = it)) } ?: tick }
    }

    @Test
    fun `the admin's per-row owner goes on the created program and project, the others keep the dialog's, a milestone's is ignored`() =
        testApplication {
            val f = importFixture("jiao1")
            val admin = f.w.admin.client
            try {
                val scope = f.scope(JiraImportDefaults(projectId = f.w.projectId, teamId = f.defaultTeam))
                val ticks = admin.preview(f.connectionId, scope).previewBody().ticks()
                val programOwner = f.w.projectOwner.personId!!
                val projectOwner = f.w.stranger.personId!!
                // The milestone's override names a third person: ignored, so it must not reach the audit line either.
                val ignored = f.w.programOwner.personId!!
                val overridden = ticks.overriding("95001" to programOwner, "95003" to projectOwner, "95004" to ignored)
                val result = withAuditCapture { audit ->
                    val applied = admin.applyImport(f.connectionId, scope, overridden).applyBody()
                    val event = assertNotNull(audit.awaitEvent { it.message == "jira.import_applied" })
                    assertTrue(event.hasKeyValue("ownerPersonId", f.w.streamOwner.personId!!.toLong()))
                    val granted = listOf(programOwner, projectOwner).sorted().joinToString(",")
                    assertTrue(event.hasKeyValue("ownerOverridePersonIds", granted), "only the created program's and project's owners")
                    applied
                }
                assertEquals(9, result.created.size)
                val byKey = result.created.associateBy { it.issueKey }
                assertEquals(programOwner.toInt(), ownerOf("programs", byKey.getValue("IMP-1").id))
                assertEquals(projectOwner.toInt(), ownerOf("projects", byKey.getValue("IMP-3").id))
                val dialogOwner = f.w.streamOwner.personId!!.toInt()
                assertEquals(dialogOwner, ownerOf("projects", byKey.getValue("IMP-2").id), "no override: the dialog's")
                assertEquals(JiraLevel.MILESTONE, byKey.getValue("IMP-4").kind, "a milestone with an owner override is created as usual")
            } finally {
                deleteImpProgram()
            }
        }

    @Test
    fun `the override is ignored on a BIND row and on a row the kernel skips, and counts on a row that is created`() = testApplication {
        val f = importFixture("jiao2")
        val admin = f.w.admin.client
        f.bindImpProgram()
        val alpha = TestPlan.project(f.w.programId, f.w.projectOwner.personId!!, "IMP Initiative Alpha")
        val scope = f.scope()
        val preview = admin.preview(f.connectionId, scope).previewBody()
        assertEquals(JiraImportAction.BIND, f.rowsOf(preview).getValue("IMP-2").action)
        val other = f.w.stranger.personId!!
        // IMP-1 is ALREADY_BOUND (a stale client ticks it as a CREATE); IMP-2 is a BIND; IMP-3 is a CREATE.
        val stale = preview.ticks() + createTick("95001", JiraLevel.PROGRAM)
        val ticks = stale.overriding("95001" to other, "95002" to other, "95003" to other)
        val result = admin.applyImport(f.connectionId, scope, ticks).applyBody()
        assertEquals(JiraImportReason.ALREADY_BOUND, result.skipped.single { it.issueKey == "IMP-1" }.reason)
        assertEquals(f.w.programOwner.personId!!.toInt(), ownerOf("programs", f.w.programId), "the bound program is untouched")
        assertEquals(listOf("IMP-2" to alpha), result.bound.map { it.issueKey to it.id })
        assertEquals(f.w.projectOwner.personId!!.toInt(), ownerOf("projects", alpha), "a BIND never changes the node's owner")
        assertEquals(other.toInt(), ownerOf("projects", result.created.single { it.issueKey == "IMP-3" }.id))
    }

    @Test
    fun `an unknown or deleted person is a 400 wherever it is sent, with nothing written and no bump`() = testApplication {
        val f = importFixture("jiao3")
        val admin = f.w.admin.client
        f.bindImpProgram()
        val scope = f.scope()
        val ticks = admin.preview(f.connectionId, scope).previewBody().ticks()
        val gone = deletedPerson("jiao3-gone")
        val before = TestPlan.revision()
        for (target in listOf("95002", "95004")) { // a project row and a milestone row: the check does not depend on the row's level
            val response = admin.applyImport(f.connectionId, scope, ticks.overriding(target to gone))
            assertEquals(HttpStatusCode.BadRequest, response.status, response.bodyAsText())
            assertTrue("overrides.ownerPersonId" in response.jbProblem().detail.orEmpty())
        }
        val unknown = admin.applyImport(f.connectionId, scope, ticks.overriding("95002" to 2_000_000_000u))
        assertEquals(HttpStatusCode.BadRequest, unknown.status)
        assertEquals(before, TestPlan.revision())
        assertEquals(1, activeBindingCount(f.connectionId), "only the program's link")
    }

    @Test
    fun `a stream owner may name another person for a row, and a caller who owns nothing is a 403 before the person is looked at`() =
        testApplication {
            val f = importFixture("jiao4")
            f.bindImpProgram()
            val scope = f.scope()
            val ticks = f.w.admin.client.preview(f.connectionId, scope).previewBody().ticks()
            val gone = deletedPerson("jiao4-gone")
            for ((label, outsider) in f.w.outsiders) {
                val refused = outsider.client.applyImport(f.connectionId, scope, ticks.overriding("95002" to gone))
                assertEquals(HttpStatusCode.Forbidden, refused.status, "$label: ${refused.bodyAsText()}")
            }
            val owner = f.w.streamOwner.client
            val badOverride = owner.applyImport(f.connectionId, scope, ticks.overriding("95002" to gone))
            assertEquals(HttpStatusCode.BadRequest, badOverride.status, "an owner who is allowed meets the 400")
            val chosen = f.w.projectOwner.personId!!
            val result = owner.applyImport(f.connectionId, scope, ticks.overriding("95002" to chosen, "95003" to chosen)).applyBody()
            for (key in listOf("IMP-2", "IMP-3")) {
                assertEquals(chosen.toInt(), ownerOf("projects", result.created.single { it.issueKey == key }.id), key)
            }
        }

    @Test
    fun `under a program root the program's owner overrides the owner of one created project`() = testApplication {
        val f = importFixture("jiao5", keys = listOf("IMC"))
        val root = f.linkProgram()
        val owner = f.w.programOwner.client
        val scope = f.scope(root = root)
        val preview = owner.preview(f.connectionId, scope).previewBody()
        val projects = preview.items.filter { it.action == JiraImportAction.CREATE && it.level == JiraLevel.PROJECT }
        assertTrue(projects.size >= 2, "the IMC program has projects under it")
        val picked = projects.first().jiraId
        val chosen = f.w.stranger.personId!!
        val result = owner.applyImport(f.connectionId, scope, preview.ticks().overriding(picked to chosen)).applyBody()
        val created = result.created.filter { it.kind == JiraLevel.PROJECT }
        assertEquals(projects.size, created.size)
        for (project in created) {
            val expected = if (project.jiraId == picked) chosen else f.w.streamOwner.personId!!
            assertEquals(expected.toInt(), ownerOf("projects", project.id), project.issueKey)
        }
    }

    @Test
    fun `under a project root the override rides along on the milestones, ignored but still validated`() = testApplication {
        val f = importFixture("jiao6", keys = listOf("IMC"))
        val root = f.linkProject()
        val owner = f.w.projectOwner.client
        val scope = f.scope(root = root)
        val milestones = owner.preview(f.connectionId, scope).previewBody().ticks()
        assertTrue(milestones.isNotEmpty() && milestones.all { it.expected.level == JiraLevel.MILESTONE })
        val gone = deletedPerson("jiao6-gone")
        val bad = owner.applyImport(f.connectionId, scope, milestones.overriding(milestones.first().jiraId to gone))
        assertEquals(HttpStatusCode.BadRequest, bad.status)
        val stranger = f.w.stranger.personId!!
        val ignored = milestones.overriding(*milestones.map { it.jiraId to stranger }.toTypedArray())
        val written = owner.applyImport(f.connectionId, scope, ignored).applyBody()
        assertEquals(milestones.size, written.created.size)
        assertEquals(f.w.projectOwner.personId!!.toInt(), ownerOf("projects", f.w.projectId), "the root's own owner is untouched")
    }

    companion object {
        @JvmStatic
        @BeforeClass
        fun warmStub() {
            JiraStubFixture.warm()
        }
    }
}
