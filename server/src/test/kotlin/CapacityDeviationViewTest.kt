package ch.nokillswit

import ch.nokillswit.flow.CapacityAction
import ch.nokillswit.flow.CapacityApplyCommand
import ch.nokillswit.flow.CapacityApplyRow
import ch.nokillswit.flow.CapacityDeviation
import ch.nokillswit.flow.CapacityDeviationFilter
import ch.nokillswit.flow.CapacityDeviationKind
import ch.nokillswit.flow.CapacityDeviationService
import ch.nokillswit.flow.CapacityDeviationView
import ch.nokillswit.flow.CapacityImportService
import ch.nokillswit.flow.FlowClientFactory
import ch.nokillswit.flow.MAX_CAPACITY_DEVIATION_ITEMS
import ch.nokillswit.flow.HttpFlowClient
import ch.nokillswit.flow.buildGuardedFlowHttpClient
import ch.nokillswit.flow.createFlowHttp
import ch.nokillswit.infra.outbound.FlowOrigins
import ch.nokillswit.infra.outbound.Origin
import ch.nokillswit.infra.outbound.SelfManagedHosts
import ch.nokillswit.planning.DeviationSeverity
import ch.nokillswit.sync.SyncOutcome
import ch.nokillswit.sync.SyncState
import ch.nokillswit.teams.TeamCapacityService
import io.ktor.client.HttpClient
import io.ktor.client.request.get
import io.ktor.client.statement.bodyAsText
import io.ktor.http.HttpStatusCode
import io.ktor.server.testing.testApplication
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.AfterClass
import org.junit.BeforeClass
import java.math.BigDecimal
import java.net.URI
import java.time.Instant
import java.time.LocalDate
import java.time.ZoneOffset
import kotlin.test.AfterTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * `GET /views/capacity-deviations` (1.6): the stub's "E2E Flow Team" (six 2047 sprints, `expected.json`) and its day two through the
 * route and the real services, plus scripted mirrors for the cases the stub cannot plant (the order, the cap, a disabled and a
 * never-mirrored connection). The figures are read from `expected.json`, never copied; the kernel's vectors are
 * `CapacityDeviationKernelsTest`. Every test scopes its assertions to its own connection (the container is shared) and a test that flips
 * `flow-day2` resets it in a `finally`.
 */
class CapacityDeviationViewTest {
    private companion object {
        const val PREFIX = "capdev"
        const val VIEW = "/api/v1/views/capacity-deviations"

        private val guarded by lazy {
            val origins = FlowOrigins(SelfManagedHosts.NONE, setOf(Origin("http", "localhost", URI(FlowStubServer.baseUrl).port)), true)
            buildGuardedFlowHttpClient(origins, requestTimeoutSeconds = 30)
        }

        @JvmStatic
        @BeforeClass
        fun warmStub() {
            FlowStubFixture.warm()
        }

        @JvmStatic
        @AfterClass
        fun closeClient() {
            FlowStubServer.resetScenarios()
            guarded.close()
        }
    }

    private val stubHarness = FlowRunHarness(
        FlowClientFactory { baseUrl, token -> HttpFlowClient(createFlowHttp(guarded, 0, 4L * 1024 * 1024, 1), baseUrl, token) },
    )
    private val mirrors = mutableListOf<ScriptedFlowMirror>()
    private val ownUsers = mutableListOf<UInt>()
    private val expectedE2e: JsonObject get() = FlowStubServer.expected.getValue("e2e").jsonObject
    private val e2eSprints get() = expectedE2e.getValue("preview").jsonArray.map { it.jsonObject }
    private val database get() = sharedDatabaseForTests()

    @AfterTest
    fun cleanUp() {
        FlowStubServer.resetScenarios()
        jbSql("DELETE FROM team_capacity_periods WHERE team_id IN (SELECT id FROM teams WHERE name LIKE '$PREFIX%')")
        stubHarness.cleanUp(PREFIX)
        mirrors.forEach { it.cleanUp() }
        mirrors.clear()
        removeFlowFixtureRows(PREFIX)
        jbSql("DELETE FROM teams WHERE name LIKE '$PREFIX%'")
        ownUsers.forEach { jbSql("DELETE FROM users WHERE id = ?", it.toInt()) }
        ownUsers.clear()
    }

    // ---- fixtures -------------------------------------------------------------------------------------------------------------

    private fun service(
        harness: FlowRunHarness = stubHarness,
        maxItems: Int = MAX_CAPACITY_DEVIATION_ITEMS,
        clock: () -> Long = System::currentTimeMillis,
    ) = CapacityDeviationService(database, harness.bindings, harness.mirror, TeamCapacityService(database), harness.runs, clock, maxItems)

    private fun instant(text: String) = { Instant.parse(text).toEpochMilli() }

    private class Bound(val connectionId: UInt, val teamId: UInt, val bindingId: UInt)

    /** The stub's "E2E Flow Team" mirrored by a real run and linked to a fresh team on a fresh connection. */
    private suspend fun e2eWorld(): Bound {
        val connectionId = stubHarness.connect(PREFIX, FlowStubServer.baseUrl, FlowStubServer.token)
        assertEquals(SyncOutcome.SUCCEEDED, stubHarness.run(connectionId).outcome)
        val flowTeam = stubHarness.mirror.teamsOf(connectionId).single { it.name == expectedE2e.getValue("team").jsonPrimitive.content }
        return bound(connectionId, stubHarness.bind(PREFIX, connectionId, flowTeam.flowTeamId, flowTeam.name))
    }

    private suspend fun bound(connectionId: UInt, teamId: UInt) =
        Bound(connectionId, teamId, stubHarness.bindings.bindingsOf(connectionId).single { it.teamId == teamId }.id)

    /** Imports every CREATE/UPDATE row of the team's preview (what the page's Import capacity does), through the services. */
    private suspend fun importAll(bound: Bound, firstRows: Int = Int.MAX_VALUE) {
        val imports = CapacityImportService(database, stubHarness.bindings, stubHarness.mirror, TeamCapacityService(database))
        val preview = checkNotNull(imports.preview(bound.bindingId, null, includeClosed = false))
        val rows = preview.items.filter { it.action == CapacityAction.CREATE || it.action == CapacityAction.UPDATE }.take(firstRows).map {
            CapacityApplyRow(it.sprintId, it.action, LocalDate.parse(it.effectiveFrom), BigDecimal.valueOf(checkNotNull(it.mdPerWeek)))
        }
        imports.apply(bound.bindingId, CapacityApplyCommand(null, false, rows, emptyList())) { }
    }

    private fun seedManualPeriod(teamId: UInt, from: String, md: String) = jbSql(
        "INSERT INTO team_capacity_periods (team_id, effective_from, md_per_week, source, created_at, updated_at) " +
            "VALUES (?, ?::date, ?::numeric, 'MANUAL', 1, 1)",
        teamId.toInt(), from, md,
    )

    /** A scripted mirror of [teams] (Flow team ids 1, 2, ...), one dated sprint each; the connection is named `capdev-...`. */
    private suspend fun scripted(vararg teams: Pair<String, String>): ScriptedFlowMirror {
        val docs = teams.mapIndexed { i, (name, sprint) -> flowTeamDoc(i + 1, name, sprints = listOf(sprint)) }
        return ScriptedFlowMirror(PREFIX).connect().refresh(*docs.toTypedArray()).also { mirrors += it }
    }

    /** Links a fresh team named `capdev-<label>-xxxx` to Flow team [flowTeamId] of [connectionId]. */
    private suspend fun linkOwn(connectionId: UInt, flowTeamId: Int, label: String): UInt {
        val teamId = TestTeams.seed(flowUnique("$PREFIX-$label"))
        val user = TestUsers.seed(uniqueEmail(PREFIX), "pw").also { ownUsers += it }
        jbSql(
            "INSERT INTO flow_team_bindings (connection_id, team_id, flow_team_id, flow_team_name, created_by_user_id, created_at, " +
                "updated_at) VALUES (?, ?, ?, ?, ?, 1, 1)",
            connectionId.toInt(), teamId.toInt(), flowTeamId, "FT $label", user.toInt(),
        )
        return teamId
    }

    private fun sprint2049(id: Long) = ciSprint(id, "S$id", "2049-01-04", "2049-01-15", "40")

    private suspend fun HttpClient.view(query: String): CapacityDeviationView {
        val response = get("$VIEW$query")
        assertEquals(HttpStatusCode.OK, response.status, response.bodyAsText())
        return fbJson.decodeFromString(response.bodyAsText())
    }

    private fun CapacityDeviationView.sprintIds(): List<Long> = items.flatMap { it.deviations }.mapNotNull { it.detail.sprintId }

    private fun md(value: Any) = BigDecimal(value.toString()).setScale(2)

    // ---- the stub's E2E Flow Team ---------------------------------------------------------------------------------------------

    @Test
    fun `a linked team without periods lists its six sprints as CAPACITY_MISSING, and an import brings it in line`() = testApplication {
        usePostgresTestcontainer()
        val client = seededClient(PREFIX)
        val world = e2eWorld()

        val dayBefore = LocalDate.now(ZoneOffset.UTC)
        val response = client.get("$VIEW?connectionId=${world.connectionId}")
        val dayAfter = LocalDate.now(ZoneOffset.UTC)
        assertEquals(HttpStatusCode.OK, response.status)
        val text = response.bodyAsText()
        assertFalse(text.contains("http", ignoreCase = true), "no base URL on the wire")
        assertFalse(text.contains(FlowStubServer.token), "the Flow token never leaves the registry")
        val before = fbJson.decodeFromString<CapacityDeviationView>(text)

        assertTrue(before.asOf in setOf(dayBefore.toString(), dayAfter.toString()), "asOf is the UTC date of the read")
        assertFalse(before.truncated)
        assertEquals(1, before.items.size)
        val item = before.items.single()
        assertEquals(world.teamId, item.team.id)
        assertEquals(world.bindingId, item.bindingId)
        assertEquals(world.connectionId, item.connectionId)
        assertEquals(expectedE2e.getValue("team").jsonPrimitive.content, item.flowTeam.name)
        assertEquals("Europe/Warsaw", item.zone)
        assertNotNull(item.observedAt)
        assertEquals(e2eSprints.size, item.deviations.size)
        e2eSprints.zip(item.deviations).forEach { (want, got) ->
            val detail = got.detail
            assertEquals(CapacityDeviationKind.CAPACITY_MISSING, got.kind)
            assertEquals(DeviationSeverity.INFO, got.severity)
            assertEquals(want.getValue("sprintId").jsonPrimitive.content.toLong(), detail.sprintId)
            assertEquals(want.getValue("name").jsonPrimitive.content, detail.sprintName)
            assertEquals(want.getValue("start").jsonPrimitive.content, detail.start)
            assertEquals(want.getValue("end").jsonPrimitive.content, detail.end)
            assertEquals(want.getValue("start").jsonPrimitive.content, detail.effectiveFrom, "no earlier sprint shares a day")
            assertEquals(want.getValue("workingDays").jsonPrimitive.content.toInt(), detail.workingDays)
            assertEquals(0, md(want.getValue("flowMd").jsonPrimitive.content).compareTo(md(checkNotNull(detail.flowMd))))
            assertEquals(detail.flowMd, detail.flowTotalMd, "a calendar sprint holds all its days")
            assertNull(detail.planMd)
            assertNull(detail.gapMd)
        }
        assertEquals(listOf(0, e2eSprints.size, 0, 1), before.totals.let { listOf(it.warnings, it.infos, it.gone, it.teams) })
        val connection = before.connections.single()
        assertEquals(world.connectionId, connection.id)
        assertTrue(connection.enabled)
        assertEquals(SyncState.CURRENT, connection.status.state)
        assertNotNull(connection.teamsAt)

        importAll(world)

        val after = client.view("?connectionId=${world.connectionId}")
        assertEquals(emptyList(), after.items, "a clean import is in line with Flow")
        assertEquals(listOf(0, 0, 0, 0), after.totals.let { listOf(it.warnings, it.infos, it.gone, it.teams) })
        assertEquals(1, after.connections.size)
    }

    @Test
    fun `a manual 20 a week period raises the E2E vector - a warning when the plan has more, an info when less`() = testApplication {
        usePostgresTestcontainer()
        val client = seededClient(PREFIX)
        val world = e2eWorld()
        seedManualPeriod(world.teamId, e2eSprints.first().getValue("start").jsonPrimitive.content, "20.00")

        val view = client.view("?connectionId=${world.connectionId}")

        val gaps = e2eSprints.map { md(40).subtract(md(it.getValue("flowMd").jsonPrimitive.content)) }
        val deviating = e2eSprints.zip(gaps).filter { it.second.signum() != 0 }
        assertEquals(4, deviating.size, "40 against 40 / 36 / 44 / 40 / 38 / 42: two sprints more, two less, two in line")
        val rows = view.items.single().deviations
        assertEquals(deviating.map { it.first.getValue("sprintId").jsonPrimitive.content.toLong() }, rows.mapNotNull { it.detail.sprintId })
        rows.zip(deviating).forEach { (row, want) ->
            assertEquals(CapacityDeviationKind.CAPACITY_DIFFERS, row.kind)
            assertEquals(if (want.second.signum() > 0) DeviationSeverity.WARNING else DeviationSeverity.INFO, row.severity)
            assertEquals(0, md(40).compareTo(md(checkNotNull(row.detail.planMd))), "20 a week over ten working days")
            assertEquals(0, want.second.compareTo(md(checkNotNull(row.detail.gapMd))))
        }
        val warnings = rows.count { it.severity == DeviationSeverity.WARNING }
        assertEquals(listOf(warnings, rows.size - warnings, 0, 1), view.totals.let { listOf(it.warnings, it.infos, it.gone, it.teams) })
    }

    /** Day two against an imported team: its 90002 and 90003 change in Flow, and a team linked to Billing (gone on day two) is added. */
    private suspend fun day2World(): Pair<Bound, Bound> {
        val e2e = e2eWorld()
        val billingFlowId = stubHarness.mirror.teamsOf(e2e.connectionId).single { it.name == "Billing" }.flowTeamId
        val billing = bound(e2e.connectionId, stubHarness.bind(PREFIX, e2e.connectionId, billingFlowId, "Billing"))
        importAll(e2e)
        val scenarios = FlowStubServer.expected.getValue("scenarios").jsonObject
        FlowStubServer.setScenarioState(
            scenarios.getValue("day2").jsonPrimitive.content,
            scenarios.getValue("day2State").jsonPrimitive.content,
        )
        assertEquals(SyncOutcome.SUCCEEDED, stubHarness.run(e2e.connectionId).outcome)
        return e2e to billing
    }

    private fun day2Changes() = FlowStubServer.expected.getValue("day2").jsonObject.getValue("capacityChanges").jsonArray
        .map { it.jsonObject }.filter { it.getValue("team").jsonPrimitive.content == expectedE2e.getValue("team").jsonPrimitive.content }

    @Test
    fun `day two - the imported team has more than Flow for one sprint and less for another, and Billing reads gone`() = testApplication {
        usePostgresTestcontainer()
        val client = seededClient(PREFIX)
        try {
            val (e2e, billing) = day2World()

            val view = client.view("?connectionId=${e2e.connectionId}")

            val changes = day2Changes()
            assertEquals(2, changes.size)
            val e2eItem = view.items.single { it.team.id == e2e.teamId }
            val changedIds = changes.map { it.getValue("sprintId").jsonPrimitive.content.toLong() }
            assertEquals(changedIds, e2eItem.deviations.mapNotNull { it.detail.sprintId })
            e2eItem.deviations.zip(changes).forEach { (row, change) ->
                val from = md(change.getValue("from").jsonPrimitive.content)
                val to = md(change.getValue("to").jsonPrimitive.content)
                val gap = from.subtract(to)
                assertEquals(CapacityDeviationKind.CAPACITY_DIFFERS, row.kind)
                assertEquals(if (gap.signum() > 0) DeviationSeverity.WARNING else DeviationSeverity.INFO, row.severity)
                assertEquals(0, from.compareTo(md(checkNotNull(row.detail.planMd))), "the plan keeps the imported day-one figure")
                assertEquals(0, to.compareTo(md(checkNotNull(row.detail.flowMd))), "Flow now says the changed figure")
                assertEquals(0, gap.compareTo(md(checkNotNull(row.detail.gapMd))))
            }
            val goneItem = view.items.single { it.team.id == billing.teamId }
            assertEquals(1, goneItem.deviations.size)
            val gone = goneItem.deviations.single()
            assertEquals(CapacityDeviationKind.TEAM_GONE, gone.kind)
            assertEquals(DeviationSeverity.WARNING, gone.severity)
            assertNull(gone.detail.sprintId)
            assertNull(gone.detail.planMd)
            assertNull(goneItem.observedAt)
            assertEquals(listOf(2, 1, 1, 2), view.totals.let { listOf(it.warnings, it.infos, it.gone, it.teams) })
            assertEquals(SyncState.CURRENT, view.connections.single().status.state)
        } finally {
            FlowStubServer.resetScenarios()
        }
    }

    @Test
    fun `the filters narrow the teams and, for severity and kind, the rows of each team`() = testApplication {
        usePostgresTestcontainer()
        val client = seededClient(PREFIX)
        try {
            val (e2e, billing) = day2World()
            val mine = "connectionId=${e2e.connectionId}"
            val both = client.view("?$mine")
            val warnSprint = both.items.single { it.team.id == e2e.teamId }.deviations.single { it.severity == DeviationSeverity.WARNING }
            val infoSprint = both.items.single { it.team.id == e2e.teamId }.deviations.single { it.severity == DeviationSeverity.INFO }

            val warnings = client.view("?$mine&severity=WARNING")
            assertEquals(listOf(e2e.teamId, billing.teamId).sorted(), warnings.items.map { it.team.id }.sorted())
            val warnedRows = warnings.items.single { it.team.id == e2e.teamId }.deviations
            assertEquals(listOf(warnSprint.detail.sprintId), warnedRows.map { it.detail.sprintId })
            assertEquals(listOf(2, 0, 1, 2), warnings.totals.let { listOf(it.warnings, it.infos, it.gone, it.teams) })

            val infos = client.view("?$mine&severity=INFO")
            assertEquals(listOf(e2e.teamId), infos.items.map { it.team.id }, "the gone team has no info row")
            assertEquals(listOf(infoSprint.detail.sprintId), infos.sprintIds())
            assertEquals(listOf(0, 1, 0, 1), infos.totals.let { listOf(it.warnings, it.infos, it.gone, it.teams) })

            val gone = client.view("?$mine&kind=TEAM_GONE")
            assertEquals(listOf(billing.teamId), gone.items.map { it.team.id })
            val differs = client.view("?$mine&kind=CAPACITY_DIFFERS")
            assertEquals(listOf(e2e.teamId), differs.items.map { it.team.id })
            assertEquals(2, differs.items.single().deviations.size)
            assertEquals(emptyList(), client.view("?$mine&kind=CAPACITY_MISSING").items)
            assertEquals(emptyList(), client.view("?$mine&kind=TEAM_GONE&severity=INFO").items, "the filters combine")

            val team = client.view("?$mine&teamId=${billing.teamId}")
            assertEquals(listOf(billing.teamId), team.items.map { it.team.id })
            assertEquals(1, team.connections.size, "teamId narrows the teams, not the connections")

            val unknown = client.view("?connectionId=${e2e.connectionId + 1_000_000u}")
            assertEquals(emptyList(), unknown.items)
            assertEquals(emptyList(), unknown.connections)
        } finally {
            FlowStubServer.resetScenarios()
        }
    }

    @Test
    fun `a repeated or malformed filter is a 400, an unknown parameter is ignored and any signed-in user reads`() = testApplication {
        usePostgresTestcontainer()
        val client = seededClient(PREFIX)
        for (query in listOf(
            "teamId=1&teamId=2", "connectionId=1&connectionId=1", "severity=WARNING&severity=INFO", "kind=TEAM_GONE&kind=TEAM_GONE",
            "teamId=abc", "connectionId=-1", "severity=BOGUS", "kind=BOGUS", "severity=warning",
        )) {
            assertEquals(HttpStatusCode.BadRequest, client.get("$VIEW?$query").status, query)
        }
        val ignored = client.get("$VIEW?connectionId=999999999&unknownName=1")
        assertEquals(HttpStatusCode.OK, ignored.status)
    }

    // ---- the clock ------------------------------------------------------------------------------------------------------------

    @Test
    fun `a closed sprint is absent end to end, asOf is the UTC date and today is the connection's zone`() = runBlocking {
        val world = e2eWorld()
        val filter = CapacityDeviationFilter(connectionId = world.connectionId)
        // Sprint 1 ends 2047-01-18 (closed on the 25th), sprint 2 ends 2047-02-01 (current).
        val midSprintTwo = service(clock = instant("2047-01-25T10:00:00Z")).view(filter)
        assertEquals("2047-01-25", midSprintTwo.asOf)
        assertEquals(e2eSprints.drop(1).map { it.getValue("sprintId").jsonPrimitive.content.toLong() }, midSprintTwo.sprintIds())
        assertTrue(90001L !in midSprintTwo.sprintIds())

        // 2047-02-01T23:30Z is still 02-01 in UTC (asOf) but already 02-02 in Warsaw, where sprint 2 has ended: it is closed there.
        val lateEvening = service(clock = instant("2047-02-01T23:30:00Z")).view(filter)
        assertEquals("2047-02-01", lateEvening.asOf)
        assertEquals(e2eSprints.drop(2).map { it.getValue("sprintId").jsonPrimitive.content.toLong() }, lateEvening.sprintIds())

        val allClosed = service(clock = instant("2047-04-01T10:00:00Z")).view(filter)
        assertEquals(emptyList(), allClosed.items)
        assertEquals(1, allClosed.connections.size)
    }

    // ---- scripted mirrors -----------------------------------------------------------------------------------------------------

    @Test
    fun `the order puts a team with a warning first, then by name ignoring case, and the cap truncates after the totals`() = runBlocking {
        val mirror = scripted("FZ" to sprint2049(11), "FA" to sprint2049(12), "FB" to sprint2049(13))
        val zeta = linkOwn(mirror.connectionId, 1, "Zeta")
        val alpha = linkOwn(mirror.connectionId, 2, "Alpha")
        val beta = linkOwn(mirror.connectionId, 3, "beta")
        seedManualPeriod(zeta, "2049-01-04", "30.00") // 60 against Flow's 40: +20, a warning
        seedManualPeriod(alpha, "2049-01-04", "10.00") // 20 against 40: -20, an info
        seedManualPeriod(beta, "2049-01-04", "30.00")
        val clock = instant("2048-12-01T10:00:00Z")
        val filter = CapacityDeviationFilter(connectionId = mirror.connectionId)

        val view = service(mirror.harness, clock = clock).view(filter)

        assertEquals(listOf(beta, zeta, alpha), view.items.map { it.team.id }, "warnings first; beta before Zeta without regard to case")
        assertEquals(listOf(2, 1, 0, 3), view.totals.let { listOf(it.warnings, it.infos, it.gone, it.teams) })
        assertFalse(view.truncated)

        val capped = service(mirror.harness, maxItems = 1, clock = clock).view(filter)
        assertTrue(capped.truncated)
        assertEquals(listOf(beta), capped.items.map { it.team.id })
        val cappedTotals = capped.totals.let { listOf(it.warnings, it.infos, it.gone, it.teams) }
        assertEquals(listOf(2, 1, 0, 3), cappedTotals, "totals are before the cap")
        assertFalse(service(mirror.harness, maxItems = 3, clock = clock).view(filter).truncated)
    }

    @Test
    fun `a disabled connection keeps its teams in the view with a DISABLED status`() = runBlocking {
        val mirror = scripted("FT" to sprint2049(21))
        val teamId = linkOwn(mirror.connectionId, 1, "off")
        jbSql("UPDATE flow_connections SET enabled = false WHERE id = ?", mirror.connectionId.toInt())

        val view = service(mirror.harness).view(CapacityDeviationFilter(connectionId = mirror.connectionId))

        val connection = view.connections.single()
        assertFalse(connection.enabled)
        assertEquals(SyncState.DISABLED, connection.status.state)
        assertEquals(listOf(teamId), view.items.map { it.team.id })
        assertEquals(listOf(CapacityDeviationKind.CAPACITY_MISSING), view.items.single().deviations.map { it.kind })
    }

    @Test
    fun `a connection that never mirrored a document lists no teams, and a deleted team is hidden`() = runBlocking {
        val never = stubHarness.connect(PREFIX, FlowStubServer.baseUrl, FlowStubServer.token)
        stubHarness.bind(PREFIX, never, 1, "FT")
        val neverView = service().view(CapacityDeviationFilter(connectionId = never))
        assertEquals(emptyList(), neverView.items, "nothing was mirrored, so nothing is missing from it")
        assertEquals(listOf(SyncState.NEVER_SYNCED), neverView.connections.map { it.status.state })
        assertNull(neverView.connections.single().teamsAt)

        val mirror = scripted("FT" to sprint2049(31))
        val teamId = linkOwn(mirror.connectionId, 1, "doomed")
        val filter = CapacityDeviationFilter(connectionId = mirror.connectionId)
        assertEquals(listOf(teamId), service(mirror.harness).view(filter).items.map { it.team.id })
        jbSql("UPDATE teams SET marked_as_deleted = true WHERE id = ?", teamId.toInt())
        assertEquals(emptyList(), service(mirror.harness).view(filter).items, "the team's soft delete hides its link")
    }

    @Test
    fun `a Flow team missing from a mirrored document is TEAM_GONE alone, whatever its periods`() = runBlocking {
        val mirror = scripted("FA" to sprint2049(41))
        val teamId = linkOwn(mirror.connectionId, 7, "vanished") // Flow team 7 is not in the document
        seedManualPeriod(teamId, "2049-01-04", "30.00")

        val view = service(mirror.harness).view(CapacityDeviationFilter(connectionId = mirror.connectionId))

        val rows: List<CapacityDeviation> = view.items.single().deviations
        assertEquals(listOf(CapacityDeviationKind.TEAM_GONE), rows.map { it.kind })
        assertEquals(listOf(1, 0, 1, 1), view.totals.let { listOf(it.warnings, it.infos, it.gone, it.teams) })
        assertNull(view.items.single().observedAt)
    }

    @Test
    fun `a soft-deleted connection hides its teams, whether or not its links are still active`() = runBlocking {
        val kept = scripted("FT" to sprint2049(51))
        linkOwn(kept.connectionId, 1, "kept")
        val hidden = scripted("FT" to sprint2049(52))
        val hiddenTeam = linkOwn(hidden.connectionId, 1, "hidden")
        val hiddenFilter = CapacityDeviationFilter(connectionId = hidden.connectionId)
        assertEquals(listOf(hiddenTeam), service(hidden.harness).view(hiddenFilter).items.map { it.team.id })

        // Only the connection row is soft-deleted: its link, mirror and team are untouched, so the connection rule alone hides the item.
        jbSql("UPDATE flow_connections SET marked_as_deleted = true WHERE id = ?", hidden.connectionId.toInt())

        val view = service(hidden.harness).view(CapacityDeviationFilter())
        assertTrue(view.items.none { it.connectionId == hidden.connectionId })
        assertTrue(view.connections.none { it.id == hidden.connectionId })
        assertEquals(1, view.items.count { it.connectionId == kept.connectionId }, "another connection is unaffected")
        assertEquals(emptyList(), service(hidden.harness).view(hiddenFilter).items)
    }

    @Test
    fun `a truncated Flow document keeps an absent team without TEAM_GONE, a complete one that omits it marks it gone`() = runBlocking {
        val mirror = scripted("FA" to sprint2049(61), "FB" to sprint2049(62))
        val teamId = linkOwn(mirror.connectionId, 2, "absent") // Flow team 2
        val filter = CapacityDeviationFilter(connectionId = mirror.connectionId)
        suspend fun kinds() = service(mirror.harness).view(filter).items.single().deviations.map { it.kind }

        mirror.refreshTruncated(flowTeamDoc(1, "FA", sprints = listOf(sprint2049(61))))
        assertEquals(listOf(CapacityDeviationKind.CAPACITY_MISSING), kinds(), "the team stays mirrored: judged on its sprints, not gone")

        mirror.refresh(flowTeamDoc(1, "FA", sprints = listOf(sprint2049(61))))
        assertEquals(listOf(CapacityDeviationKind.TEAM_GONE), kinds())
        assertEquals(teamId, service(mirror.harness).view(filter).items.single().team.id)
    }

    @Test
    fun `every UNCHANGED row of the preview has no deviation row, for a team part-imported and part-edited by hand`() = runBlocking {
        val world = e2eWorld()
        importAll(world, firstRows = 4)
        // Sprint 2's imported period is edited by hand: 25 a week makes 50 against Flow's 36, and the row turns MANUAL.
        val secondStart = e2eSprints[1].getValue("start").jsonPrimitive.content
        jbSql(
            "UPDATE team_capacity_periods SET md_per_week = 25, source = 'MANUAL', flow_sprint_id = NULL, flow_sprint_name = NULL " +
                "WHERE team_id = ? AND effective_from = ?::date AND NOT marked_as_deleted",
            world.teamId.toInt(), secondStart,
        )
        val imports = CapacityImportService(database, stubHarness.bindings, stubHarness.mirror, TeamCapacityService(database))
        val preview = checkNotNull(imports.preview(world.bindingId, null, includeClosed = false))
        val view = service().view(CapacityDeviationFilter(connectionId = world.connectionId))
        val deviating = view.items.flatMap { it.deviations }.mapNotNull { it.detail.sprintId }.toSet()

        val unchanged = preview.items.filter { it.action == CapacityAction.UNCHANGED }.map { it.sprintId }
        assertEquals(setOf(90001L, 90003L, 90004L), unchanged.toSet(), "sprints 1, 3 and 4 are imported and untouched")
        assertTrue(deviating.none { it in unchanged }, "an UNCHANGED preview row is in line with Flow")
        assertEquals(setOf(90002L, 90005L, 90006L), deviating, "the hand-edited sprint and the two not yet imported")
        assertEquals(CapacityAction.MANUAL_PERIOD, preview.items.single { it.sprintId == 90002L }.action)
    }
}
