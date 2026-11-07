package ch.nokillswit

import ch.nokillswit.jira.DiscoveredField
import ch.nokillswit.jira.DiscoveredIssueType
import ch.nokillswit.jira.DiscoveryMarkers
import ch.nokillswit.jira.JiraBindingResponse
import ch.nokillswit.jira.JiraCensus
import ch.nokillswit.jira.JiraDiscovery
import ch.nokillswit.jira.JiraIssueStore
import ch.nokillswit.jira.JiraEstimateMapping
import ch.nokillswit.jira.JiraLevel
import ch.nokillswit.jira.JiraLevelFields
import ch.nokillswit.jira.JiraLevelMapping
import ch.nokillswit.jira.JiraMapping
import ch.nokillswit.jira.JiraMappingLevels
import ch.nokillswit.sync.ClaimedRun
import ch.nokillswit.sync.SyncKind
import ch.nokillswit.sync.SyncOutcome
import ch.nokillswit.sync.SyncTrigger
import io.ktor.client.request.delete
import io.ktor.client.request.HttpRequestData
import io.ktor.http.HttpStatusCode
import io.ktor.server.testing.ApplicationTestBuilder
import io.ktor.server.testing.testApplication
import org.junit.BeforeClass
import java.util.concurrent.atomic.AtomicInteger
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * The census the run keeps (`jira_issues`, 1.4) over a scripted `MockEngine` (`MockJiraRun`): the child level's typed read and its fields,
 * a story an incremental page carries, the page ceiling, the prunes, the due id sweep, a milestone mapped to level 0 and a connection
 * disabled mid-census. The stub-backed figures are `JiraRunTest`'s. The connection is made against the stub (the Test connection needs
 * it); the runs never touch it.
 */
class JiraRunCensusTest {
    companion object {
        /** The stub discovery's non-sub-task types at Jira level 0 (Story, Task, Bug): what the child level's clause names. */
        private const val CHILD_TYPES = "10001,10002,10003"
        private const val HOUR = 3_600_000L

        @JvmStatic
        @BeforeClass
        fun warmStub() {
            JiraStubFixture.warm()
        }
    }

    private class Fixture(val w: PlanWorld, val connectionId: UInt) {
        suspend fun bind(key: String): JiraBindingResponse =
            w.admin.client.jbBind(connectionId, JiraLevel.MILESTONE, milestone(), key).jbBinding()

        private suspend fun milestone() = TestPlan.milestone(w.projectId, w.requireTeams().teamId)
    }

    private suspend fun ApplicationTestBuilder.fixture(prefix: String): Fixture {
        configureApp("jira.stubBaseUrl" to JiraStubFixture.warm(), "jira.maxRetries" to "0")
        startApplication()
        val w = planWorld(prefix, teams = true)
        return Fixture(w, w.admin.client.jbConnection(jbRequest()).id)
    }

    private fun HttpRequestData.jql() = url.parameters["jql"].orEmpty()

    private fun HttpRequestData.isIds() = url.parameters["fields"] == "id"

    private fun HttpRequestData.isChild() = CHILD_TYPES in jql()

    private fun HttpRequestData.isIncremental() = "updated >=" in jql()

    /** A story under epic 90005 as a search entry; [status] is the status category key (`done`, `indeterminate`, `new`). */
    private fun story(id: String, key: String, status: String = "done", points: Int = 3, summary: String = "Story $key") =
        """{"id":"$id","key":"$key","fields":{"summary":"$summary","issuetype":{"id":"10001","name":"Story","subtask":false,""" +
            """"hierarchyLevel":0},"status":{"name":"S","statusCategory":{"key":"$status"}},"parent":{"id":"90005","key":"E2E-5"},""" +
            """"updated":"2026-10-01T10:00:00.000+0000","customfield_10026":$points}}"""

    private fun mirrorIds(connectionId: UInt, level: Int): List<String> = jbScalar(
        "SELECT coalesce(string_agg(issue_id, ',' ORDER BY issue_id), '') FROM jira_issues WHERE connection_id = ? AND hierarchy_level = ?",
        connectionId.toInt(), level,
    ) { it.getString(1) }.split(',').filter { it.isNotEmpty() }

    private fun seed(connectionId: UInt, id: String, level: Int) = jbSql(
        "INSERT INTO jira_issues (connection_id, issue_id, issue_key, hierarchy_level, status_category, observed_at) " +
            "VALUES (?, ?, ?, ?, 'TODO', 1)",
        connectionId.toInt(), id, "OLD-$id", level,
    )

    private fun censusAt(connectionId: UInt): Long? =
        jbScalar("SELECT census_at FROM jira_connections WHERE id = ?", connectionId.toInt()) {
            rs -> rs.getLong(1).takeUnless { rs.wasNull() }
        }

    @Test
    fun `the child level is read typed with the points field, and an incremental story upserts its row with no extra call`() =
        testApplication {
            val f = fixture("jrcwire")
            f.bind("E2E-5")
            val mock = MockJiraRun(application) { request ->
                jsonOk(
                    when {
                        request.isIds() -> idsPage("90005")
                        request.isChild() -> searchPage(story("91001", "E2E-101"), story("91002", "E2E-102", "indeterminate", 5))
                        request.isIncremental() -> searchPage(issueDoc("90005", "E2E-5"), story("91003", "E2E-103", "new", 8))
                        else -> searchPage(issueDoc("90005", "E2E-5"))
                    },
                )
            }
            val first = mock.run(f.connectionId)
            assertEquals(SyncOutcome.SUCCEEDED, first.outcome, first.errorDetail)
            // tenant_info, the full read, its sweep, the child level's typed read.
            assertEquals(4, first.counts.calls)
            val child = mock.searches[2]
            assertEquals("""project in ("E2E") AND issuetype in ($CHILD_TYPES) ORDER BY id ASC""", child.jql())
            assertEquals(
                setOf("summary", "issuetype", "status", "parent", "updated", "customfield_10026"),
                child.url.parameters["fields"].orEmpty().split(',').toSet(), "the system fields and the discovery's story-points field",
            )
            assertEquals(listOf("91001", "91002"), mirrorIds(f.connectionId, 0))
            val row = "SELECT status_category || '/' || points || '/' || parent_issue_id FROM jira_issues " +
                "WHERE connection_id = ? AND issue_id = '91001'"
            assertEquals("DONE/3.00/90005", jbScalar(row, f.connectionId.toInt()) { it.getString(1) })

            val second = mock.run(f.connectionId)
            assertEquals(SyncOutcome.SUCCEEDED, second.outcome, second.errorDetail)
            assertEquals(3, second.counts.calls, "tenant_info, the incremental read, the sweep: the story rides the read for free")
            assertEquals(listOf("91001", "91002", "91003"), mirrorIds(f.connectionId, 0))
            assertEquals(listOf("90005"), mirrorIds(f.connectionId, 1))
        }

    @Test
    fun `a children read that hits the page ceiling keeps what it read, prunes nothing, stamps and warns, no summary`() = testApplication {
        val f = fixture("jrctrunc")
        f.bind("E2E-5")
        seed(f.connectionId, "91999", 0)
        val pages = AtomicInteger(0)
        val mock = MockJiraRun(application) { request ->
            jsonOk(
                when {
                    request.isIds() -> idsPage("90005")
                    request.isChild() -> {
                        val n = pages.incrementAndGet()
                        searchPage(story("${92000 + n}", "E2E-$n", summary = "Confidential summary"), next = "cursor-$n")
                    }
                    else -> searchPage(issueDoc("90005", "E2E-5"))
                },
            )
        }
        val warnings = LogCapture("ch.nokillswit.sync")
        try {
            val result = mock.run(f.connectionId)
            assertEquals(SyncOutcome.SUCCEEDED, result.outcome, result.errorDetail)
            assertEquals(1 + 1 + 1 + 200, result.counts.calls, "the ceiling is 200 pages")
            val children = mirrorIds(f.connectionId, 0)
            assertEquals(201, children.size, "the 200 pages read plus the stale row, which a truncated listing does not prune")
            assertTrue("91999" in children)
            assertNotNull(censusAt(f.connectionId), "stamped, so a big site is not re-read on every poll")
            val warn = warnings.events.single { "census truncated" in it.formattedMessage }
            assertEquals("WARN", warn.level.toString())
            assertTrue("200 pages" in warn.formattedMessage, warn.formattedMessage)
            assertTrue(warnings.events.none { "Confidential" in it.formattedMessage || "E2E-" in it.formattedMessage })
        } finally {
            warnings.detach()
        }
    }

    @Test
    fun `a full read prunes an empty children listing, a mapped issue not listed and a retired level, and nothing warns`() =
        testApplication {
            val f = fixture("jrcprune")
            f.bind("E2E-5")
            seed(f.connectionId, "90077", 1)
            seed(f.connectionId, "91999", 0)
            seed(f.connectionId, "90066", 7) // a level that is no census level (any more)
            val mock = MockJiraRun(application) { request ->
                jsonOk(
                    when {
                        request.isIds() -> idsPage("90005")
                        request.isChild() -> searchPage()
                        // An issue of a type the sweeps do not ask for is not mirrored (it would flap in and out).
                        else -> searchPage(issueDoc("90005", "E2E-5"), issueDoc("90006", "E2E-6", typeId = "10099"))
                    },
                )
            }
            val warnings = LogCapture("ch.nokillswit.sync")
            try {
                val result = mock.run(f.connectionId)
                assertEquals(SyncOutcome.SUCCEEDED, result.outcome, result.errorDetail)
                assertEquals(listOf("90005"), mirrorIds(f.connectionId, 1))
                assertEquals(emptyList(), mirrorIds(f.connectionId, 0) + mirrorIds(f.connectionId, 7))
                assertTrue(warnings.events.none { it.level.toString() == "WARN" }, "an empty listing is normal")
                val line = warnings.events.single { "census:" in it.formattedMessage }.formattedMessage
                assertTrue(line.endsWith("census: issues=1 children=0 pruned=3 childPass=FULL"), line)
            } finally {
                warnings.detach()
            }
        }

    @Test
    fun `a run after jira censusHours sweeps the child ids and restamps, one before does not`() = testApplication {
        val f = fixture("jrcdue")
        f.bind("E2E-5")
        val mock = MockJiraRun(application) { request ->
            jsonOk(
                when {
                    request.isIds() && request.isChild() -> idsPage("91001")
                    request.isIds() -> idsPage("90005")
                    request.isChild() -> searchPage(story("91001", "E2E-101"))
                    else -> searchPage(issueDoc("90005", "E2E-5"))
                },
            )
        }
        assertEquals(SyncOutcome.SUCCEEDED, mock.run(f.connectionId).outcome)
        seed(f.connectionId, "91002", 0) // a story deleted in Jira since: only a child sweep can notice
        val now = System.currentTimeMillis()

        jbSql("UPDATE jira_connections SET census_at = ? WHERE id = ?", now - 23 * HOUR, f.connectionId.toInt())
        assertEquals(SyncOutcome.SUCCEEDED, mock.run(f.connectionId).outcome)
        assertEquals(0, mock.searches.count { it.isIds() && it.isChild() }, "23 hours of 24: not due")
        assertEquals(listOf("91001", "91002"), mirrorIds(f.connectionId, 0))

        jbSql("UPDATE jira_connections SET census_at = ? WHERE id = ?", now - 25 * HOUR, f.connectionId.toInt())
        val swept = mock.run(f.connectionId)
        assertEquals(SyncOutcome.SUCCEEDED, swept.outcome, swept.errorDetail)
        assertEquals(1 + 1 + 1 + 1, swept.counts.calls, "tenant_info, the incremental read, the sweep, the child id sweep")
        assertEquals(1, mock.searches.count { it.isIds() && it.isChild() })
        assertEquals(listOf("91001"), mirrorIds(f.connectionId, 0), "the sweep prunes the story Jira no longer lists")
        assertTrue(assertNotNull(censusAt(f.connectionId)) >= now, "restamped with the run's start")
    }

    @Test
    fun `a milestone level mapped to Jira level 0 reads no children, and the full read still stamps`() = testApplication {
        val f = fixture("jrclevel0")
        f.bind("E2E-5")
        val level0 = JiraMapping(
            JiraMappingLevels(
                milestone = JiraLevelMapping(0, JiraLevelFields("customfield_10022", "customfield_10023", "customfield_10026")),
            ),
            JiraEstimateMapping(), null,
        )
        assertEquals(HttpStatusCode.NoContent, f.w.admin.client.putJson("$JB_CONNECTIONS/${f.connectionId}/mapping", level0).status)
        val mock = MockJiraRun(application) { request ->
            jsonOk(if (request.isIds()) idsPage("90005") else searchPage(issueDoc("90005", "E2E-5")))
        }
        val result = mock.run(f.connectionId)
        assertEquals(SyncOutcome.SUCCEEDED, result.outcome, result.errorDetail)
        assertEquals(3, result.counts.calls, "tenant_info, the read, the sweep: no child level below level 0")
        assertEquals(emptyList(), mirrorIds(f.connectionId, 1) + mirrorIds(f.connectionId, 0), "the epic is not at a mapped level now")
        assertNotNull(censusAt(f.connectionId), "else census_at stays null and every run would be a full read")
    }

    @Test
    fun `a connection disabled before the first children page ends CONNECTION_DISABLED with no children request and no stamp`() =
        testApplication {
            val f = fixture("jrcdisabled")
            f.bind("E2E-5")
            val mock = MockJiraRun(application) { request ->
                if (request.isIds()) jbSql("UPDATE jira_connections SET enabled = false WHERE id = ?", f.connectionId.toInt())
                jsonOk(if (request.isIds()) idsPage("90005") else searchPage(issueDoc("90005", "E2E-5")))
            }
            val result = mock.run(f.connectionId)
            assertEquals(SyncOutcome.FAILED, result.outcome)
            assertEquals("CONNECTION_DISABLED", result.errorCode)
            assertTrue(mock.searches.none { it.isChild() }, "the stored token is not used for one more read")
            assertNull(censusAt(f.connectionId))
        }

    @Test
    fun `the mapped read asks for the points field even when the estimate is mapped elsewhere, so an incremental story keeps its points`() =
        testApplication {
            val f = fixture("jrcpoints")
            f.bind("E2E-5")
            val elsewhere = JiraMapping(
                JiraMappingLevels(
                    milestone = JiraLevelMapping(1, JiraLevelFields("customfield_10022", "customfield_10023", "customfield_10016")),
                ),
                JiraEstimateMapping(), null,
            )
            assertEquals(HttpStatusCode.NoContent, f.w.admin.client.putJson("$JB_CONNECTIONS/${f.connectionId}/mapping", elsewhere).status)
            val mock = MockJiraRun(application) { request ->
                jsonOk(
                    when {
                        request.isIds() -> idsPage("90005")
                        request.isChild() -> searchPage(story("91001", "E2E-101", points = 3))
                        request.isIncremental() -> searchPage(story("91001", "E2E-101", points = 5))
                        else -> searchPage(issueDoc("90005", "E2E-5"))
                    },
                )
            }
            assertEquals(SyncOutcome.SUCCEEDED, mock.run(f.connectionId).outcome)
            assertEquals(SyncOutcome.SUCCEEDED, mock.run(f.connectionId).outcome)
            val asked = mock.searches[3].url.parameters["fields"].orEmpty().split(',')
            assertTrue("customfield_10026" in asked && "customfield_10016" in asked, "the marker and the mapped estimate: $asked")
            val points = "SELECT points::text FROM jira_issues WHERE connection_id = ? AND issue_id = '91001'"
            assertEquals("5.00", jbScalar(points, f.connectionId.toInt()) { it.getString(1) })
        }

    @Test
    fun `a sweep that lists an issue the mirror lacks clears census_at, so the next run is full and re-seeds`() = testApplication {
        val f = fixture("jrcgap")
        f.bind("E2E-5")
        val mock = MockJiraRun(application) { request ->
            jsonOk(
                when {
                    request.isIds() -> idsPage("90005")
                    request.isChild() || request.isIncremental() -> searchPage()
                    else -> searchPage(issueDoc("90005", "E2E-5"))
                },
            )
        }
        assertEquals(SyncOutcome.SUCCEEDED, mock.run(f.connectionId).outcome)
        assertNotNull(censusAt(f.connectionId))
        // The row a false-empty sweep once pruned:
        jbSql("DELETE FROM jira_issues WHERE connection_id = ? AND issue_id = '90005'", f.connectionId.toInt())
        assertEquals(SyncOutcome.SUCCEEDED, mock.run(f.connectionId).outcome) // incremental: reads nothing, the sweep lists 90005
        assertNull(censusAt(f.connectionId), "cleared: the mirror lacks a listed issue")
        assertEquals(SyncOutcome.SUCCEEDED, mock.run(f.connectionId).outcome)
        assertEquals(2, mock.searches.count { !it.isIds() && "10006,10005,10004" in it.jql() }, "the third run is a full read")
        assertEquals(listOf("90005"), mirrorIds(f.connectionId, 1))
        assertNotNull(censusAt(f.connectionId))
    }

    @Test
    fun `a children read that fails mid-way does not fail the run, keeps its rows, prunes and stamps nothing and warns the code`() =
        testApplication {
            val f = fixture("jrcfail")
            f.bind("E2E-5")
            seed(f.connectionId, "91999", 0)
            val childPages = AtomicInteger(0)
            val mock = MockJiraRun(application) { request ->
                when {
                    request.isIds() -> jsonOk(idsPage("90005"))
                    request.isChild() -> when (childPages.incrementAndGet()) {
                        1 -> jsonOk(searchPage(story("91001", "E2E-101"), next = "p2"))
                        else -> failure(HttpStatusCode.ServiceUnavailable)
                    }
                    else -> jsonOk(searchPage(issueDoc("90005", "E2E-5")))
                }
            }
            val warnings = LogCapture("ch.nokillswit.sync")
            try {
                val result = mock.run(f.connectionId)
                assertEquals(SyncOutcome.SUCCEEDED, result.outcome, result.errorDetail)
                assertEquals(listOf("91001", "91999"), mirrorIds(f.connectionId, 0), "no child prune on a failed read")
                assertNull(censusAt(f.connectionId), "no stamp: the next run is full and retries")
                val warn = warnings.events.single { "children census failed" in it.formattedMessage }
                assertTrue("UPSTREAM_UNAVAILABLE" in warn.formattedMessage && "E2E-" !in warn.formattedMessage, warn.formattedMessage)
            } finally {
                warnings.detach()
            }
        }

    @Test
    fun `a connection deleted between the sweep and the children read ends CONNECTION_GONE, no stamp, no mirror rows`() = testApplication {
        val f = fixture("jrcgone")
        f.bind("E2E-5")
        val mock = MockJiraRun(application) { request ->
            if (request.isIds()) {
                assertEquals(HttpStatusCode.NoContent, f.w.admin.client.delete("$JB_CONNECTIONS/${f.connectionId}").status)
            }
            jsonOk(if (request.isIds()) idsPage("90005") else searchPage(issueDoc("90005", "E2E-5")))
        }
        val result = mock.run(f.connectionId)
        assertEquals(SyncOutcome.FAILED, result.outcome)
        assertEquals("CONNECTION_GONE", result.errorCode)
        assertTrue(mock.searches.none { it.isChild() })
        assertNull(censusAt(f.connectionId))
        assertEquals(0, jbScalar("SELECT count(*) FROM jira_issues WHERE connection_id = ?", f.connectionId.toInt()) { it.getInt(1) })
    }

    @Test
    fun `a malformed story-points marker is never requested, and a child type id no JQL clause can name leaves no child level`() {
        fun census(marker: String, storyId: String): JiraCensus {
            val types = listOf(DiscoveredIssueType(storyId, "Story", 0, false), DiscoveredIssueType("10004", "Epic", 1, false))
            val discovery = JiraDiscovery(
                discoveredAt = 1, fieldCount = 0, issueTypeCount = 2, fieldsTruncated = false, fields = emptyList(), issueTypes = types,
                levels = emptyList(), markers = DiscoveryMarkers(storyPoints = DiscoveredField(marker, "Story Points", "number", null)),
            )
            val mapping = JiraMapping(JiraMappingLevels(milestone = JiraLevelMapping(1, JiraLevelFields())))
            val run = ClaimedRun(1u, SyncKind.JIRA, 1u, SyncTrigger.MANUAL, null, 0L)
            return JiraCensus(JiraIssueStore(sharedDatabaseForTests()), run, listOf("E2E"), discovery, mapping, listOf("10004"), { 0L })
        }
        val odd = census("customfield_1,summary", "abc")
        assertEquals("summary,issuetype,status,parent,updated", odd.childFields, "a marker that is no field id is not requested")
        assertEquals("a,b", odd.withPointsField("a,b"))
        assertNull(odd.childLevel)
        assertTrue(odd.childTypeIds.isEmpty(), "a non-numeric type id cannot join a JQL clause: no child request is ever made")
        val fine = census("customfield_10026", "10001")
        assertEquals("summary,issuetype,status,parent,updated,customfield_10026", fine.childFields)
        assertEquals("a,customfield_10026", fine.withPointsField("a"))
        assertEquals("a,customfield_10026", fine.withPointsField("a,customfield_10026"))
        assertEquals(listOf("10001"), fine.childTypeIds)
    }
}
