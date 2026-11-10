package ch.nokillswit

import ch.nokillswit.jira.DeviationFilter
import ch.nokillswit.jira.DeviationViewService
import ch.nokillswit.jira.JiraLevel
import ch.nokillswit.jira.MAX_DEVIATION_ITEMS
import ch.nokillswit.planning.DeviationKind
import ch.nokillswit.sync.SyncOutcome
import ch.nokillswit.sync.SyncRunService
import ch.nokillswit.sync.SyncState
import ch.nokillswit.sync.SyncTrigger
import io.ktor.client.request.get
import io.ktor.client.statement.bodyAsText
import io.ktor.http.HttpStatusCode
import io.ktor.server.testing.testApplication
import kotlinx.coroutines.withTimeout
import java.time.Instant
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * What the Deviations view hides, what it cannot compare and what it says about the connections: a deleted or disabled connection, a
 * dead node, a stale or unreadable mapping, the `lastRun` rule, the cap, the clock, a plain USER and the absence of any lock.
 */
class DeviationViewScopeTest {
    private fun sql(statement: String, vararg params: Any) = jbSql(statement, *params)

    /** A `sync_runs` row of [connection]: unfinished unless [finishedAt] is given. */
    private fun run(connection: UInt, startedAt: Long, finishedAt: Long? = null, outcome: String? = null, errorCode: String? = null) {
        PostgresTestSupport.connect().use { c ->
            c.prepareStatement(
                "INSERT INTO sync_runs (kind, connection_id, \"trigger\", started_at, finished_at, outcome, error_code) " +
                    "VALUES ('JIRA', ?, 'MANUAL', ?, ?, ?, ?)",
            ).use { st ->
                st.setInt(1, connection.toInt())
                st.setLong(2, startedAt)
                if (finishedAt == null) st.setNull(3, java.sql.Types.BIGINT) else st.setLong(3, finishedAt)
                st.setString(4, outcome)
                st.setString(5, errorCode)
                st.executeUpdate()
            }
        }
    }

    // --- hidden bindings --------------------------------------------------------------------------------------------------------------

    @Test
    fun `deleted-connection and dead-node bindings are hidden, a disabled connection's stay and its block says so`() = testApplication {
        usePostgresTestcontainer()
        val w = planWorld("dvs", teams = true)
        val team = w.requireTeams().teamId
        val admin = w.admin.client
        val live = admin.dvConnection()
        val deleted = admin.dvConnection()
        val disabled = admin.dvConnection(enabled = false)

        suspend fun renamed(connection: UInt, issue: String, projectId: UInt = w.projectId): Pair<UInt, UInt> {
            val node = TestPlan.milestone(projectId, team)
            return node to dvBind(connection, JiraLevel.MILESTONE, node, issue, "ABC-$issue", DvObs("Renamed"))
        }
        val (_, ok) = renamed(live, "6001")
        val (deadNode, deadNodeBinding) = renamed(live, "6002")
        val (_, ofDeleted) = renamed(deleted, "6003")
        val (_, ofDisabled) = renamed(disabled, "6004")
        val deadProject = TestPlan.project(w.programId, w.projectOwner.personId!!)
        val (_, underDeadProject) = renamed(live, "6005", deadProject)
        val deadProjectBinding = dvBind(live, JiraLevel.PROJECT, deadProject, "6006", "ABC-6006", DvObs("Renamed", 2))

        assertEquals(setOf(ok, deadNodeBinding, underDeadProject, deadProjectBinding), admin.dvView("connectionId=$live").byBinding().keys)

        sql("UPDATE milestones SET marked_as_deleted = true WHERE id = ?", deadNode.toInt())
        sql("UPDATE projects SET marked_as_deleted = true WHERE id = ?", deadProject.toInt())
        sql("UPDATE jira_connections SET marked_as_deleted = true WHERE id = ?", deleted.toInt())
        // The bindings stay ACTIVE rows (a node delete never touches them, and a deleted connection's rows stay in the table).
        assertTrue(jbActive(deadNodeBinding) && jbActive(ofDeleted) && jbActive(underDeadProject))

        assertEquals(
            setOf(ok), admin.dvView("connectionId=$live").byBinding().keys, "a dead node, and a node under a dead ancestor, are hidden",
        )
        assertEquals(emptySet(), admin.dvView("connectionId=$deleted&all=true").byBinding().keys)
        assertEquals(
            setOf(ofDisabled), admin.dvView("connectionId=$disabled&all=true").byBinding().keys,
            "a disabled connection's binding still blocks its node and issue: it stays visible (and unlinkable)",
        )
        val unfiltered = admin.dvView("all=true")
        assertTrue(listOf(ofDeleted, deadNodeBinding, underDeadProject).none { it in unfiltered.byBinding() })
        assertTrue(ofDisabled in unfiltered.byBinding())
        val blocks = unfiltered.connections.associateBy { it.id }
        assertTrue(live in blocks && deleted !in blocks)
        assertEquals(false, blocks.getValue(disabled).enabled, "listed, flagged disabled: the bind dialog offers enabled ones only")
        assertEquals(true, blocks.getValue(live).enabled)
    }

    // --- the connection block ---------------------------------------------------------------------------------------------------------

    @Test
    fun `the connections block lists every active connection, bound or not, with the plain facts only`() = testApplication {
        usePostgresTestcontainer()
        val w = planWorld("dvc", teams = true)
        val unbound = w.admin.client.dvConnection()
        val user = seededClient("dvcuser")
        val connection = user.dvView().connections.single { it.id == unbound }
        assertEquals(jbSiteOf(unbound), connection.siteUrl)
        assertTrue(connection.name.startsWith("jb-"))
        assertTrue(connection.mappingOk)
        assertTrue(connection.enabled)
        assertEquals(listOf("E2E"), connection.projectKeys, "the connection's keys are the import dialog's scope options (1.10)")
        assertNull(connection.lastRun, "no run yet")
        val raw = user.get(DV_VIEW).bodyAsText()
        assertFalse(
            listOf("email", "apiToken", "jira.user@example.test", "JTOK").any { raw.contains(it, ignoreCase = true) },
            "nothing of the registry beyond name, site and the project keys",
        )
    }

    private fun jbSiteOf(id: UInt): String = jbScalar("SELECT site_url FROM jira_connections WHERE id = ?", id.toInt()) { it.getString(1) }

    @Test
    fun `lastRun is the newest run and running only for an unfinished run younger than maxRunMinutes`() = testApplication {
        usePostgresTestcontainer()
        val w = planWorld("dvr", teams = true)
        val admin = w.admin.client
        val now = System.currentTimeMillis()
        val finished = admin.dvConnection()
        val fresh = admin.dvConnection()
        val stale = admin.dvConnection()
        run(finished, now - 3_600_000, now - 3_000_000, "SUCCEEDED")
        run(finished, now - 60_000, now - 30_000, "FAILED", "TIMEOUT")
        run(fresh, now - 60_000)
        run(stale, now - 3_600_000)
        try {
            val blocks = admin.dvView().connections.associateBy { it.id }
            val newest = assertNotNull(blocks.getValue(finished).lastRun)
            assertEquals(now - 60_000, newest.startedAt)
            assertEquals(now - 30_000, newest.finishedAt)
            assertEquals(SyncOutcome.FAILED, newest.outcome)
            assertEquals("TIMEOUT", newest.errorCode)
            assertFalse(newest.running)
            val running = assertNotNull(blocks.getValue(fresh).lastRun)
            assertTrue(running.running && running.finishedAt == null && running.outcome == null)
            val interrupted = assertNotNull(blocks.getValue(stale).lastRun)
            assertTrue(!interrupted.running && interrupted.finishedAt == null, "unfinished and old: interrupted, not running")
        } finally {
            listOf(finished, fresh, stale).forEach { sql("DELETE FROM sync_runs WHERE connection_id = ?", it.toInt()) }
        }
    }

    @Test
    fun `the running rule is exact at maxRunMinutes, and asOf follows the injected clock`() = testApplication {
        usePostgresTestcontainer()
        val w = planWorld("dvt", teams = true)
        val admin = w.admin.client
        val atLimit = admin.dvConnection()
        val past = admin.dvConnection()
        val name = "tdv-${java.util.UUID.randomUUID()}"
        val node = TestPlan.milestone(w.projectId, w.requireTeams().teamId, name)
        TestPlan.schedule(node, "2044-02-02", "2044-02-05")
        val binding = dvBind(
            atLimit, JiraLevel.MILESTONE, node, "5001", "ABC-5001", DvObs(name, 1, "TODO", start = "2044-02-02", end = "2044-02-05"),
        )
        val noon = Instant.parse("2044-02-02T12:00:00Z").toEpochMilli()
        run(atLimit, noon - 10 * 60_000)
        run(past, noon - 10 * 60_000 - 1)
        try {
            val db = sharedDatabaseForTests()
            fun service(at: String) = DeviationViewService(db, SyncRunService(db, 10), { Instant.parse(at).toEpochMilli() })
            val onTheDay = service("2044-02-02T12:00:00Z").view(DeviationFilter(connectionId = atLimit, all = true))
            assertEquals("2044-02-02", onTheDay.asOf)
            assertTrue(
                assertNotNull(onTheDay.connections.single { it.id == atLimit }.lastRun).running,
                "exactly maxRunMinutes old is still running",
            )
            assertFalse(
                assertNotNull(service("2044-02-02T12:00:00Z").view(DeviationFilter()).connections.single { it.id == past }.lastRun).running,
                "one millisecond older is not",
            )
            assertEquals(
                emptyList(), onTheDay.items.single { it.bindingId == binding }.deviations,
                "TODO and the plan starts today: not before today",
            )
            val nextDay = service("2044-02-03T00:00:00Z").view(DeviationFilter(connectionId = atLimit))
            assertEquals("2044-02-03", nextDay.asOf)
            val mismatch = nextDay.items.single { it.bindingId == binding }.deviations.single()
            assertEquals(DeviationKind.PROGRESS_MISMATCH, mismatch.kind)
            assertEquals("2044-02-02", mismatch.detail.plan)
            assertFalse(
                nextDay.connections.single { it.id == atLimit }.lastRun!!.running, "an hour-old run is not running at the next day's clock",
            )
        } finally {
            listOf(atLimit, past).forEach { sql("DELETE FROM sync_runs WHERE connection_id = ?", it.toInt()) }
        }
    }

    @Test
    fun `every connection block carries its derived status, judged at the view's clock, with the same newest run as lastRun`() =
        testApplication {
            usePostgresTestcontainer()
            val w = planWorld("dvst", teams = true)
            val admin = w.admin.client
            val untouched = admin.dvConnection()
            val current = admin.dvConnection()
            val failing = admin.dvConnection()
            val disabled = admin.dvConnection(enabled = false)
            val noon = Instant.parse("2044-02-02T12:00:00Z").toEpochMilli()
            val minute = 60_000L
            run(current, noon - 5 * minute, noon - 4 * minute, "SUCCEEDED")
            run(failing, noon - 120 * minute, noon - 119 * minute, "SUCCEEDED")
            run(failing, noon - 10 * minute, noon - 9 * minute, "FAILED", "TIMEOUT")
            run(disabled, noon - 5 * minute, noon - 4 * minute, "SUCCEEDED")
            try {
                val db = sharedDatabaseForTests()
                suspend fun blocks(at: Long) =
                    DeviationViewService(db, SyncRunService(db, 10), { at }).view(DeviationFilter()).connections.associateBy { it.id }
                val onTheDay = blocks(noon)
                val never = onTheDay.getValue(untouched).status
                assertEquals(SyncState.NEVER_SYNCED, never.state)
                assertNull(never.lastRun)
                assertEquals(noon, never.nextPollAt, "tested (discovered), no run: due at the view's own instant")
                val ok = onTheDay.getValue(current)
                assertEquals(SyncState.CURRENT, ok.status.state)
                assertEquals(noon - 5 * minute, ok.status.lastSucceededAt)
                assertEquals(noon - 4 * minute + 15 * minute, ok.status.nextPollAt)
                assertEquals(ok.lastRun, ok.status.lastRun, "lastRun is the status's newest run")
                val bad = onTheDay.getValue(failing)
                assertEquals(SyncState.FAILED, bad.status.state)
                assertEquals(1, bad.status.consecutiveFailures)
                assertEquals("TIMEOUT", bad.status.lastRun!!.errorCode)
                assertEquals(noon - 120 * minute, bad.status.lastSucceededAt)
                assertEquals(SyncTrigger.MANUAL, bad.status.lastRun!!.trigger)
                val off = onTheDay.getValue(disabled).status
                assertEquals(SyncState.DISABLED, off.state)
                assertNull(off.nextPollAt)
                // The view's clock decides staleness: four hours on, the polled connections' last success is older than 3 x 15 minutes.
                val later = blocks(noon + 4 * 60 * minute)
                assertEquals(SyncState.STALE, later.getValue(current).status.state)
                assertEquals(SyncState.FAILED, later.getValue(failing).status.state, "FAILED outranks STALE")
            } finally {
                listOf(current, failing, disabled).forEach { sql("DELETE FROM sync_runs WHERE connection_id = ?", it.toInt()) }
            }
        }

    // --- mapping ----------------------------------------------------------------------------------------------------------------------

    @Test
    fun `a stale, unreadable or absent mapping compares no level and no estimate, flags the block and never fails`() = testApplication {
        usePostgresTestcontainer()
        val w = planWorld("dvm", teams = true)
        val admin = w.admin.client
        val stale = admin.dvConnection(mapping = """{"levels":{"milestone":{"hierarchyLevel":7}}}""")
        val unreadable = admin.dvConnection(mapping = DV_UNREADABLE_MAPPING)
        val undiscovered = admin.dvConnection(discovery = null, mapping = null)
        val defaults = admin.dvConnection(mapping = null)
        val unmappedProgram = admin.dvConnection(mapping = """{"levels":{"milestone":{"hierarchyLevel":1}}}""")

        // The same wrong-level, estimate-carrying, renamed issue on each; only the mapped connections may compare level and estimate.
        suspend fun bindIssue(connection: UInt, level: Int = 0): UInt {
            val node = TestPlan.milestone(w.projectId, w.requireTeams().teamId, estimate = 8.0)
            return dvBind(
                connection, JiraLevel.MILESTONE, node, "4001", "ABC-4001", DvObs("Renamed", level, estimate = "21.00", unit = "POINTS"),
            )
        }
        val blocks = admin.dvView().connections.associateBy { it.id }
        assertEquals(
            listOf(false, false, false, true, true),
            listOf(stale, unreadable, undiscovered, defaults, unmappedProgram).map { blocks.getValue(it).mappingOk },
        )
        for (connection in listOf(stale, unreadable, undiscovered)) {
            val binding = bindIssue(connection)
            val item = admin.dvView("connectionId=$connection&all=true").byBinding().getValue(binding)
            assertEquals(setOf(DeviationKind.RENAMED), item.kindSet(), "only what needs no mapping")
        }
        // The defaults (milestone level 1, POINTS, no factor) do compare: the level, and the figure shown but not converted.
        val defaultsBinding = bindIssue(defaults)
        val viaDefaults = admin.dvView("connectionId=$defaults&all=true").byBinding().getValue(defaultsBinding)
        assertEquals(
            setOf(DeviationKind.RENAMED, DeviationKind.LEVEL_MISMATCH, DeviationKind.ESTIMATE_NOT_COMPARABLE), viaDefaults.kindSet(),
        )
        // A level the mapping leaves out has no level to compare: the binding of a PROGRAM on a connection without a program level.
        val program = TestPlan.program(w.streamId, w.programOwner.personId!!)
        val programBinding = dvBind(unmappedProgram, JiraLevel.PROGRAM, program, "4002", "ABC-4002", DvObs("Renamed", 9))
        assertEquals(
            setOf(DeviationKind.RENAMED),
            admin.dvView("connectionId=$unmappedProgram&all=true").byBinding().getValue(programBinding).kindSet(),
        )
    }

    // --- an unobserved binding --------------------------------------------------------------------------------------------------------

    @Test
    fun `a binding with no observation row is listed only with all, with null Jira facts and no deviation`() = testApplication {
        usePostgresTestcontainer()
        val w = planWorld("dvn", teams = true)
        val admin = w.admin.client
        val c = admin.dvConnection()
        val node = TestPlan.milestone(w.projectId, w.requireTeams().teamId)
        val binding = dvBind(c, JiraLevel.MILESTONE, node, "3001", "ABC-3001", obs = null)
        assertEquals(emptySet(), admin.dvView("connectionId=$c").byBinding().keys)
        val item = admin.dvView("connectionId=$c&all=true").byBinding().getValue(binding)
        assertEquals(emptyList(), item.deviations)
        assertNull(item.jira.observedAt)
        assertNull(item.jira.statusCategory)
        assertNull(item.jira.summary)
        assertFalse(item.jira.gone)
        assertEquals("ABC-3001", item.jira.key)
        assertTrue(item.jira.url.endsWith("/browse/ABC-3001"))
    }

    // --- the cap ----------------------------------------------------------------------------------------------------------------------

    @Test
    fun `the cap keeps the first items in order and says so, while the totals count every filtered binding`() = testApplication {
        usePostgresTestcontainer()
        val w = planWorld("dvx", teams = true)
        val c = w.admin.client.dvConnection()
        val bindings = (1..3).map { i ->
            val node = TestPlan.milestone(w.projectId, w.requireTeams().teamId, "cap-$i-${java.util.UUID.randomUUID()}")
            dvBind(c, JiraLevel.MILESTONE, node, "20$i", "ABC-20$i", DvObs("Renamed"))
        }
        val db = sharedDatabaseForTests()
        fun service(max: Int) = DeviationViewService(db, SyncRunService(db, 10), maxItems = max)
        val capped = service(2).view(DeviationFilter(connectionId = c))
        assertTrue(capped.truncated)
        assertEquals(2, capped.items.size)
        assertEquals(3, capped.totals.bindings)
        assertEquals(3, capped.totals.infos)
        assertTrue(capped.items.map { it.bindingId }.all { it in bindings })
        val exact = service(3).view(DeviationFilter(connectionId = c))
        assertFalse(exact.truncated, "exactly the cap is not truncated")
        assertEquals(3, exact.items.size)
        assertEquals(2000, MAX_DEVIATION_ITEMS)
    }

    // --- access -----------------------------------------------------------------------------------------------------------------------

    @Test
    fun `anonymous is 401 and a plain USER reads the whole view`() = testApplication {
        usePostgresTestcontainer()
        assertEquals(HttpStatusCode.Unauthorized, jsonClient().get(DV_VIEW).status)
        val w = planWorld("dva", teams = true)
        val c = w.admin.client.dvConnection()
        val node = TestPlan.milestone(w.projectId, w.requireTeams().teamId)
        val binding = dvBind(c, JiraLevel.MILESTONE, node, "1001", "ABC-1001", DvObs("Renamed"))
        for (caller in listOf(w.stranger, w.personless)) {
            assertTrue(binding in caller.client.dvView("connectionId=$c").byBinding())
        }
    }

    @Test
    fun `the view takes no write lock and moves no revision - it answers while the plan lock is held`() = testApplication {
        usePostgresTestcontainer()
        val w = planWorld("dvl", teams = true)
        val c = w.admin.client.dvConnection()
        val node = TestPlan.milestone(w.projectId, w.requireTeams().teamId)
        val binding = dvBind(c, JiraLevel.MILESTONE, node, "1101", "ABC-1101", DvObs("Renamed"))
        val before = TestPlan.revision()
        PostgresTestSupport.connect().use { raw ->
            raw.autoCommit = false
            try {
                raw.createStatement().use { it.executeQuery("SELECT revision FROM plan_state WHERE id = 1 FOR UPDATE").close() }
                val view = withTimeout(15_000) { w.admin.client.dvView("connectionId=$c") }
                assertTrue(binding in view.byBinding())
                assertEquals(before, view.revision)
            } finally {
                raw.rollback()
            }
        }
        assertEquals(before, TestPlan.revision())
    }
}
