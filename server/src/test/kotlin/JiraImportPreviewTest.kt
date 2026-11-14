package ch.nokillswit

import ch.nokillswit.jira.JiraEstimateMapping
import ch.nokillswit.jira.JiraEstimateUnit
import ch.nokillswit.jira.JiraImportAction
import ch.nokillswit.jira.JiraImportDefaults
import ch.nokillswit.jira.JiraImportFilter
import ch.nokillswit.jira.JiraImportInfo
import ch.nokillswit.jira.JiraImportParentKind
import ch.nokillswit.jira.JiraImportPreview
import ch.nokillswit.jira.JiraImportReason
import ch.nokillswit.jira.JiraImportRoot
import ch.nokillswit.jira.JiraImportScope
import ch.nokillswit.jira.JiraImportTeamRule
import ch.nokillswit.jira.JiraLevel
import ch.nokillswit.jira.JiraMappingResponse
import ch.nokillswit.users.UserRole
import io.ktor.client.HttpClient
import io.ktor.client.request.get
import io.ktor.client.statement.HttpResponse
import io.ktor.client.statement.bodyAsText
import io.ktor.http.HttpStatusCode
import io.ktor.server.testing.ApplicationTestBuilder
import io.ktor.server.testing.testApplication
import org.junit.BeforeClass
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * `POST …/connections/{id}/import-preview` against the shared stub's `IMP` project (1 Program, 2 Initiatives, 6 Epics, all in 2045; the
 * default mapping: Epic = milestone, Initiative = project, Program = program, "Target start/end", story points with NO factor, so every
 * estimate reads `ESTIMATE_NOT_CONVERTED`). The order of the checks, the refusals and the browse's own paths are
 * `JiraImportPreviewErrorsTest`. A preview writes nothing, and the per-USER bucket is 5 a minute, so a test keeps each caller to at most
 * five calls ([freshAdmin] for more). "IMP Program" is a GLOBALLY unique name: nothing here applies, so no test leaves one behind.
 * NOTE: the first test expects `IMP-1` to be CREATE; a class that leaves an ACTIVE "IMP Program" in the shared database (an apply
 * test) would flip it to NAME_TAKEN - delete it in a `finally`.
 */
class JiraImportPreviewTest {
    private suspend fun ApplicationTestBuilder.fixture(prefix: String): ImportFixture = importFixture(prefix)

    private fun ImportFixture.rows(preview: JiraImportPreview) = preview.items.associateBy { it.issueKey }

    /** Every column a preview could touch on the connection: cloud id, mapping, discovery, last test and the edit stamp. */
    private fun stateOf(id: UInt) = jbScalar(
        "SELECT COALESCE(cloud_id, 'none') || '|' || mapping::text || '|' || COALESCE(discovery::text, 'none') || '|' || " +
            "COALESCE(last_tested_at::text, 'none') || '|' || updated_at FROM jira_connections WHERE id = ?",
        id.toInt(),
    ) { it.getString(1) }

    @Test
    fun `the admin's preview lists the IMP tree top-down with every row decided, and stores nothing`() = testApplication {
        val f = fixture("jip")
        val admin = f.w.admin.client
        val revision = TestPlan.revision()
        // The Test connection stored the cloud id; clearing it makes a stray `storeCloudId` visible as a change.
        jbSql("UPDATE jira_connections SET cloud_id = NULL WHERE id = ?", f.connectionId.toInt())
        val before = stateOf(f.connectionId)
        val root = LogCapture("ROOT")
        try {
            withAuditCapture { audit ->
                val response = admin.preview(f.connectionId, f.scope())
                val body = response.bodyAsText()
                assertEquals(HttpStatusCode.OK, response.status, body)
                assertTrue(f.token !in body, "the token never reaches a response")
                val preview = jbJson.decodeFromString<JiraImportPreview>(body)

                assertEquals((1..9).map { "IMP-$it" }, preview.items.map { it.issueKey })
                val identity = listOf(preview.connectionId, preview.workStreamId, preview.revision)
                assertEquals(listOf(f.connectionId, f.w.streamId, revision), identity)
                val totals = preview.totals
                assertEquals(listOf(9, 8, 0, 1), listOf(totals.items, totals.create, totals.bind, totals.skip))
                assertFalse(totals.truncated)
                assertEquals(listOf("IMP Team"), preview.unmatchedTeams, "no Astrolabe team carries Jira's team name")
                val rows = f.rows(preview)
                val program = rows.getValue("IMP-1")
                val shape = listOf(program.level, program.action, program.name)
                assertEquals(listOf(JiraLevel.PROGRAM, JiraImportAction.CREATE, "IMP Program"), shape)
                assertNull(program.parent, "a program lands under the picked work stream")
                for (key in listOf("IMP-2", "IMP-3")) {
                    val project = rows.getValue(key)
                    assertEquals(listOf(JiraLevel.PROJECT, JiraImportAction.CREATE), listOf(project.level, project.action))
                    assertEquals(listOf(JiraImportParentKind.NEW_ROW, "95001"), project.parent!!.let { listOf(it.kind, it.rowJiraId) })
                }
                val one = rows.getValue("IMP-4")
                assertEquals(JiraImportAction.CREATE, one.action)
                assertEquals(listOf(JiraImportParentKind.NEW_ROW, "95002"), one.parent!!.let { listOf(it.kind, it.rowJiraId) })
                val dates = listOf(one.startDate, one.endDate, one.canSchedule, one.scheduled)
                assertEquals(listOf("2045-01-02", "2045-01-06", true, true), dates)
                assertEquals(listOf(f.defaultTeam, JiraImportTeamRule.DEFAULT), one.team!!.let { listOf(it.id, it.rule) })
                assertEquals(listOf(JiraImportInfo.ESTIMATE_NOT_CONVERTED), one.infos)
                assertEquals(0.0, one.estimateMd)
                // IMP-5 has no Team value at all: the default team; IMP-6 has no dates.
                assertEquals(JiraImportTeamRule.DEFAULT, rows.getValue("IMP-5").team!!.rule)
                val undated = rows.getValue("IMP-6")
                assertEquals(listOf(null, null, false), listOf(undated.startDate, undated.endDate, undated.scheduled))
                assertTrue(JiraImportInfo.DATES_INVALID in undated.infos)
                // IMP-7 has a 110-character summary.
                val long = rows.getValue("IMP-7")
                assertEquals(110, long.summary.length)
                assertTrue(long.name.length <= 100 && long.name.startsWith("IMP Epic Four with a deliberately long summary"))
                assertTrue(JiraImportInfo.NAME_TRUNCATED in long.infos)
                // IMP-8 hangs straight off the program: no project parent, no default project.
                val orphan = rows.getValue("IMP-8")
                assertEquals(listOf(JiraImportAction.SKIP, JiraImportReason.NO_PARENT), listOf(orphan.action, orphan.reason))
                assertEquals(listOf(null, false), listOf(orphan.startDate, orphan.scheduled), "a skipped row carries no dates")

                // With a default project (under the stream) the orphan lands there, a DEFAULT parent.
                val defaults = JiraImportDefaults(projectId = f.w.projectId, teamId = f.defaultTeam)
                val withDefault = admin.preview(f.connectionId, f.scope(defaults)).previewBody()
                val landed = f.rows(withDefault).getValue("IMP-8")
                assertEquals(JiraImportAction.CREATE, landed.action)
                assertEquals(listOf(JiraImportParentKind.DEFAULT, f.w.projectId), landed.parent!!.let { listOf(it.kind, it.nodeId) })
                assertEquals(listOf(9, 0), listOf(withDefault.totals.create, withDefault.totals.skip))

                // Dates are copied only on request: with `copyDates = false` nothing is scheduled and no date is flagged.
                val plain = admin.preview(f.connectionId, f.scope(copyDates = false)).previewBody()
                assertTrue(plain.items.none { it.scheduled || JiraImportInfo.DATES_INVALID in it.infos })
                assertTrue(audit.events.none { it.message.orEmpty().startsWith("jira.") }, "a preview audits nothing")
            }
            assertEquals(revision, TestPlan.revision(), "a preview bumps nothing")
            assertEquals(before, stateOf(f.connectionId), "no stored mapping, discovery or connection change")
            val id = f.connectionId.toInt()
            assertEquals(0, jbScalar("SELECT count(*) FROM jira_bindings WHERE connection_id = ?", id) { it.getInt(1) })
            val observations =
                "SELECT count(*) FROM jira_observations o JOIN jira_bindings b ON b.id = o.binding_id WHERE b.connection_id = ?"
            assertEquals(0, jbScalar(observations, id) { it.getInt(1) })
            assertTrue(root.events.none { f.token in it.formattedMessage }, "the token never reaches a log line")
        } finally {
            root.detach()
        }
    }

    @Test
    fun `an owner who manages no team previews with canSchedule false, and one who manages the team schedules`() = testApplication {
        val f = fixture("jipown")
        val owner = f.w.streamOwner.client
        val plain = owner.preview(f.connectionId, f.scope()).previewBody()
        val milestones = plain.items.filter { it.level == JiraLevel.MILESTONE && it.action == JiraImportAction.CREATE }
        assertEquals(5, milestones.size)
        assertTrue(milestones.none { it.canSchedule || it.scheduled }, "the owner manages no team")
        val dated = milestones.filter { it.startDate != null }
        assertEquals(4, dated.size)
        assertTrue(dated.all { JiraImportInfo.DATES_NOT_COPIED in it.infos }, "Jira's dates are shown, not copied")
        assertTrue(JiraImportInfo.DATES_INVALID in plain.items.first { it.issueKey == "IMP-6" }.infos)

        val team = TestTeams.seed(planName("jipown-team"), f.w.streamOwner.personId)
        val managed = owner.preview(f.connectionId, f.scope(JiraImportDefaults(teamId = team))).previewBody()
        assertEquals(listOf("IMP-4", "IMP-5", "IMP-7", "IMP-9"), managed.items.filter { it.scheduled }.map { it.issueKey })
        assertTrue(managed.items.filter { it.level == JiraLevel.MILESTONE && it.action == JiraImportAction.CREATE }.all { it.canSchedule })
    }

    @Test
    fun `a Team value matches an Astrolabe team by name without case, and a stored factor converts the estimate`() = testApplication {
        val f = fixture("jipteam")
        val admin = f.w.admin.client
        val teamId = TestTeams.seed("Imp Team")
        try {
            val matched = admin.preview(f.connectionId, f.scope()).previewBody()
            val rows = f.rows(matched)
            for (key in listOf("IMP-4", "IMP-6", "IMP-7", "IMP-9")) {
                assertEquals(listOf(teamId, JiraImportTeamRule.MATCHED), rows.getValue(key).team!!.let { listOf(it.id, it.rule) }, key)
            }
            assertEquals(JiraImportTeamRule.DEFAULT, rows.getValue("IMP-5").team!!.rule)
            assertEquals(emptyList(), matched.unmatchedTeams)
            // 0.5 man-days a point: IMP-4 has 5 points, IMP-5 has 8.
            val mapping = jbJson.decodeFromString<JiraMappingResponse>(admin.get("$JB_CONNECTIONS/${f.connectionId}/mapping").bodyAsText())
            val withFactor = checkNotNull(mapping.effective).copy(estimate = JiraEstimateMapping(JiraEstimateUnit.POINTS, 0.5))
            assertEquals(HttpStatusCode.NoContent, admin.putJson("$JB_CONNECTIONS/${f.connectionId}/mapping", withFactor).status)
            val converted = f.rows(admin.preview(f.connectionId, f.scope()).previewBody())
            assertEquals(listOf(2.5, 4.0), listOf(converted.getValue("IMP-4").estimateMd, converted.getValue("IMP-5").estimateMd))
            assertTrue(converted.values.none { JiraImportInfo.ESTIMATE_NOT_CONVERTED in it.infos })
        } finally {
            jbSql("UPDATE teams SET marked_as_deleted = true WHERE id = ?", teamId.toInt())
        }
    }

    @Test
    fun `an existing same-name project is a BIND, a bound issue ALREADY_BOUND, and an owner of the subtree previews`() = testApplication {
        val f = fixture("jipbind")
        val admin = f.w.admin.client
        // IMP-1 is bound to the world's program, so its children are looked for under THAT node (the stub's type object for IMP-1 has no
        // hierarchy level: it is resolved through the discovery by type id).
        admin.jbBind(f.connectionId, JiraLevel.PROGRAM, f.w.programId, "IMP-1").jbBinding()
        val existing = TestPlan.project(f.w.programId, f.w.projectOwner.personId!!, "IMP Initiative Alpha")
        val milestone = TestPlan.milestone(f.w.projectId, f.defaultTeam)
        admin.jbBind(f.connectionId, JiraLevel.MILESTONE, milestone, "IMP-4").jbBinding()

        val preview = admin.preview(f.connectionId, f.scope()).previewBody()
        val rows = f.rows(preview)
        val holder = rows.getValue("IMP-1")
        assertEquals(listOf(JiraImportAction.SKIP, JiraImportReason.ALREADY_BOUND), listOf(holder.action, holder.reason))
        val held = holder.target!!.let { listOf(it.nodeId, it.nodeKind, it.connectionId) }
        assertEquals(listOf(f.w.programId, JiraLevel.PROGRAM, f.connectionId), held)
        val bind = rows.getValue("IMP-2")
        assertEquals(listOf(JiraImportAction.BIND, existing), listOf(bind.action, bind.target!!.nodeId))
        assertEquals(listOf(JiraImportParentKind.EXISTING, f.w.programId), bind.parent!!.let { listOf(it.kind, it.nodeId) })
        val created = rows.getValue("IMP-3")
        assertEquals(listOf(JiraImportAction.CREATE, JiraImportParentKind.EXISTING), listOf(created.action, created.parent!!.kind))
        val skipped = rows.getValue("IMP-4")
        assertEquals(listOf(JiraImportAction.SKIP, JiraImportReason.ALREADY_BOUND), listOf(skipped.action, skipped.reason))
        assertEquals(milestone, skipped.target!!.nodeId)
        // IMP-5's parent is the BIND row: its target node, through that row.
        val child = rows.getValue("IMP-5").parent!!
        assertEquals(listOf(JiraImportParentKind.EXISTING, existing, "95002"), listOf(child.kind, child.nodeId, child.rowJiraId))
        val totals = preview.totals
        assertEquals(listOf(9, 5, 1, 3), listOf(totals.items, totals.create, totals.bind, totals.skip))

        // The program's owner owns every target (the program, the project under it): no program is created, so no stream guard.
        assertEquals(HttpStatusCode.OK, f.w.programOwner.client.preview(f.connectionId, f.scope()).status)
        // The project's owner owns the BIND target but not the program IMP-3 would be created under: the resolved-target 403 names it.
        val denied = f.w.projectOwner.client.preview(f.connectionId, f.scope())
        assertEquals(HttpStatusCode.Forbidden, denied.status)
        val detail = denied.jbProblem().detail.orEmpty()
        assertTrue("IMP-3" in detail && "program" in detail, detail)
    }

    @Test
    fun `the first IMP row creates a program, so the stream's owner is the one the program needs`() = testApplication {
        val f = fixture("jipstream")
        // Nothing is bound: IMP-1 would be a new program under the picked stream, which the program's owner does not own.
        val denied = f.w.programOwner.client.preview(f.connectionId, f.scope())
        assertEquals(HttpStatusCode.Forbidden, denied.status)
        assertTrue("work stream" in denied.jbProblem().detail.orEmpty() && "IMP-1" in denied.jbProblem().detail.orEmpty())
        assertEquals(HttpStatusCode.OK, f.w.streamOwner.client.preview(f.connectionId, f.scope()).status)
    }

    companion object {
        @JvmStatic
        @BeforeClass
        fun warmStub() {
            JiraStubFixture.warm()
        }
    }
}

/** An `IMP`-scoped, tested connection on a private site, and the plan world a preview picks its stream from. */
class ImportFixture(val w: PlanWorld, val connectionId: UInt, val site: String, val token: String) {
    val defaultTeam get() = w.requireTeams().teamId

    fun scope(
        defaults: JiraImportDefaults? = JiraImportDefaults(teamId = defaultTeam),
        copyDates: Boolean = true,
        keys: List<String>? = null,
        filter: JiraImportFilter? = null,
        root: JiraImportRoot? = null,
        matches: List<ch.nokillswit.jira.JiraImportMatch>? = null,
    ) = JiraImportScope(w.streamId, w.streamOwner.personId!!, keys, defaults, copyDates, filter, root, matches)
}

/** [keys]: the connection's project keys (`IMP` by default; `IMF` for the filter's own project). */
internal suspend fun ApplicationTestBuilder.importFixture(prefix: String, keys: List<String> = listOf("IMP")): ImportFixture {
    configureApp("jira.stubBaseUrl" to JiraStubFixture.warm(), "jira.maxRetries" to "0")
    startApplication()
    val w = planWorld(prefix, teams = true)
    val request = jbRequest(keys = keys)
    return ImportFixture(w, w.admin.client.jbConnection(request).id, request.siteUrl, checkNotNull(request.apiToken))
}

/** `POST …/connections/{id}/import-preview`. */
internal suspend fun HttpClient.preview(id: UInt, scope: JiraImportScope): HttpResponse =
    postJson("$JB_CONNECTIONS/$id/import-preview", scope)

internal suspend fun HttpResponse.previewBody(): JiraImportPreview {
    assertEquals(HttpStatusCode.OK, status, bodyAsText())
    return jbJson.decodeFromString(bodyAsText())
}

/** An ADMIN with no person and a bucket of its own: the per-user limit is 5 a minute. */
internal suspend fun ApplicationTestBuilder.freshAdmin(): HttpClient = planCaller("jipad", UserRole.ADMIN, withPerson = false).client
