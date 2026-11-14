package ch.nokillswit

import ch.nokillswit.jira.DEFAULT_POLL_INTERVAL_MINUTES
import ch.nokillswit.jira.DeviationViewService
import ch.nokillswit.jira.DeviationViewServiceKey
import ch.nokillswit.jira.JiraFlagSource
import ch.nokillswit.jira.JiraLevel
import ch.nokillswit.planning.ExternalFlagRequest
import ch.nokillswit.planning.JiraSite
import ch.nokillswit.planning.JiraSiteState
import ch.nokillswit.planning.ProjectView
import ch.nokillswit.planning.SNAPSHOT
import ch.nokillswit.planning.TeamView
import ch.nokillswit.planning.loadWorkingCalendar
import ch.nokillswit.sync.SyncRunService
import ch.nokillswit.sync.STALE_INTERVAL_MULTIPLIER
import ch.nokillswit.sync.SyncState
import io.ktor.client.HttpClient
import io.ktor.client.call.body
import io.ktor.client.request.get
import io.ktor.server.testing.ApplicationTestBuilder
import io.ktor.server.testing.testApplication
import org.jetbrains.exposed.v1.r2dbc.transactions.suspendTransaction
import org.junit.After
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

/**
 * The per-site status of the timeline views (1.16): `jiraSites[].state` and `.mappingOk` equal what `GET /views/deviations` answers for
 * the same connection in every state the connection can be in (no run, a good run, a failed one, a mapping that stopped fitting, a
 * disabled switch, and `STALE` through a source over a service with an injected clock), two connections give two sites each with its
 * own state, and a plan with no binding sends no `sync_runs` statement. The source's table is `JiraFlagSourceTest`, the wire's key set
 * `TimelineJiraFlagsTest`. States are produced by rows written straight into `sync_runs` (as `JiraConnectionStatusTest` does for its
 * API cases), so no stub is involved. Connections are SHARED suite state: each test mints its own and `ConnectionLedger` removes them.
 */
class JiraSiteStateTest {
    private val ledger = ConnectionLedger()

    @After
    fun dropConnections() = ledger.drop()

    /** A world with ONE scheduled milestone bound on [c]; [project] and [team] are the two views' ids. */
    private class Fx(val w: PlanWorld, val c: UInt, val milestone: UInt) {
        val project get() = w.projectId
        val team = w.requireTeams().teamId
    }

    private suspend fun ApplicationTestBuilder.fixture(prefix: String): Fx {
        usePostgresTestcontainer()
        val w = planWorld(prefix, teams = true)
        val c = ledger.track(w.admin.client.dvConnection())
        return Fx(w, c, boundMilestone(w, c))
    }

    /** A scheduled milestone of the world's project, bound on [connection]. */
    private suspend fun boundMilestone(w: PlanWorld, connection: UInt): UInt {
        val name = planName("ms")
        val id = TestPlan.milestone(w.projectId, w.requireTeams().teamId, name)
        TestPlan.schedule(id, "2044-02-07", "2044-02-11")
        val (issueId, key) = nextIssue()
        dvBind(connection, JiraLevel.MILESTONE, id, issueId, key, DvObs(name, 1, start = "2044-02-07", end = "2044-02-11"))
        return id
    }

    /** A finished SUCCEEDED run of [connection] straight into `sync_runs`. */
    private fun succeededRun(connection: UInt, startedAt: Long) = jbSql(
        "INSERT INTO sync_runs (kind, connection_id, \"trigger\", started_at, finished_at, outcome) " +
            "VALUES ('JIRA', ?, 'MANUAL', ?, ?, 'SUCCEEDED')",
        connection.toInt(), startedAt, startedAt + 5_000,
    )

    /** A finished FAILED run (typed code TIMEOUT) of [connection]. */
    private fun failedRun(connection: UInt, startedAt: Long) = jbSql(
        "INSERT INTO sync_runs (kind, connection_id, \"trigger\", started_at, finished_at, outcome, error_code) " +
            "VALUES ('JIRA', ?, 'MANUAL', ?, ?, 'FAILED', 'TIMEOUT')",
        connection.toInt(), startedAt, startedAt + 5_000,
    )

    private suspend fun HttpClient.project(id: UInt): ProjectView = get("/api/v1/views/project/$id").body()

    private suspend fun HttpClient.team(id: UInt): TeamView = get("/api/v1/views/team/$id").body()

    /** The site [connection] must carry: the deviations view's own verdict, mirrored by name. */
    private suspend fun Fx.expectedSite(connection: UInt, state: SyncState, mappingOk: Boolean): JiraSite {
        val facts = w.admin.client.dvView().connections.single { it.id == connection }
        assertEquals(state, facts.status.state, "the deviations view's own state")
        assertEquals(mappingOk, facts.mappingOk, "the deviations view's own mapping verdict")
        return JiraSite(connection, facts.siteUrl, JiraSiteState.valueOf(state.name), mappingOk)
    }

    /** The project view's and the team view's sites are exactly [expected]. */
    private suspend fun Fx.assertSites(vararg expected: JiraSite) {
        assertEquals(expected.toList(), w.stranger.client.project(project).jiraSites, "the project view")
        assertEquals(expected.toList(), w.stranger.client.team(team).jiraSites, "the team view")
    }

    /** The state the Jira source gives the milestone's connection when its service's clock reads [at] (called inside a snapshot). */
    private suspend fun Fx.siteStateAt(at: Long): JiraSiteState {
        val db = sharedDatabaseForTests()
        val source = JiraFlagSource(DeviationViewService(db, SyncRunService(db, 10), { at }))
        val sites = suspendTransaction(db, SNAPSHOT, readOnly = true) {
            source.flagsInTransaction(ExternalFlagRequest(listOf(project), listOf(milestone), loadWorkingCalendar())).sites
        }
        return sites.single().state
    }

    @Test
    fun `a site carries the state and mapping verdict the deviations view gives its connection, in every state`() = testApplication {
        val f = fixture("jss1")
        val now = System.currentTimeMillis()

        // A bind and no run.
        f.assertSites(f.expectedSite(f.c, SyncState.NEVER_SYNCED, mappingOk = true))

        // A successful run, then the same run judged three intervals and a minute later by a service with its own clock.
        succeededRun(f.c, now - 60_000)
        f.assertSites(f.expectedSite(f.c, SyncState.CURRENT, mappingOk = true))
        assertEquals(JiraSiteState.CURRENT, f.siteStateAt(now))
        assertEquals(
            JiraSiteState.STALE, f.siteStateAt(now + (STALE_INTERVAL_MULTIPLIER * DEFAULT_POLL_INTERVAL_MINUTES + 1) * 60_000L),
            "past three default intervals",
        )

        // A newer failed run outranks the old success.
        failedRun(f.c, now - 30_000)
        f.assertSites(f.expectedSite(f.c, SyncState.FAILED, mappingOk = true))
        assertEquals(JiraSiteState.FAILED, f.siteStateAt(now + 4 * 60 * 60_000L), "FAILED outranks STALE")

        // A mapping that no longer fits the stored discovery: the state is unchanged, the verdict flips.
        val stale = """{"levels":{"milestone":{"hierarchyLevel":7}}}"""
        jbSql("UPDATE jira_connections SET mapping = ?::jsonb WHERE id = ?", stale, f.c.toInt())
        f.assertSites(f.expectedSite(f.c, SyncState.FAILED, mappingOk = false))

        // The switch (what the PUT writes): DISABLED outranks everything.
        jbSql("UPDATE jira_connections SET enabled = FALSE WHERE id = ?", f.c.toInt())
        f.assertSites(f.expectedSite(f.c, SyncState.DISABLED, mappingOk = false))
    }

    @Test
    fun `two connections give two sites, each with its own state, in connection order`() = testApplication {
        val f = fixture("jss2")
        val second = ledger.track(f.w.admin.client.dvConnection())
        boundMilestone(f.w, second)
        val now = System.currentTimeMillis()
        succeededRun(f.c, now - 60_000)
        failedRun(second, now - 60_000)

        val sites = listOf(
            f.expectedSite(f.c, SyncState.CURRENT, mappingOk = true),
            f.expectedSite(second, SyncState.FAILED, mappingOk = true),
        ).sortedBy { it.connectionId }
        f.assertSites(*sites.toTypedArray())
        val onTheWire = f.w.stranger.client.project(f.project).jiraSites
        assertEquals(setOf(f.c, second), onTheWire.map { it.connectionId }.toSet())
        assertEquals(
            mapOf(f.c to JiraSiteState.CURRENT, second to JiraSiteState.FAILED), onTheWire.associate { it.connectionId to it.state },
        )
    }

    @Test
    fun `a plan with no binding answers no site and its fold reads no sync run, a bound one reads them once`() = testApplication {
        val f = fixture("jss3")
        val unboundProject = TestPlan.project(f.w.programId, f.w.projectOwner.personId!!)
        val unboundMilestone = TestPlan.milestone(unboundProject, f.team)
        val unbound = f.w.stranger.client.project(unboundProject)
        assertEquals(emptyList(), unbound.jiraSites)

        val source = JiraFlagSource(application.attributes[DeviationViewServiceKey])

        suspend fun statements(project: UInt, milestone: UInt): List<String> {
            val counter = StatementCounter()
            suspendTransaction(sharedDatabaseForTests()) {
                registerInterceptor(counter)
                source.flagsInTransaction(ExternalFlagRequest(listOf(project), listOf(milestone), loadWorkingCalendar()))
            }
            return counter.sql
        }
        val none = statements(unboundProject, unboundMilestone)
        assertTrue(none.none { "sync_runs" in it }, "no binding, no run read:\n${none.joinToString("\n")}")
        val bound = statements(f.project, f.milestone)
        val reads = bound.count { "sync_runs" in it }
        assertEquals(1, reads, "one indexed read for the one referenced connection:\n${bound.joinToString("\n")}")
    }
}
