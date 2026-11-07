package ch.nokillswit

import ch.nokillswit.jira.JiraImportApplyItem
import ch.nokillswit.jira.JiraImportDefaults
import ch.nokillswit.jira.JiraImportOverrides
import ch.nokillswit.jira.JiraImportScope
import ch.nokillswit.jira.JiraLevel
import io.ktor.client.statement.HttpResponse
import io.ktor.client.statement.bodyAsText
import io.ktor.http.HttpStatusCode
import io.ktor.server.testing.testApplication
import kotlinx.coroutines.async
import kotlinx.coroutines.coroutineScope
import org.junit.BeforeClass
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

/**
 * The checks an apply repeats UNDER the locks, each pinned by changing the world while the request waits at the plan lock
 * (`requestHeldAtPlanLock`): the commit of the raw session lands before the apply reads anything, so the apply must see it. A refused
 * apply writes nothing and leaves the revision alone. IMP-1 is bound to the world's program in each (no global "IMP Program").
 */
class JiraImportApplyRecheckTest {
    private class Ready(val f: ImportFixture, val scope: JiraImportScope, val ticks: List<JiraImportApplyItem>, val before: Long)

    private suspend fun ImportFixture.ready(scope: JiraImportScope = scope(), client: io.ktor.client.HttpClient = w.admin.client): Ready {
        bindImpProgram()
        return Ready(this, scope, client.preview(connectionId, scope).previewBody().ticks(), TestPlan.revision())
    }

    private suspend fun Ready.held(
        client: io.ktor.client.HttpClient = f.w.admin.client,
        ticks: List<JiraImportApplyItem> = this.ticks,
        mutate: (java.sql.Connection) -> Unit,
    ): HttpResponse = requestHeldAtPlanLock({ client.applyImport(f.connectionId, scope, ticks) }, mutate)

    private suspend fun Ready.refused(response: HttpResponse, status: HttpStatusCode) {
        assertEquals(status, response.status, response.bodyAsText())
        assertEquals(before, TestPlan.revision(), "nothing was written, no bump")
        assertEquals(1, activeBindingCount(f.connectionId), "only the world's program binding")
    }

    @Test
    fun `a manager revoked while the apply waits gets the milestones created unscheduled`() = testApplication {
        val f = importFixture("jiarc1")
        val owner = f.w.streamOwner
        val team = TestTeams.seed(planName("jiarc1-team"), owner.personId)
        val ready = f.ready(f.scope(JiraImportDefaults(teamId = team)), owner.client)
        val shown = owner.client.preview(f.connectionId, ready.scope).previewBody()
        assertEquals(4, shown.items.count { it.scheduled }, "the preview schedules the dated milestones: the owner manages the team")
        val response = ready.held(owner.client) { it.exec("UPDATE teams SET manager_person_id = NULL WHERE id = ?", team.toInt()) }
        val result = response.applyBody()
        assertEquals(5, result.created.count { it.kind == JiraLevel.MILESTONE })
        assertTrue(result.created.none { it.scheduled })
        val dates = "SELECT count(*) FROM milestones WHERE team_id = ? AND start_date IS NOT NULL"
        assertEquals(0, jbScalar(dates, team.toInt()) { it.getInt(1) }, "no date was copied")
    }

    @Test
    fun `the manager row is locked FOR SHARE, so a manager change that commits while the apply waits for it unschedules the milestones`() =
        testApplication {
            val f = importFixture("jiarc6")
            val owner = f.w.streamOwner
            // "IMP Team" is the Jira Team value of IMP-4/6/7/9: matched by NAME, so no named team is locked earlier (`requireActiveTeam`).
            val team = TestTeams.seed("IMP Team", owner.personId)
            try {
                f.bindImpProgram()
                val scope = f.scope(null)
                val preview = owner.client.preview(f.connectionId, scope).previewBody()
                assertEquals(3, preview.items.count { it.scheduled }, "the owner manages the matched team")
                val ticks = preview.ticks()
                PostgresTestSupport.connect().use { raw ->
                    raw.autoCommit = false
                    raw.prepareStatement("SELECT id FROM teams WHERE id = ? FOR NO KEY UPDATE").use { st ->
                        st.setInt(1, team.toInt())
                        st.executeQuery().close()
                    }
                    try {
                        val result = coroutineScope {
                            val pending = async { owner.client.applyImport(f.connectionId, scope, ticks) }
                            // Waiting on the team row in `lockedIsActiveManager` (FOR SHARE OF teams, people), before the kernel runs.
                            awaitLockWait("OF teams")
                            raw.exec("UPDATE teams SET manager_person_id = NULL WHERE id = ?", team.toInt())
                            raw.commit()
                            pending.await().applyBody()
                        }
                        assertEquals(4, result.created.count { it.kind == JiraLevel.MILESTONE })
                        assertTrue(result.created.none { it.scheduled }, "the manager was revoked before the apply read the row")
                    } finally {
                        raw.rollback()
                    }
                }
            } finally {
                jbSql("UPDATE teams SET marked_as_deleted = TRUE WHERE id = ?", team.toInt())
            }
        }

    @Test
    fun `a mapping or discovery changed while the apply waits is a 409`() = testApplication {
        val f = importFixture("jiarc2")
        val ready = f.ready()
        val moved = "UPDATE jira_connections SET mapping_changed_at = COALESCE(mapping_changed_at, 0) + 1 WHERE id = ?"
        val mapping = ready.held { it.exec(moved, f.connectionId.toInt()) }
        ready.refused(mapping, HttpStatusCode.Conflict)
        assertEquals("urn:astrolabe:problem:jira-mapping-invalid", mapping.jbProblem().type)
        val rediscovered = "UPDATE jira_connections SET discovered_at = discovered_at + 1 WHERE id = ?"
        val discovery = ready.held { it.exec(rediscovered, f.connectionId.toInt()) }
        ready.refused(discovery, HttpStatusCode.Conflict)
    }

    @Test
    fun `project keys narrowed while the apply waits are a 400, and so is a connection disabled`() = testApplication {
        val f = importFixture("jiarc3")
        val ready = f.ready()
        val keys = ready.held { it.exec("UPDATE jira_connections SET project_keys = '[\"OTHER\"]' WHERE id = ?", f.connectionId.toInt()) }
        ready.refused(keys, HttpStatusCode.BadRequest)
        assertTrue("project keys" in keys.jbProblem().detail.orEmpty())
        jbSql("UPDATE jira_connections SET project_keys = '[\"IMP\"]' WHERE id = ?", f.connectionId.toInt())
        val disabled = ready.held { it.exec("UPDATE jira_connections SET enabled = FALSE WHERE id = ?", f.connectionId.toInt()) }
        ready.refused(disabled, HttpStatusCode.BadRequest)
        assertTrue("disabled" in disabled.jbProblem().detail.orEmpty())
    }

    @Test
    fun `an owner or an override team deleted while the apply waits is a 400`() = testApplication {
        val f = importFixture("jiarc4")
        val owner = TestPeople.seed(planName("jiarc4-owner"))
        val ready = f.ready(JiraImportScope(f.w.streamId, owner, null, JiraImportDefaults(teamId = f.defaultTeam), true))
        val gone = ready.held { it.exec("UPDATE people SET marked_as_deleted = TRUE WHERE id = ?", owner.toInt()) }
        ready.refused(gone, HttpStatusCode.BadRequest)
        assertTrue("owner" in gone.jbProblem().detail.orEmpty())

        val other = TestTeams.seed(planName("jiarc4-team"))
        val overridden = ready.ticks.map { if (it.jiraId == "95004") it.copy(overrides = JiraImportOverrides(other)) else it }
        val fresh = Ready(f, f.scope(), f.w.admin.client.preview(f.connectionId, f.scope()).previewBody().ticks(), TestPlan.revision())
        val team = fresh.held(ticks = overridden) { it.exec("UPDATE teams SET marked_as_deleted = TRUE WHERE id = ?", other.toInt()) }
        fresh.refused(team, HttpStatusCode.BadRequest)
        assertTrue("team" in team.jbProblem().detail.orEmpty())
    }

    @Test
    fun `a work stream deleted while the apply waits is a 404`() = testApplication {
        val f = importFixture("jiarc5")
        val ready = f.ready()
        val response = ready.held { it.exec("UPDATE work_streams SET marked_as_deleted = TRUE WHERE id = ?", f.w.streamId.toInt()) }
        assertEquals(HttpStatusCode.NotFound, response.status, response.bodyAsText())
        assertEquals(ready.before, TestPlan.revision())
        assertEquals(1, activeBindingCount(f.connectionId))
    }

    companion object {
        @JvmStatic
        @BeforeClass
        fun warmStub() {
            JiraStubFixture.warm()
        }
    }
}
