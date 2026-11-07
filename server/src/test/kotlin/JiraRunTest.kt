package ch.nokillswit

import ch.nokillswit.jira.JiraBindingResponse
import ch.nokillswit.jira.JiraLevel
import ch.nokillswit.jira.JiraObserverKey
import ch.nokillswit.sync.Connector
import ch.nokillswit.sync.SyncConnectors
import ch.nokillswit.sync.SyncKind
import ch.nokillswit.sync.SyncOutcome
import ch.nokillswit.sync.SyncRunList
import ch.nokillswit.sync.SyncRunRequest
import ch.nokillswit.sync.SyncRunResponse
import ch.nokillswit.sync.SyncRunServiceKey
import ch.nokillswit.sync.SyncRunnerKey
import ch.nokillswit.sync.SyncScheduler
import ch.nokillswit.sync.SyncTrigger
import io.ktor.client.HttpClient
import io.ktor.client.request.delete
import io.ktor.client.request.get
import io.ktor.client.request.post
import io.ktor.client.statement.bodyAsText
import io.ktor.http.HttpStatusCode
import io.ktor.server.testing.ApplicationTestBuilder
import io.ktor.server.testing.testApplication
import kotlinx.coroutines.withTimeout
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.AfterClass
import org.junit.BeforeClass
import java.io.File
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue

const val SYNC_RUNS = "/api/v1/integrations/sync/runs"

/**
 * The Jira run over the stub (`sample-data/jira`), through the real route and the background runner: the full first read, the
 * incremental after it, the sweep's `gone` flag across `jira-day2` and back, `expected.json`'s planted figures, the node sweep and no
 * plan-revision bump. Failure paths (a fetch error, an expired cursor) are in `JiraRunFailureTest`, the wire and the edge cases in
 * `JiraRunWireTest`.
 *
 * **The shared stub's scenario state.** `jira-day2` is process-wide state of the per-fork `JiraStubServer`, and test classes of one fork
 * run one after another, so a class may flip it provided it never leaves it flipped: every test that flips it resets ALL scenarios in a
 * `finally` (and `@AfterClass` does it once more), which is the only place this suite leaves the stub as it found it. Each test works on
 * a private site (`jbSite()`), so its bindings never meet another test's (the stub answers every tenant host alike).
 */
class JiraRunTest {
    companion object {
        @JvmStatic
        @BeforeClass
        fun warmStub() {
            JiraStubFixture.warm()
        }

        @JvmStatic
        @AfterClass
        fun leaveStubAsFound() {
            JiraStubServer.resetScenarios()
        }

        val expected: JsonObject by lazy {
            val file = File(System.getProperty("repo.root") ?: "..", "sample-data/jira/expected.json")
            Json.parseToJsonElement(file.readText()).jsonObject
        }
    }

    private suspend fun ApplicationTestBuilder.start() {
        configureApp("jira.stubBaseUrl" to JiraStubFixture.warm(), "jira.maxRetries" to "0")
        startApplication()
    }

    /** `POST` the run (expecting `202`) and wait for the background run to end, then answer its finished row. */
    private suspend fun ApplicationTestBuilder.runAndAwait(client: HttpClient, connectionId: UInt): SyncRunResponse {
        val accepted = client.postJson(SYNC_RUNS, SyncRunRequest(SyncKind.JIRA, connectionId))
        assertEquals(HttpStatusCode.Accepted, accepted.status, accepted.bodyAsText())
        val started = jbJson.decodeFromString<SyncRunResponse>(accepted.bodyAsText())
        assertNull(started.finishedAt)
        withTimeout(120_000) { application.attributes[SyncRunnerKey].await(started.id) }
        val listed = jbJson.decodeFromString<SyncRunList>(client.get("$SYNC_RUNS?kind=JIRA&connectionId=$connectionId").bodyAsText())
        return listed.items.single { it.id == started.id }
    }

    private suspend fun HttpClient.binding(id: UInt): JiraBindingResponse =
        jbJson.decodeFromString(get("$JB_BINDINGS/$id").also { assertEquals(HttpStatusCode.OK, it.status) }.bodyAsText())

    private fun staleObservation(id: UInt) =
        jbSql("UPDATE jira_observations SET observed_at = 1, summary = 'stale' WHERE binding_id = ?", id.toInt())

    private fun e2eIssue(key: String): JsonObject =
        expected.getValue("e2e").jsonObject.getValue("issues").jsonArray.map { it.jsonObject }
            .single { it.getValue("key").jsonPrimitive.content == key }

    private class Fixture(val w: PlanWorld, val connectionId: UInt, val site: String, val token: String) {
        suspend fun milestone() = TestPlan.milestone(w.projectId, w.requireTeams().teamId, planName("ms"))
    }

    private suspend fun ApplicationTestBuilder.fixture(prefix: String, keys: List<String> = listOf("E2E")): Fixture {
        start()
        val w = planWorld(prefix, teams = true)
        val request = jbRequest(keys = keys)
        return Fixture(w, w.admin.client.jbConnection(request).id, request.siteUrl, request.apiToken!!)
    }

    private suspend fun Fixture.bind(level: JiraLevel, node: UInt, key: String): JiraBindingResponse =
        w.admin.client.jbBind(connectionId, level, node, key).jbBinding()

    @Test
    fun `the first run is a full read that observes every bound issue at its binding's level and moves no revision`() = testApplication {
        val f = fixture("jrfull")
        val admin = f.w.admin.client
        val bound = listOf(
            f.bind(JiraLevel.PROGRAM, f.w.programId, "E2E-1"), f.bind(JiraLevel.PROJECT, f.w.projectId, "E2E-2"),
            f.bind(JiraLevel.MILESTONE, f.milestone(), "E2E-5"), f.bind(JiraLevel.MILESTONE, f.milestone(), "E2E-9"),
            f.bind(JiraLevel.MILESTONE, f.milestone(), "E2E-6"),
        )
        bound.forEach { staleObservation(it.id) }
        val revision = TestPlan.revision()

        val run = runAndAwait(admin, f.connectionId)

        assertEquals(SyncOutcome.SUCCEEDED, run.outcome, run.errorDetail)
        assertNull(run.errorCode)
        assertEquals(f.w.admin.userId, run.requestedByUserId)
        assertEquals(listOf(5, 0), listOf(run.observedCount, run.goneCount))
        // tenant_info, the single full page, the single sweep page (e2e/fulltypes/eip/started and e2e/sweep/eip/started are 1 page each)
        // and the census's child-level read (e2e/fulltypes/s/started: an empty page - the E2E project has no stories).
        assertEquals(4, run.callCount)
        assertEquals(0, run.rateLimitedCount)
        assertEquals(revision, TestPlan.revision(), "a run bumps nothing")
        val seen = bound.associate { it.issueKey to admin.binding(it.id).observation }
        for ((key, observation) in seen) {
            val o = assertNotNull(observation, key)
            val planted = e2eIssue(key)
            assertEquals(planted.getValue("summary").jsonPrimitive.content, o.summary, "$key refreshed (it was stale)")
            assertTrue(o.observedAt > 1)
            assertFalse(o.gone)
            assertEquals(planted["start"]?.jsonPrimitive?.content?.takeIf { it != "null" }, o.startDate, "$key start")
            assertEquals(planted["end"]?.jsonPrimitive?.content?.takeIf { it != "null" }, o.endDate, "$key end")
        }
        assertEquals(listOf(3, 2, 1, 1, 1), bound.map { seen.getValue(it.issueKey)?.hierarchyLevel })
        assertNull(seen.getValue("E2E-9")?.startDate, "undated in Jira")
    }

    /** The real observer, but listing only [connectionId]: the shared database holds other tests' tested connections, not to be polled. */
    private class OnlyConnection(private val inner: Connector, private val connectionId: UInt) : Connector by inner {
        override suspend fun connections() = inner.connections().filter { it.id == connectionId }
    }

    @Test
    fun `a scheduled run observes the bound issues like a refresh, carries no user and audits no sync_requested`() = testApplication {
        val f = fixture("jrsched")
        val bound = listOf(f.bind(JiraLevel.PROJECT, f.w.projectId, "E2E-2"), f.bind(JiraLevel.MILESTONE, f.milestone(), "E2E-5"))
        bound.forEach { staleObservation(it.id) }
        val connectors = SyncConnectors().also { it.register(OnlyConnection(application.attributes[JiraObserverKey], f.connectionId)) }
        val runner = application.attributes[SyncRunnerKey]
        val runs = application.attributes[SyncRunServiceKey]
        val scheduler = SyncScheduler(runs, runner, connectors, tickMillis = 60_000, firstTickDelayMillis = 0)
        suspend fun listed() = jbJson.decodeFromString<SyncRunList>(
            f.w.admin.client.get("$SYNC_RUNS?kind=JIRA&connectionId=${f.connectionId}").bodyAsText(),
        ).items
        // The token is decrypted on a timer with no user behind it: neither the logs nor the audit trail may ever carry it.
        val root = LogCapture("ROOT")
        val polled = try {
            withAuditCapture { audit ->
                scheduler.tick()
                val started = listed().single()
                withTimeout(45_000) { runner.await(started.id) }
                assertTrue(audit.events.none { it.message == "jira.sync_requested" }, "a scheduled run is not a requested one")
                assertTrue(audit.events.none { f.token in it.formattedMessage || f.token in it.keyValuePairs.orEmpty().toString() })
                listed().single { it.id == started.id }
            }
        } finally {
            root.detach()
        }
        assertTrue(root.events.any { it.formattedMessage.startsWith("Scheduler started run") }, "the scheduler said what it started")
        assertTrue(
            root.events.none { e ->
                listOf(e.formattedMessage, e.throwableProxy?.message.orEmpty(), e.keyValuePairs.orEmpty().toString())
                    .any { f.token in it || "Basic " in it || "Bearer " in it }
            },
            "no log line of a scheduled run carries the token or an Authorization value",
        )

        assertEquals(SyncTrigger.SCHEDULED, polled.trigger)
        assertNull(polled.requestedByUserId)
        assertEquals(SyncOutcome.SUCCEEDED, polled.outcome, polled.errorDetail)
        assertEquals(listOf(2, 0), listOf(polled.observedCount, polled.goneCount))
        for (binding in bound) {
            val observed = assertNotNull(f.w.admin.client.binding(binding.id).observation, binding.issueKey)
            assertTrue(observed.observedAt > 1, "${binding.issueKey} was refreshed (it was stale)")
            assertEquals(e2eIssue(binding.issueKey).getValue("summary").jsonPrimitive.content, observed.summary)
        }
        // Not due again: the run just finished, so the next poll is an interval away.
        scheduler.tick()
        assertEquals(1, listed().size)
    }

    @Test
    fun `later runs are incremental, flag a vanished issue gone on day 2 and clear it when it is back`() = testApplication {
        val f = fixture("jrinc")
        val admin = f.w.admin.client
        val unchanged = f.bind(JiraLevel.MILESTONE, f.milestone(), "E2E-4")
        val changed = f.bind(JiraLevel.MILESTONE, f.milestone(), "E2E-5")
        val vanishing = f.bind(JiraLevel.MILESTONE, f.milestone(), "E2E-6")
        val first = runAndAwait(admin, f.connectionId)
        assertEquals(SyncOutcome.SUCCEEDED, first.outcome, first.errorDetail)
        assertEquals(3, first.observedCount, "the full read observed every bound id")
        listOf(unchanged, changed, vanishing).forEach { staleObservation(it.id) }
        val revision = TestPlan.revision()
        try {
            JiraStubServer.setScenarioState("jira-day2", "day2")
            val second = runAndAwait(admin, f.connectionId)
            assertEquals(SyncOutcome.SUCCEEDED, second.outcome, second.errorDetail)
            // Incremental: E2E-5 is one of the stub's two recently updated epics, E2E-4 is not, E2E-6 is deleted on day 2.
            assertEquals(listOf(1, 1), listOf(second.observedCount, second.goneCount))
            assertEquals(3, second.callCount, "tenant_info, the incremental page, the sweep page")
            assertEquals("E2E Epic Two", admin.binding(changed.id).observation?.summary, "re-read: it changed")
            assertEquals("stale", admin.binding(unchanged.id).observation?.summary, "only what the run read is overwritten")
            val gone = assertNotNull(admin.binding(vanishing.id).observation)
            assertEquals(true, gone.gone)
            assertEquals("OUT_OF_SCOPE", gone.goneReason)
            assertEquals("stale", gone.summary, "the content last read stays")

            JiraStubServer.resetScenarios()
            val third = runAndAwait(admin, f.connectionId)
            assertEquals(SyncOutcome.SUCCEEDED, third.outcome, third.errorDetail)
            // E2E-6 is back but unchanged, so the incremental does not return it: the sweep alone clears the flag.
            assertEquals(listOf(1, 0), listOf(third.observedCount, third.goneCount))
            val back = assertNotNull(admin.binding(vanishing.id).observation)
            assertFalse(back.gone)
            assertNull(back.goneReason)
            assertEquals("stale", back.summary, "its content was not re-read")
            assertEquals(revision, TestPlan.revision(), "runs bump nothing")
        } finally {
            JiraStubServer.resetScenarios()
        }
    }

    @Test
    fun `a re-discovery since the last run forces a full read, so an unchanged issue is read through the new snapshot`() = testApplication {
        val f = fixture("jrredisc")
        val admin = f.w.admin.client
        val unchanged = f.bind(JiraLevel.MILESTONE, f.milestone(), "E2E-4")
        assertEquals(SyncOutcome.SUCCEEDED, runAndAwait(admin, f.connectionId).outcome)
        staleObservation(unchanged.id)
        assertEquals("stale", admin.binding(unchanged.id).observation?.summary)
        assertEquals(SyncOutcome.SUCCEEDED, runAndAwait(admin, f.connectionId).outcome)
        assertEquals("stale", admin.binding(unchanged.id).observation?.summary, "incremental: an unchanged issue is not re-read")
        assertEquals(HttpStatusCode.OK, admin.post("$JB_CONNECTIONS/${f.connectionId}/test").status)
        assertEquals(SyncOutcome.SUCCEEDED, runAndAwait(admin, f.connectionId).outcome)
        assertEquals("E2E Epic One", admin.binding(unchanged.id).observation?.summary, "the new discovery made the run a full read")
    }

    @Test
    fun `after jira-day2 the sweep flags exactly the issues expected json says left the scope`() = testApplication {
        val sample = expected.getValue("scopes").jsonObject.getValue("sample").jsonArray.map { it.jsonPrimitive.content }
        val f = fixture("jrday2", keys = sample)
        val day2 = expected.getValue("day2").jsonObject
        val deleted = day2.getValue("deleted").jsonObject.getValue("keys").jsonArray.map { it.jsonPrimitive.content }
        val moved = day2.getValue("movedOut").jsonArray.map { it.jsonObject.getValue("key").jsonPrimitive.content }
        val gone = deleted + moved
        val recent = expected.getValue("incremental").jsonObject.getValue("epics").jsonArray.map { it.jsonPrimitive.content }
            .filter { it !in gone }.take(3)
        val search = expected.getValue("search").jsonObject
        fun pages(shape: String) = search.getValue(shape).jsonObject.getValue("pages").jsonPrimitive.content.toInt()

        val bound = (gone + recent).associateWith { f.bind(JiraLevel.MILESTONE, f.milestone(), it) }
        val admin = f.w.admin.client
        val first = runAndAwait(admin, f.connectionId)
        assertEquals(SyncOutcome.SUCCEEDED, first.outcome, first.errorDetail)
        val goneKeys = gone.joinToString(",") { "'$it'" }
        val censusOf = "SELECT count(*) FROM jira_issues WHERE connection_id = ? AND issue_key IN ($goneKeys)"
        assertEquals(gone.size, jbScalar(censusOf, f.connectionId.toInt()) { it.getInt(1) }, "the census holds every epic before day 2")
        assertEquals(bound.size, first.observedCount, "the full read observes every bound id (${bound.size})")
        assertEquals(0, first.goneCount)
        // The first run is full, so it also reads the child level in full (the census, 1.4).
        assertEquals(
            1 + pages("sample/fulltypes/eip/started") + pages("sample/sweep/eip/started") + pages("sample/fulltypes/s/started"),
            first.callCount,
        )
        recent.forEach { staleObservation(bound.getValue(it).id) }
        try {
            JiraStubServer.setScenarioState("jira-day2", "day2")
            val second = runAndAwait(admin, f.connectionId)
            assertEquals(SyncOutcome.SUCCEEDED, second.outcome, second.errorDetail)
            assertEquals(day2.getValue("inScopeDelta").jsonPrimitive.content.toInt(), second.goneCount, "expected.json's inScopeDelta")
            assertEquals(gone.size, second.goneCount)
            assertEquals(recent.size, second.observedCount, "only the recently updated bound epics are re-read")
            assertEquals(1 + pages("sample/incremental/any/day2") + pages("sample/sweep/eip/day2"), second.callCount)
            val flagged = bound.filter { (_, b) -> admin.binding(b.id).observation?.gone == true }.keys
            assertEquals(gone.toSet(), flagged, "exactly the 12 deleted and the 5 moved-out issues")
            assertEquals(0, jbScalar(censusOf, f.connectionId.toInt()) { it.getInt(1) }, "and the sweep removes them from the census")
            recent.forEach { assertFalse(admin.binding(bound.getValue(it).id).observation?.gone == true, it) }
        } finally {
            JiraStubServer.resetScenarios()
        }
    }

    @Test
    fun `the first run censuses the mapped levels and the stories - COV-3 has four children, two done, 13 points`() = testApplication {
        val cov = expected.getValue("cov").jsonObject
        val f = fixture("jrcov", keys = listOf("COV"))
        f.bind(JiraLevel.MILESTONE, f.milestone(), "COV-3")
        val run = runAndAwait(f.w.admin.client, f.connectionId)
        assertEquals(SyncOutcome.SUCCEEDED, run.outcome, run.errorDetail)
        // tenant_info, the full read and the sweep (1 page each), the child level's typed read (cov/fulltypes/s/started, 1 page).
        assertEquals(4, run.callCount)
        val mirror = "SELECT count(*) FROM jira_issues WHERE connection_id = ?"
        assertEquals(cov.getValue("issues").jsonArray.size, jbScalar(mirror, f.connectionId.toInt()) { it.getInt(1) }, "every COV issue")
        for ((epic, figures) in cov.getValue("rollups").jsonObject) {
            val parentId = cov.getValue("issues").jsonArray.map { it.jsonObject }
                .single { it.getValue("key").jsonPrimitive.content == epic }.getValue("id").jsonPrimitive.content
            val rolled = jbScalar(
                "SELECT count(*) || '/' || count(*) FILTER (WHERE status_category = 'DONE') || '/' || sum(points)::int " +
                    "FROM jira_issues WHERE connection_id = ? AND parent_issue_id = ?",
                f.connectionId.toInt(), parentId,
            ) { it.getString(1) }
            val want = figures.jsonObject.let { "${it.getValue("children")}/${it.getValue("done")}/${it.getValue("points")}" }
            assertEquals(want, rolled, "$epic rolls up")
        }
        assertNotNull(jbScalar("SELECT census_at FROM jira_connections WHERE id = ?", f.connectionId.toInt()) { it.getObject(1) })
    }

    @Test
    fun `the node sweep releases the bindings of a deleted project and of a node under a deleted ancestor, audited`() = testApplication {
        val f = fixture("jrnode")
        val admin = f.w.admin.client
        val sp = secondProject(f.w)
        val deadProject = f.bind(JiraLevel.PROJECT, sp.projectId, "E2E-3")
        val deadMilestone = f.bind(JiraLevel.MILESTONE, TestPlan.milestone(sp.projectId, f.w.requireTeams().teamId), "E2E-7")
        val control = f.bind(JiraLevel.MILESTONE, f.milestone(), "E2E-8")
        assertEquals(HttpStatusCode.NoContent, admin.delete("/api/v1/projects/${sp.projectId}").status)
        assertTrue(jbActive(deadProject.id) && jbActive(deadMilestone.id), "a node delete never touches bindings")
        withAuditCapture { audit ->
            val run = runAndAwait(admin, f.connectionId)
            assertEquals(SyncOutcome.SUCCEEDED, run.outcome, run.errorDetail)
            assertEquals(1, run.observedCount, "only the live binding is read")
            for (released in listOf(deadProject, deadMilestone)) {
                val event = assertNotNull(
                    audit.awaitEvent { it.message == "jira.binding_released" && it.hasKeyValue("bindingId", released.id.toLong()) },
                )
                assertTrue(event.hasKeyValue("reason", "NODE_GONE") && event.hasKeyValue("runId", run.id.toLong()))
                assertTrue(event.hasKeyValue("byUserId", f.w.admin.userId.toLong()))
                assertTrue(event.hasKeyValue("connectionId", f.connectionId.toLong()))
                assertFalse(jbActive(released.id), "released")
            }
        }
        assertTrue(jbActive(control.id))
        // The Jira item is free again for a live node.
        f.bind(JiraLevel.PROJECT, f.w.projectId, "E2E-3")
    }

    @Test
    fun `a binding under a deleted ancestor is released too, and a run with nothing left to read calls nobody`() = testApplication {
        val f = fixture("jranc")
        val project = f.bind(JiraLevel.PROJECT, f.w.projectId, "E2E-2")
        val milestone = f.bind(JiraLevel.MILESTONE, f.milestone(), "E2E-5")
        // The program is deleted underneath live children (the API would cascade; this is the residual window the sweep exists for).
        jbSql("UPDATE programs SET marked_as_deleted = true WHERE id = ?", f.w.programId.toInt())
        val run = runAndAwait(f.w.admin.client, f.connectionId)
        assertEquals(SyncOutcome.SUCCEEDED, run.outcome, run.errorDetail)
        assertFalse(jbActive(project.id))
        assertFalse(jbActive(milestone.id))
        assertEquals(listOf(0, 0, 0), listOf(run.observedCount, run.goneCount, run.callCount), "nothing bound: no Jira call at all")
    }
}
