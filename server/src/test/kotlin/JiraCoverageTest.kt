package ch.nokillswit

import ch.nokillswit.jira.JiraCoverageLevel
import ch.nokillswit.jira.JiraCoverageResponse
import ch.nokillswit.jira.JiraCoverageState
import ch.nokillswit.jira.JiraLevel
import ch.nokillswit.jira.JiraLevelMapping
import ch.nokillswit.jira.JiraMapping
import ch.nokillswit.jira.JiraMappingLevels
import ch.nokillswit.jira.JiraStatusCategory
import ch.nokillswit.jira.toStoredJson
import ch.nokillswit.users.UserRole
import io.ktor.client.HttpClient
import io.ktor.client.request.get
import io.ktor.client.statement.bodyAsText
import io.ktor.http.HttpStatusCode
import io.ktor.server.testing.testApplication
import org.junit.After
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull

/**
 * `GET /integrations/jira/connections/{id}/coverage` (1.14) on a seeded world: the census mirror rows go in through the store the run
 * uses, the bindings are raw INSERTs, nothing touches the stub. The counts per mapped level (in scope, linked, open and unlinked), the
 * "linked" rule shared with the Deviations view (same site, an active binding on an active connection), the states without counts
 * (never synced, mapping unusable, mapping changed after the last read), the "as of" time (the last successful run's finish),
 * the guard order and that nothing but counts is disclosed.
 */
class JiraCoverageTest {
    private val ledger = ConnectionLedger()

    @After
    fun dropConnections() = ledger.drop()

    private fun path(id: Any) = "$JB_CONNECTIONS/$id/coverage"

    private suspend fun HttpClient.coverage(id: UInt): JiraCoverageResponse {
        val response = get(path(id))
        assertEquals(HttpStatusCode.OK, response.status, response.bodyAsText())
        return jbJson.decodeFromString(response.bodyAsText())
    }

    /** A `sync_runs` row of [connection]: finished at [finishedAt] with [outcome] (a SUCCEEDED run is what the counts are "as of"). */
    private fun run(connection: UInt, startedAt: Long, finishedAt: Long, outcome: String = "SUCCEEDED") = jbSql(
        "INSERT INTO sync_runs (kind, connection_id, \"trigger\", started_at, finished_at, outcome) VALUES ('JIRA', ?, 'MANUAL', ?, ?, ?)",
        connection.toInt(), startedAt, finishedAt, outcome,
    )

    private fun level(level: JiraLevel, hierarchy: Int, inScope: Int, linked: Int, open: Int) =
        JiraCoverageLevel(level, hierarchy, inScope, linked, open)

    @Test
    fun `unauthenticated is 401, a non-admin 403 before the id lookup, a missing or deleted connection 404`() = testApplication {
        usePostgresTestcontainer()
        assertEquals(HttpStatusCode.Unauthorized, jsonClient().get(path(1)).status)
        val admin = seededClient("jcov-admin", UserRole.ADMIN)
        val user = seededClient("jcov-user", UserRole.USER)
        val id = ledger.track(admin.dvConnection())
        assertEquals(HttpStatusCode.Forbidden, user.get(path(id)).status)
        assertEquals(HttpStatusCode.Forbidden, user.get(path(999_999)).status, "the guard runs before the id lookup")
        assertEquals(HttpStatusCode.NotFound, admin.get(path(999_999)).status)
        jbSql("UPDATE jira_connections SET marked_as_deleted = TRUE WHERE id = ?", id.toInt())
        assertEquals(HttpStatusCode.NotFound, admin.get(path(id)).status, "a deleted connection is gone")
        assertEquals(HttpStatusCode.BadRequest, admin.get(path("abc")).status, "a malformed id is a 400 for an admin")
    }

    @Test
    fun `a connection that never synced has no counts, and neither has one whose mapping cannot name the levels`() = testApplication {
        usePostgresTestcontainer()
        val admin = seededClient("jcov-states", UserRole.ADMIN)
        val fresh = ledger.track(admin.dvConnection())
        assertEquals(JiraCoverageResponse(JiraCoverageState.NOT_SYNCED, null, emptyList()), admin.coverage(fresh))

        // Rows without a usable mapping (no discovery): the mapped levels are unknown, so no counts, and the last read is reported.
        val unmapped = ledger.track(admin.dvConnection(discovery = null, mapping = null))
        dvMirror(unmapped, "9501", level = 1, parent = null)
        assertEquals(JiraCoverageResponse(JiraCoverageState.MAPPING_UNUSABLE, null, emptyList()), admin.coverage(unmapped))
        run(unmapped, 4000, 4242)
        assertEquals(JiraCoverageResponse(JiraCoverageState.MAPPING_UNUSABLE, 4242, emptyList()), admin.coverage(unmapped))
    }

    @Test
    fun `a censused connection without issues reads zeros at every mapped level`() = testApplication {
        usePostgresTestcontainer()
        val admin = seededClient("jcov-empty", UserRole.ADMIN)
        val id = ledger.track(admin.dvConnection())
        jbSql("UPDATE jira_connections SET census_at = 77 WHERE id = ?", id.toInt())
        run(id, 70, 77)
        val expected = listOf(
            level(JiraLevel.PROGRAM, 3, 0, 0, 0), level(JiraLevel.PROJECT, 2, 0, 0, 0), level(JiraLevel.MILESTONE, 1, 0, 0, 0),
        )
        assertEquals(JiraCoverageResponse(JiraCoverageState.READY, 77, expected), admin.coverage(id))
    }

    @Test
    fun `the counts per mapped level - in scope, linked (same site, active), open and unlinked, other levels excluded`() =
        testApplication {
            usePostgresTestcontainer()
            val w = planWorld("jcov1", teams = true)
            val admin = w.admin.client
            val c = ledger.track(admin.dvConnection())
            val sameSite = ledger.track(admin.dvConnection())
            val deleted = ledger.track(admin.dvConnection())
            val elsewhere = ledger.track(admin.dvConnection())
            val site = jbScalar("SELECT site_url FROM jira_connections WHERE id = ?", c.toInt()) { it.getString(1) }
            listOf(sameSite, deleted).forEach { jbSql("UPDATE jira_connections SET site_url = ? WHERE id = ?", site, it.toInt()) }
            jbSql("UPDATE jira_connections SET census_at = 99 WHERE id = ?", c.toInt())
            run(c, 90, 99)
            val team = w.requireTeams().teamId
            val owner = w.projectOwner.personId!!
            val project = TestPlan.project(w.programId, owner)

            // Milestone level (1): 6 issues. 9601 bound here, 9602 bound through a same-site peer, 9603 only through a DELETED peer,
            // 9604 only on another site, 9605 done and unbound, 9606 released (soft-deleted binding).
            val level1 = listOf("9601", "9602", "9603", "9604", "9605", "9606")
            level1.forEach {
                dvMirror(c, it, level = 1, parent = "9001", status = if (it == "9605") JiraStatusCategory.DONE else JiraStatusCategory.TODO)
            }
            suspend fun bind(connection: UInt, issue: String, obs: DvObs = DvObs("x")): UInt =
                dvBind(connection, JiraLevel.MILESTONE, TestPlan.milestone(project, team), issue, "COV-$issue", obs)
            bind(c, "9601")
            bind(sameSite, "9602")
            bind(deleted, "9603")
            bind(elsewhere, "9604")
            val released = bind(c, "9606")
            jbSql("UPDATE jira_bindings SET marked_as_deleted = TRUE WHERE id = ?", released.toInt())
            jbSql("UPDATE jira_connections SET marked_as_deleted = TRUE WHERE id = ?", deleted.toInt())
            // Project level (2): 3 issues, one bound, one in progress, one done. Program level (3): 1 unbound issue.
            dvMirror(c, "9701", level = 2, parent = "9801")
            dvMirror(c, "9702", level = 2, parent = "9801", status = JiraStatusCategory.IN_PROGRESS)
            dvMirror(c, "9703", level = 2, parent = "9801", status = JiraStatusCategory.DONE)
            dvBind(c, JiraLevel.PROJECT, project, "9701", "COV-9701", DvObs("p", 2))
            dvMirror(c, "9801", level = 3, parent = null, status = JiraStatusCategory.UNKNOWN)
            // Not counted: stories (level 0, the roll-up's child level), and another connection's rows.
            dvMirror(c, "9901", level = 0, parent = "9601")
            dvMirror(elsewhere, "9902", level = 1, parent = null)

            val response = admin.coverage(c)
            assertEquals(JiraCoverageState.READY, response.state)
            assertEquals(99, response.readAt)
            assertEquals(
                listOf(
                    level(JiraLevel.PROGRAM, 3, inScope = 1, linked = 0, open = 1),
                    level(JiraLevel.PROJECT, 2, inScope = 3, linked = 1, open = 1),
                    // 9601 linked here, 9602 via the same-site peer; 9603 (deleted peer), 9604 (other site) and 9606 (released) are
                    // open and unlinked, 9605 is done.
                    level(JiraLevel.MILESTONE, 1, inScope = 6, linked = 2, open = 3),
                ),
                response.levels,
            )
        }

    @Test
    fun `only the mapped levels are listed, and the response carries counts and nothing else`() = testApplication {
        usePostgresTestcontainer()
        val admin = seededClient("jcov-keys", UserRole.ADMIN)
        val mapping = JiraMapping(JiraMappingLevels(milestone = JiraLevelMapping(1))).toStoredJson()
        val id = ledger.track(admin.dvConnection(mapping = mapping))
        dvMirror(id, "9511", level = 1, parent = null)
        dvMirror(id, "9512", level = 2, parent = null)
        val response = admin.get(path(id))
        assertEquals(HttpStatusCode.OK, response.status)
        val body = response.bodyAsText()
        assertFalse(body.contains("COV-9511") || body.contains("Summary of"), "no key, no summary: $body")
        val parsed = jbJson.decodeFromString<JiraCoverageResponse>(body)
        assertEquals(listOf(level(JiraLevel.MILESTONE, 1, inScope = 1, linked = 0, open = 1)), parsed.levels)
        assertNull(parsed.readAt, "the mirror has rows but no run is recorded (pruned history): the counts still show, unlabelled")
    }

    @Test
    fun `the counts are as of the last SUCCESSFUL run's finish, not the census stamp and not a later failure`() = testApplication {
        usePostgresTestcontainer()
        val admin = seededClient("jcov-readat", UserRole.ADMIN)
        val id = ledger.track(admin.dvConnection())
        dvMirror(id, "9521", level = 1, parent = null)
        jbSql("UPDATE jira_connections SET census_at = 10 WHERE id = ?", id.toInt())
        run(id, 100, 150)
        run(id, 200, 260)
        run(id, 300, 380, outcome = "FAILED")
        val readAt = admin.coverage(id).readAt
        assertEquals(260, readAt, "the newest SUCCEEDED run's finish; the older success, the stamp and the failure do not count")
    }

    @Test
    fun `a mapping saved after the last successful run began has no counts until a run reads under it`() = testApplication {
        usePostgresTestcontainer()
        val admin = seededClient("jcov-remap", UserRole.ADMIN)
        val id = ledger.track(admin.dvConnection())
        dvMirror(id, "9531", level = 1, parent = null)
        run(id, 100, 150)
        jbSql("UPDATE jira_connections SET mapping_changed_at = 120 WHERE id = ?", id.toInt())
        // The run began (100) before the change (120): it read under the old mapping, however late it finished.
        assertEquals(JiraCoverageResponse(JiraCoverageState.MAPPING_CHANGED, 150, emptyList()), admin.coverage(id))
        // A failed run after the change reads nothing under the new mapping either.
        run(id, 200, 230, outcome = "FAILED")
        assertEquals(JiraCoverageState.MAPPING_CHANGED, admin.coverage(id).state)
        // A run that began after the change is the first to have read under it.
        run(id, 300, 340)
        val ready = admin.coverage(id)
        assertEquals(JiraCoverageState.READY, ready.state)
        assertEquals(340, ready.readAt)
        assertEquals(listOf(JiraLevel.PROGRAM, JiraLevel.PROJECT, JiraLevel.MILESTONE), ready.levels.map { it.level })
    }

    @Test
    fun `a mapping saved on a connection with no recorded success has no counts either, and a never-changed mapping reads`() =
        testApplication {
            usePostgresTestcontainer()
            val admin = seededClient("jcov-remap2", UserRole.ADMIN)
            val changed = ledger.track(admin.dvConnection())
            dvMirror(changed, "9541", level = 1, parent = null)
            jbSql("UPDATE jira_connections SET mapping_changed_at = 120 WHERE id = ?", changed.toInt())
            assertEquals(JiraCoverageResponse(JiraCoverageState.MAPPING_CHANGED, null, emptyList()), admin.coverage(changed))
            val never = ledger.track(admin.dvConnection())
            dvMirror(never, "9542", level = 1, parent = null)
            assertEquals(JiraCoverageState.READY, admin.coverage(never).state)
        }
}
