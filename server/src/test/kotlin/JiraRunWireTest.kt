package ch.nokillswit

import ch.nokillswit.jira.JiraBindCommand
import ch.nokillswit.jira.JiraBindingResponse
import ch.nokillswit.jira.JiraConnectionRequest
import ch.nokillswit.jira.JiraBindingServiceKey
import ch.nokillswit.jira.JiraEstimateMapping
import ch.nokillswit.jira.JiraLevel
import ch.nokillswit.jira.JiraLevelFields
import ch.nokillswit.jira.JiraLevelMapping
import ch.nokillswit.jira.JiraMapping
import ch.nokillswit.jira.JiraMappingLevels
import ch.nokillswit.sync.SyncOutcome
import ch.nokillswit.sync.SyncResult
import io.ktor.client.HttpClient
import io.ktor.client.request.get
import io.ktor.client.statement.bodyAsText
import io.ktor.http.HttpStatusCode
import io.ktor.server.testing.ApplicationTestBuilder
import io.ktor.server.testing.testApplication
import org.junit.BeforeClass
import java.time.LocalDate
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNotNull
import kotlin.test.assertTrue

/**
 * The run's wire and its edge cases, with the REAL observer, services and client over a scripted Ktor `MockEngine` (`MockJiraRun`): what
 * the client actually puts on the wire - the shared stub returns every field whatever `fields` asks for, so a field the run forgot to
 * request would pass every stub-backed test and read null on a real site - and what a run does with a binding, a mapping or a token that
 * is not what it expects. The connection, its discovery and its bindings are made through the API against the stub (the Test connection
 * needs it); the run itself never touches the stub, so these tests flip no scenario.
 */
class JiraRunWireTest {
    companion object {
        @JvmStatic
        @BeforeClass
        fun warmStub() {
            JiraStubFixture.warm()
        }

        /** A statement that changes nothing: the "restore" of a step that needs none. */
        private const val NOOP = "UPDATE jira_connections SET enabled = enabled WHERE id = ?"
        private const val PROGRAM_TYPE = "10006"
        private const val PROJECT_TYPE = "10005"
        private val PLAN_FIELDS = JiraMapping(
            JiraMappingLevels(
                program = JiraLevelMapping(3, JiraLevelFields("customfield_10015", "duedate", "customfield_10016")),
                project = JiraLevelMapping(2, JiraLevelFields("customfield_10015", "duedate", null)),
                milestone = JiraLevelMapping(1, JiraLevelFields("customfield_10022", "customfield_10023", "customfield_10026")),
            ),
            JiraEstimateMapping(),
            "customfield_10001",
        )
    }

    private class Fixture(val w: PlanWorld, val connectionId: UInt, val request: JiraConnectionRequest) {
        val admin: HttpClient get() = w.admin.client

        suspend fun milestone() = TestPlan.milestone(w.projectId, w.requireTeams().teamId, planName("ms"))

        suspend fun bind(level: JiraLevel, node: UInt, key: String): JiraBindingResponse =
            admin.jbBind(connectionId, level, node, key).jbBinding()

        suspend fun binding(id: UInt): JiraBindingResponse =
            jbJson.decodeFromString(admin.get("$JB_BINDINGS/$id").also { assertEquals(HttpStatusCode.OK, it.status) }.bodyAsText())
    }

    private suspend fun ApplicationTestBuilder.fixture(prefix: String): Fixture {
        configureApp("jira.stubBaseUrl" to JiraStubFixture.warm(), "jira.maxRetries" to "0")
        startApplication()
        val w = planWorld(prefix, teams = true)
        val request = jbRequest()
        return Fixture(w, w.admin.client.jbConnection(request).id, request)
    }

    private val ApplicationTestBuilder.mockApp get() = application

    private fun MockJiraRun.fieldsAsked(index: Int): Set<String> = searches[index].url.parameters["fields"].orEmpty().split(',').toSet()

    private fun summaryOf(bindingId: UInt): String? =
        jbScalar("SELECT summary FROM jira_observations WHERE binding_id = ?", bindingId.toInt()) { it.getString(1) }

    private fun dates(start: String?, end: String?) = listOfNotNull(
        start?.let { """"customfield_10022":"$it"""" }, end?.let { """"customfield_10023":"$it"""" },
    ).joinToString(",")

    // --- the fields string ------------------------------------------------------------------------------------------------------------

    @Test
    fun `the requested fields name the system fields and the date, estimate and team field of EVERY mapped level, on both kinds of read`() =
        testApplication {
            val f = fixture("jrwfields")
            assertEquals(HttpStatusCode.NoContent, f.admin.putJson("$JB_CONNECTIONS/${f.connectionId}/mapping", PLAN_FIELDS).status)
            val program = f.bind(JiraLevel.PROGRAM, f.w.programId, "E2E-1")
            val project = f.bind(JiraLevel.PROJECT, f.w.projectId, "E2E-2")
            val milestone = f.bind(JiraLevel.MILESTONE, f.milestone(), "E2E-5")
            // Every field a level could read carries a DIFFERENT value, so the observation shows which field each level really read.
            val common = """"customfield_10015":"2044-01-01","customfield_10022":"2044-02-02","customfield_10023":"2044-02-20",""" +
                """"duedate":"2044-03-03","""
            val programFields = """"customfield_10016":7.5,"customfield_10001":{"name":"Team A"}"""
            val milestoneFields = """"customfield_10026":4.255,"customfield_10001":{"name":"Team B"}"""
            val docs = listOf(
                issueDoc("90001", "E2E-1", PROGRAM_TYPE, "Program", 3, fields = common + programFields),
                issueDoc("90002", "E2E-2", PROJECT_TYPE, "Initiative", 2, fields = common + """"customfield_10016":9"""),
                issueDoc("90005", "E2E-5", fields = common + milestoneFields),
            )
            val mock = MockJiraRun(mockApp) { request ->
                val sweep = request.url.parameters["fields"] == "id"
                jsonOk(if (sweep) idsPage("90001", "90002", "90005") else searchPage(*docs.toTypedArray()))
            }

            val full = mock.run(f.connectionId)
            assertEquals(SyncOutcome.SUCCEEDED, full.outcome, full.errorDetail)
            val wanted = setOf(
                "summary", "issuetype", "status", "parent", "updated",
                "customfield_10015", "duedate", "customfield_10016", "customfield_10022", "customfield_10023", "customfield_10026",
                "customfield_10001",
            )
            assertEquals(wanted, mock.fieldsAsked(0), "the full read")
            // The full read names the mapped types - the sweep's clause - and differs from the sweep only in its fields.
            assertEquals(
                "project in (\"E2E\") AND issuetype in (10006,10005,10004) ORDER BY id ASC", mock.searches[0].url.parameters["jql"],
            )
            assertEquals("id", mock.searches[1].url.parameters["fields"], "the sweep asks for ids only")
            assertEquals(
                "project in (\"E2E\") AND issuetype in (10006,10005,10004) ORDER BY id ASC", mock.searches[1].url.parameters["jql"],
            )

            val incremental = mock.run(f.connectionId)
            assertEquals(SyncOutcome.SUCCEEDED, incremental.outcome, incremental.errorDetail)
            assertEquals(wanted, mock.fieldsAsked(2), "the incremental read")
            val watermark = Regex("""project in \("E2E"\) AND updated >= "-\d+m" ORDER BY updated ASC""")
            assertTrue(watermark.matches(mock.searches[2].url.parameters["jql"].orEmpty()))

            // Each level read ITS fields: program 10015/duedate/10016, project 10015/duedate/-, milestone 10022/10023/10026.
            val seen = listOf(program, project, milestone).map { f.binding(it.id).observation }.map { assertNotNull(it) }
            val read = seen.map { it.startDate to it.endDate }
            assertEquals(listOf("2044-01-01" to "2044-03-03", "2044-01-01" to "2044-03-03", "2044-02-02" to "2044-02-20"), read)
            assertEquals(listOf(7.5, null, 4.26), seen.map { it.estimate })
            assertEquals(listOf("Team A", null, "Team B"), seen.map { it.teamName })
        }

    @Test
    fun `an observation is built at the level of the BINDING, not of the issue's own type`() = testApplication {
        val f = fixture("jrwlevel")
        assertEquals(HttpStatusCode.NoContent, f.admin.putJson("$JB_CONNECTIONS/${f.connectionId}/mapping", PLAN_FIELDS).status)
        // A project bound to an Epic: the bind route refuses it (the level check), so the binding is made through the service, as a
        // mapping change after a bind leaves it. The run must read the PROJECT level's fields and still report the issue's own level 1.
        val node = f.w.projectId
        val seed = seedObservation(
            issueId = "90005", issueKey = "E2E-5", summary = "seed",
        )
        val command = JiraBindCommand(f.connectionId, JiraLevel.PROJECT, node, seed, f.w.admin.userId)
        val bound = mockApp.attributes[JiraBindingServiceKey].bind(command) { }
        val mock = MockJiraRun(mockApp) { request ->
            jsonOk(
                if (request.url.parameters["fields"] == "id") {
                    idsPage("90005")
                } else {
                    val projectFields = """"customfield_10015":"2044-01-25","duedate":"2044-03-01""""
                    searchPage(issueDoc("90005", "E2E-5", fields = dates("2044-02-01", "2044-02-10") + "," + projectFields))
                },
            )
        }
        assertEquals(SyncOutcome.SUCCEEDED, mock.run(f.connectionId).outcome)
        val observation = assertNotNull(f.binding(bound.binding.id).observation)
        assertEquals(listOf("2044-01-25", "2044-03-01", 1), listOf(observation.startDate, observation.endDate, observation.hierarchyLevel))
    }

    // --- a run that cannot start makes no call ------------------------------------------------------------------------------------------

    private fun column(id: UInt, name: String): String =
        jbScalar("SELECT $name::text FROM jira_connections WHERE id = ?", id.toInt()) { it.getString(1) }

    private suspend fun Fixture.expectFailure(
        mock: MockJiraRun,
        code: String,
        breakIt: String,
        restore: String,
        detail: String? = null,
    ): SyncResult {
        jbSql(breakIt, connectionId.toInt())
        val result = mock.run(connectionId)
        jbSql(restore, connectionId.toInt())
        assertEquals(SyncOutcome.FAILED, result.outcome, "$code: ${result.errorDetail}")
        assertEquals(code, result.errorCode)
        detail?.let { assertTrue(it in result.errorDetail.orEmpty(), result.errorDetail) }
        assertEquals(0, result.counts.calls)
        assertTrue(mock.requests.isEmpty(), "$code: no request may reach the site")
        return result
    }

    @Test
    fun `a stale, unreadable or missing mapping or discovery fails the run typed with no call, the mapping untouched`() = testApplication {
        val f = fixture("jrwbroken")
        f.bind(JiraLevel.MILESTONE, f.milestone(), "E2E-5")
        val mock = MockJiraRun(mockApp) { error("no request expected") }
        val storedMapping = """{"levels":{"milestone":{"hierarchyLevel":7}}}"""
        jbSql("UPDATE jira_connections SET mapping = ?::jsonb WHERE id = ?", storedMapping, f.connectionId.toInt())
        val before = column(f.connectionId, "mapping")
        // A level no issue type sits at: the sweep's type list would be empty and JiraJql would throw - the run must stop before that.
        f.expectFailure(mock, "MAPPING_INVALID", NOOP, NOOP, detail = "hierarchy level 7")
        assertEquals(before, column(f.connectionId, "mapping"), "a stale mapping is never rewritten")
        f.expectFailure(
            mock, "MAPPING_UNREADABLE", "UPDATE jira_connections SET mapping = '{\"levels\":5}'::jsonb WHERE id = ?",
            "UPDATE jira_connections SET mapping = '{}'::jsonb WHERE id = ?",
        )
        f.expectFailure(
            mock, "NOT_DISCOVERED", "UPDATE jira_connections SET discovery = NULL WHERE id = ?", NOOP,
        )
    }

    @Test
    fun `an undecryptable token is a typed run error, never an exception - and so is a disabled or deleted connection`() = testApplication {
        val f = fixture("jrwtoken")
        f.bind(JiraLevel.MILESTONE, f.milestone(), "E2E-5")
        val mock = MockJiraRun(mockApp) { error("no request expected") }
        val token = column(f.connectionId, "api_token")
        // The AEAD tag of a ciphertext from another DATA_ENCRYPTION_KEY does not verify (AEADBadTagException inside the cipher).
        val foreign = token.dropLast(4) + "AAAA"
        f.expectFailure(mock, "TOKEN_UNREADABLE", "UPDATE jira_connections SET api_token = '$foreign' WHERE id = ?", NOOP)
        f.expectFailure(
            mock, "TOKEN_UNREADABLE", "UPDATE jira_connections SET api_token = 'enc:v1:not-a-real-envelope' WHERE id = ?",
            "UPDATE jira_connections SET api_token = '$token' WHERE id = ?",
        )
        f.expectFailure(
            mock, "CONNECTION_DISABLED", "UPDATE jira_connections SET enabled = false WHERE id = ?",
            "UPDATE jira_connections SET enabled = true WHERE id = ?",
        )
        f.expectFailure(
            mock, "CONNECTION_GONE", "UPDATE jira_connections SET marked_as_deleted = true WHERE id = ?",
            "UPDATE jira_connections SET marked_as_deleted = false WHERE id = ?",
        )
    }

    @Test
    fun `a connection with no bindings succeeds without a single call, and a run persists the cloud id it resolved`() = testApplication {
        val f = fixture("jrwempty")
        val mock = MockJiraRun(mockApp) { error("no request expected") }
        val empty = mock.run(f.connectionId)
        assertEquals(SyncOutcome.SUCCEEDED, empty.outcome)
        assertEquals(0, empty.counts.calls)
        assertTrue(mock.requests.isEmpty())

        f.bind(JiraLevel.MILESTONE, f.milestone(), "E2E-5")
        jbSql("UPDATE jira_connections SET cloud_id = NULL WHERE id = ?", f.connectionId.toInt())
        val reading = MockJiraRun(mockApp) { jsonOk(searchPage()) }
        assertEquals(SyncOutcome.SUCCEEDED, reading.run(f.connectionId).outcome)
        assertEquals("aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee", column(f.connectionId, "cloud_id"))
    }

    // --- writes -------------------------------------------------------------------------------------------------------------------

    @Test
    fun `values over a column's width are fitted, so one odd issue never fails a chunk or a later run`() = testApplication {
        val f = fixture("jrwclamp")
        val binding = f.bind(JiraLevel.MILESTONE, f.milestone(), "E2E-5")
        val doc = issueDoc(
            "90005", "E2E-5", summary = "s".repeat(400),
            fields = """"customfield_10001":{"name":"${"t".repeat(300)}"},"customfield_10026":1e12,"customfield_10022":"2044-02-01"""",
        )
        val mock = MockJiraRun(mockApp) { request ->
            jsonOk(if (request.url.parameters["fields"] == "id") searchPage("""{"id":"90005"}""") else searchPage(doc))
        }
        repeat(2) {
            val result = mock.run(f.connectionId)
            assertEquals(SyncOutcome.SUCCEEDED, result.outcome, result.errorDetail)
            assertEquals(1, result.counts.observed)
        }
        val o = assertNotNull(f.binding(binding.id).observation)
        assertEquals(255, o.summary?.length)
        assertEquals(100, o.teamName?.length)
        assertEquals(null, o.estimate, "a figure that does not fit NUMERIC(12,2) is not observed")
        assertEquals("2044-02-01", o.startDate)
    }

    @Test
    fun `a binding unbound or created while the run is in flight is neither resurrected nor read, and fails nothing`() = testApplication {
        val f = fixture("jrwrace")
        val unbound = f.bind(JiraLevel.MILESTONE, f.milestone(), "E2E-5")
        val seed = seedObservation(
            issueId = "90007", issueKey = "E2E-7", summary = "bind-time", startDate = LocalDate.parse("2044-03-01"),
        )
        val newNode = f.milestone()
        var lateBinding: UInt? = null
        val mock = MockJiraRun(mockApp) { request ->
            if (request.url.parameters["fields"] != "id" && lateBinding == null) {
                // Mid-run: the first binding is unbound (as DELETE /bindings/{id} does) and another is created (as POST does).
                jbSql("UPDATE jira_bindings SET marked_as_deleted = true WHERE id = ?", unbound.id.toInt())
                val command = JiraBindCommand(f.connectionId, JiraLevel.MILESTONE, newNode, seed, f.w.admin.userId)
                lateBinding = mockApp.attributes[JiraBindingServiceKey].bind(command) { }.binding.id
            }
            jsonOk(
                if (request.url.parameters["fields"] == "id") {
                    idsPage("90005", "90007")
                } else {
                    searchPage(issueDoc("90005", "E2E-5", summary = "from-run"), issueDoc("90007", "E2E-7", summary = "from-run"))
                },
            )
        }
        val staleBefore = summaryOf(unbound.id)
        val result = mock.run(f.connectionId)
        assertEquals(SyncOutcome.SUCCEEDED, result.outcome, result.errorDetail)
        assertEquals(0, result.counts.observed, "the unbound one is skipped, the new one is not in the run-start set")
        assertEquals(0, result.counts.gone)
        assertFalse(jbActive(unbound.id), "not resurrected")
        assertEquals(staleBefore, summaryOf(unbound.id))
        val late = checkNotNull(lateBinding)
        assertEquals("bind-time", summaryOf(late))
        // The next run picks the new binding up.
        assertEquals(1, mock.run(f.connectionId).counts.observed)
        assertEquals("from-run", summaryOf(late))
    }

    @Test
    fun `a changed mapping or an edited connection makes the next run a full read, an identical PUT does not`() = testApplication {
        val f = fixture("jrwwatermark")
        f.bind(JiraLevel.MILESTONE, f.milestone(), "E2E-5")
        val mock = MockJiraRun(mockApp) { request ->
            jsonOk(if (request.url.parameters["fields"] == "id") idsPage("90005") else searchPage(issueDoc("90005", "E2E-5")))
        }
        // Every run makes two searches (the read, then the sweep); `kinds` is the read's JQL shape per run so far.
        fun kinds(): List<String> = mock.searches.map { it.url.parameters["jql"].orEmpty() }.filterIndexed { i, _ -> i % 2 == 0 }
            .map { if ("updated >=" in it) "incremental" else "full" }
        suspend fun run() = assertEquals(SyncOutcome.SUCCEEDED, mock.run(f.connectionId).outcome)

        run() // no earlier run: full
        run() // nothing changed: incremental
        assertEquals(HttpStatusCode.NoContent, f.admin.putJson("$JB_CONNECTIONS/${f.connectionId}/mapping", PLAN_FIELDS).status)
        run() // the mapping changed: full
        run() // and then incremental again
        assertEquals(HttpStatusCode.NoContent, f.admin.putJson("$JB_CONNECTIONS/${f.connectionId}/mapping", PLAN_FIELDS).status)
        run() // an identical PUT changes nothing
        val widened = f.request.copy(apiToken = null, projectKeys = listOf("E2E", "CE"))
        assertEquals(HttpStatusCode.NoContent, f.admin.putJson("$JB_CONNECTIONS/${f.connectionId}", widened).status)
        run() // a widened scope: full
        run() // and then incremental again
        assertEquals(
            listOf("full", "incremental", "full", "incremental", "incremental", "full", "incremental"), kinds(),
        )
    }

    @Test
    fun `an issue the run just read is never flagged gone, nor one of a type the sweep does not ask for`() = testApplication {
        val f = fixture("jrwgone")
        val unchanged = f.bind(JiraLevel.MILESTONE, f.milestone(), "E2E-4")
        val changed = f.bind(JiraLevel.MILESTONE, f.milestone(), "E2E-5")
        var pages: (Boolean) -> String = { _ -> searchPage() }
        val mock = MockJiraRun(mockApp) { request -> jsonOk(pages(request.url.parameters["fields"] == "id")) }
        fun ids(vararg ids: String) = idsPage(*ids)
        fun goneOf(id: UInt) = jbScalar("SELECT gone FROM jira_observations WHERE binding_id = ?", id.toInt()) { it.getBoolean(1) }

        // Run 1 (full): both read, both in the sweep.
        pages = { sweep -> if (sweep) ids("90004", "90005") else searchPage(issueDoc("90004", "E2E-4"), issueDoc("90005", "E2E-5")) }
        assertEquals(2, mock.run(f.connectionId).counts.observed)
        // Run 2 (incremental): E2E-5 changed and is read, yet the sweep no longer lists it: it was just read, so it is not gone.
        pages = { sweep -> if (sweep) ids("90004") else searchPage(issueDoc("90005", "E2E-5")) }
        val second = mock.run(f.connectionId)
        assertEquals(listOf(1, 0), listOf(second.counts.observed, second.counts.gone))
        assertFalse(goneOf(changed.id))
        // Run 3: nothing changed and the sweep lists only E2E-5: E2E-4 vanished.
        pages = { sweep -> if (sweep) ids("90005") else searchPage() }
        val third = mock.run(f.connectionId)
        assertEquals(listOf(0, 1), listOf(third.counts.observed, third.counts.gone))
        assertTrue(goneOf(unchanged.id))
        assertFalse(goneOf(changed.id))
        // Run 4: E2E-5's last observed type is not one the sweep asks for (a type created after the last Test connection, say): the sweep
        // cannot see it whether or not it exists, so it cannot say it is gone. E2E-4 is still missing.
        jbSql("UPDATE jira_observations SET type_id = '99999' WHERE binding_id = ?", changed.id.toInt())
        pages = { sweep -> if (sweep) ids() else searchPage() }
        val fourth = mock.run(f.connectionId)
        assertEquals(1, fourth.counts.gone, "only E2E-4")
        assertFalse(goneOf(changed.id))
        assertTrue(goneOf(unchanged.id))
        // Run 5: a type nobody recorded at all is just as unjudgeable.
        jbSql("UPDATE jira_observations SET type_id = NULL WHERE binding_id = ?", changed.id.toInt())
        assertEquals(1, mock.run(f.connectionId).counts.gone)
        assertFalse(goneOf(changed.id))
    }
}
