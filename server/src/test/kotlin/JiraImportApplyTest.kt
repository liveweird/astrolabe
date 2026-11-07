package ch.nokillswit

import ch.nokillswit.jira.JiraImportAction
import ch.nokillswit.jira.JiraImportDefaults
import ch.nokillswit.jira.JiraImportReason
import ch.nokillswit.jira.JiraLevel
import ch.nokillswit.planning.MilestoneScheduleRequest
import io.ktor.client.request.get
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
 * `POST …/connections/{id}/import` against the stub's `IMP` project (1 Program, 2 Initiatives, 6 Epics; ids 95001..95009; the default
 * mapping). The refusals and statuses are `JiraImportApplyErrorsTest`, the lock behavior `JiraImportApplyRaceTest`, the rows that move
 * in between `JiraImportApplyChangesTest`. A caller makes at most five calls (the `jira-import` bucket, shared with the preview).
 */
class JiraImportApplyTest {
    private val defaultsOf = { f: ImportFixture -> JiraImportDefaults(projectId = f.w.projectId, teamId = f.defaultTeam) }

    private fun milestonesDated(ids: List<UInt>) =
        jbScalar("SELECT count(*) FROM milestones WHERE id IN (${ids.joinToString(",")}) AND start_date IS NOT NULL") { it.getInt(1) }

    @Test
    fun `the admin applies the IMP tree in one plan write, every row bound, and a re-import writes nothing`() = testApplication {
        val f = importFixture("jia1")
        val admin = f.w.admin.client
        try {
            val scope = f.scope(defaultsOf(f))
            val preview = admin.preview(f.connectionId, scope).previewBody()
            val before = TestPlan.revision()
            withAuditCapture { audit ->
                val result = admin.applyImport(f.connectionId, scope, preview.ticks()).applyBody()
                assertEquals(before + 1, result.revision, "ONE bump")
                assertEquals(before + 1, TestPlan.revision())
                val kinds = result.created.groupingBy { it.kind }.eachCount()
                assertEquals(mapOf(JiraLevel.PROGRAM to 1, JiraLevel.PROJECT to 2, JiraLevel.MILESTONE to 6), kinds)
                assertTrue(result.bound.isEmpty() && result.skipped.isEmpty())
                val scheduled = result.created.filter { it.scheduled }.map { it.issueKey }.sorted()
                assertEquals(listOf("IMP-4", "IMP-5", "IMP-7", "IMP-8", "IMP-9"), scheduled, "IMP-6 has no dates")

                // Every created row has an active binding with its first observation (the Jira summary).
                val id = f.connectionId.toInt()
                assertEquals(9, activeBindingCount(f.connectionId))
                val observed = "SELECT count(*) FROM jira_observations o JOIN jira_bindings b ON b.id = o.binding_id " +
                    "WHERE b.connection_id = ? AND o.observed_at > 0"
                assertEquals(9, jbScalar(observed, id) { it.getInt(1) })
                val summary = "SELECT o.summary FROM jira_observations o JOIN jira_bindings b ON b.id = o.binding_id " +
                    "WHERE b.connection_id = ? AND b.jira_issue_key = 'IMP-4'"
                assertEquals("IMP Epic One", jbScalar(summary, id) { it.getString(1) })

                // The dates are the schedule PUT's: stamped with the commit's revision, so a client at that revision is not stale.
                val one = result.created.first { it.issueKey == "IMP-4" }.id
                val stored = "SELECT schedule_revision, start_date::text FROM milestones WHERE id = ?"
                val row = jbScalar(stored, one.toInt()) { listOf(it.getString(1), it.getString(2)) }
                assertEquals(listOf(result.revision.toString(), "2045-01-02"), row)
                val undated = result.created.first { it.issueKey == "IMP-6" }.id
                val undatedRevision = jbScalar("SELECT schedule_revision FROM milestones WHERE id = ?", undated.toInt()) { it.getLong(1) }
                assertEquals(result.revision, undatedRevision)
                val staleRequest = MilestoneScheduleRequest(before, "2045-01-09", "2045-01-13")
                assertEquals(HttpStatusCode.Conflict, admin.putJson("/api/v1/milestones/$one/schedule", staleRequest).status)
                val fresh = MilestoneScheduleRequest(result.revision, "2045-01-09", "2045-01-13")
                assertEquals(HttpStatusCode.OK, admin.putJson("/api/v1/milestones/$one/schedule", fresh).status)

                val alpha = result.created.first { it.issueKey == "IMP-2" }.id
                assertTrue("2045-01-0" in admin.get("/api/v1/views/project/$alpha").bodyAsText(), "the project view shows the 2045 bars")
                val event = assertNotNull(audit.awaitEvent { it.message == "jira.import_applied" })
                val expected = listOf(
                    "connectionId" to f.connectionId.toLong(), "workStreamId" to f.w.streamId.toLong(), "revisionTo" to result.revision,
                )
                expected.forEach { (key, value) -> assertTrue(event.hasKeyValue(key, value), key) }
                val counts = listOf("createdCount" to 9, "boundCount" to 0, "skippedCount" to 0)
                counts.forEach { (key, value) -> assertTrue(event.hasKeyValue(key, value), key) }
                val milestoneIds = result.created.filter { it.kind == JiraLevel.MILESTONE }.map { it.id }.sorted().joinToString(",")
                assertTrue(event.hasKeyValue("milestoneIds", milestoneIds))
                assertTrue(event.hasKeyValue("programIds", result.created.single { it.kind == JiraLevel.PROGRAM }.id.toString()))
                assertTrue(event.hasKeyValue("bindingIds", result.created.map { it.bindingId }.sorted().joinToString(",")))
                assertEquals(5, event.keyValuePairs.single { it.key == "scheduledIds" }.value.toString().split(",").size)

                // A re-import: every row is ALREADY_BOUND, nothing is written, the revision still moves once.
                val afterPut = TestPlan.revision()
                val again = admin.applyImport(f.connectionId, scope, preview.ticks()).applyBody()
                assertTrue(again.created.isEmpty() && again.bound.isEmpty())
                assertEquals(9, again.skipped.size)
                assertTrue(again.skipped.all { it.reason == JiraImportReason.ALREADY_BOUND })
                assertEquals(afterPut + 1, again.revision)
                assertEquals(9, activeBindingCount(f.connectionId))
            }
        } finally {
            deleteImpProgram()
        }
    }

    @Test
    fun `an owner who manages no team creates the milestones unscheduled, and one who manages the team schedules them`() = testApplication {
        val f = importFixture("jia2")
        val owner = f.w.streamOwner
        try {
            val plain = f.scope()
            val firstTicks = owner.client.preview(f.connectionId, plain).previewBody().ticks()
            val first = owner.client.applyImport(f.connectionId, plain, firstTicks).applyBody()
            val milestones = first.created.filter { it.kind == JiraLevel.MILESTONE }
            assertEquals(5, milestones.size, "IMP-8 has no parent and no default project")
            assertTrue(milestones.none { it.scheduled })
            assertEquals(0, milestonesDated(milestones.map { it.id }), "no date was copied")
            deleteImpProgram()

            val team = TestTeams.seed(planName("jia2-team"), owner.personId)
            val managed = f.scope(JiraImportDefaults(teamId = team))
            val ticks = owner.client.preview(f.connectionId, managed).previewBody().ticks()
            val second = owner.client.applyImport(f.connectionId, managed, ticks).applyBody()
            val scheduled = second.created.filter { it.scheduled }.map { it.issueKey }.sorted()
            assertEquals(listOf("IMP-4", "IMP-5", "IMP-7", "IMP-9"), scheduled)
            assertEquals(4, milestonesDated(second.created.filter { it.scheduled }.map { it.id }))
        } finally {
            deleteImpProgram()
        }
    }

    @Test
    fun `a program owner applies the rows on their own program, and the answer carries no Jira text of a skipped row`() = testApplication {
        val f = importFixture("jia3")
        f.bindImpProgram()
        val owner = f.w.programOwner
        val summary = f.rowsOf(f.w.admin.client.preview(f.connectionId, f.scope()).previewBody()).getValue("IMP-8").summary
        assertTrue(summary.isNotBlank())
        val scope = f.scope()
        val ticks = owner.client.preview(f.connectionId, scope).previewBody().ticks() + createTick("95008", JiraLevel.MILESTONE, "95001")
        val before = TestPlan.revision()
        val response = owner.client.applyImport(f.connectionId, scope, ticks)
        val body = response.bodyAsText()
        assertEquals(HttpStatusCode.OK, response.status, body)
        val result = jbJson.decodeFromString<ch.nokillswit.jira.JiraImportResult>(body)
        assertEquals(before + 1, result.revision)
        assertEquals(mapOf(JiraLevel.PROJECT to 2, JiraLevel.MILESTONE to 5), result.created.groupingBy { it.kind }.eachCount())
        val orphan = result.skipped.single()
        assertEquals(listOf("IMP-8", JiraImportReason.NO_PARENT), listOf(orphan.issueKey, orphan.reason))
        assertTrue(summary !in body.substringAfter("\"skipped\""), "a skipped row carries its key and reason only")
        assertTrue(result.created.none { it.scheduled }, "the program owner manages no team")
        val ownerSql = "SELECT count(*) FROM projects WHERE program_id = ? AND owner_person_id = ?"
        val owned = jbScalar(ownerSql, f.w.programId.toInt(), f.w.streamOwner.personId!!.toInt()) { it.getInt(1) }
        assertEquals(2, owned, "the two new projects belong to the picked owner")
    }

    @Test
    fun `a BIND row binds the existing node and creates none, and a same-name project bound elsewhere is NAME_TAKEN`() = testApplication {
        val f = importFixture("jia4")
        val admin = f.w.admin.client
        f.bindImpProgram()
        val alpha = TestPlan.project(f.w.programId, f.w.projectOwner.personId!!, "IMP Initiative Alpha")
        val scope = f.scope()
        val preview = admin.preview(f.connectionId, scope).previewBody()
        assertEquals(JiraImportAction.BIND, f.rowsOf(preview).getValue("IMP-2").action)
        // After the preview, a connection of ANOTHER site binds a project named like IMP-3 to it: only the apply, under the lock, sees it.
        val other = admin.jbConnection(jbRequest(keys = listOf("IMP")))
        val beta = TestPlan.project(f.w.programId, f.w.projectOwner.personId, "IMP Initiative Beta")
        admin.jbBind(other.id, JiraLevel.PROJECT, beta, "IMP-3").jbBinding()

        val before = TestPlan.revision()
        val result = admin.applyImport(f.connectionId, scope, preview.ticks()).applyBody()
        assertEquals(before + 1, result.revision)
        assertEquals(listOf("IMP-2" to alpha), result.bound.map { it.issueKey to it.id })
        assertEquals(listOf("IMP-4", "IMP-5"), result.created.map { it.issueKey }, "only the epics under the BIND row's node")
        val skipped = result.skipped.associate { it.issueKey to it.reason }
        assertEquals(JiraImportReason.NAME_TAKEN, skipped["IMP-3"])
        for (key in listOf("IMP-6", "IMP-7", "IMP-9")) assertEquals(JiraImportReason.PARENT_SKIPPED, skipped[key], key)
        val projectsSql = "SELECT count(*) FROM projects WHERE program_id = ? AND NOT marked_as_deleted"
        val projects = jbScalar(projectsSql, f.w.programId.toInt()) { it.getInt(1) }
        assertEquals(3, projects, "the world's project, Alpha and Beta: no new project")
        assertNull(skipped["IMP-2"])
    }

    companion object {
        @JvmStatic
        @BeforeClass
        fun warmStub() {
            JiraStubFixture.warm()
        }
    }
}

internal fun ImportFixture.rowsOf(preview: ch.nokillswit.jira.JiraImportPreview) = preview.items.associateBy { it.issueKey }
