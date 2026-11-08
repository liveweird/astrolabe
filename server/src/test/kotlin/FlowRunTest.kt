package ch.nokillswit

import ch.nokillswit.flow.FlowClientFactory
import ch.nokillswit.flow.HttpFlowClient
import ch.nokillswit.flow.buildGuardedFlowHttpClient
import ch.nokillswit.flow.createFlowHttp
import ch.nokillswit.infra.outbound.FlowOrigins
import ch.nokillswit.infra.outbound.Origin
import ch.nokillswit.infra.outbound.SelfManagedHosts
import ch.nokillswit.sync.SyncOutcome
import ch.nokillswit.sync.SyncState
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.AfterClass
import org.junit.BeforeClass
import java.math.BigDecimal
import java.net.URI
import kotlin.test.AfterTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * The Flow run against the shared [FlowStubServer] (the exact `sample-data/flow-stub` contract) through the real guarded transport: the
 * mirror's counts equal the generator's `expected.json`, day two drops a team a binding points at, an outage and a revoked token fail
 * typed and leave the mirror alone. Scenario state is shared suite state: every test that flips one resets it in a `finally`.
 */
class FlowRunTest {
    private companion object {
        const val PREFIX = "flow-run"

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

    // maxRetries 0: a deliberately failing stub must not sleep through real backoff.
    private val harness = FlowRunHarness(
        FlowClientFactory { baseUrl, token -> HttpFlowClient(createFlowHttp(guarded, 0, 4L * 1024 * 1024, 1), baseUrl, token) },
    )
    private val expected: JsonObject get() = FlowStubServer.expected
    private val expectedTeams get() = expected.getValue("teams").jsonArray.map { it.jsonObject }

    @AfterTest
    fun cleanUp() {
        FlowStubServer.resetScenarios()
        harness.cleanUp(PREFIX)
    }

    private suspend fun connect(token: String = FlowStubServer.token) = harness.connect(PREFIX, FlowStubServer.baseUrl, token)

    private suspend fun flowTeamId(connectionId: UInt, name: String) =
        harness.mirror.teamsOf(connectionId).single { it.name == name }.flowTeamId

    private fun flip(scenario: String, state: String) {
        val scenarios = expected.getValue("scenarios").jsonObject
        FlowStubServer.setScenarioState(scenarios.getValue(scenario).jsonPrimitive.content, scenarios.getValue(state).jsonPrimitive.content)
    }

    @Test
    fun `a tested connection goes NEVER_SYNCED to CURRENT and the mirror's counts equal expected json`() = runBlocking {
        val id = connect()
        val before = harness.connections.read(id)!!
        assertEquals(SyncState.NEVER_SYNCED, before.status.state)
        assertNull(before.teamsAt)

        val result = harness.run(id)

        assertEquals(SyncOutcome.SUCCEEDED, result.outcome)
        val totals = expected.getValue("totals").jsonObject
        assertEquals(totals.getValue("teams").jsonPrimitive.content.toInt(), result.counts.observed)
        assertEquals(Pair(0, 1), Pair(result.counts.gone, result.counts.calls))
        val after = harness.connections.read(id)!!
        assertEquals(SyncState.CURRENT, after.status.state)
        assertEquals(SyncOutcome.SUCCEEDED, after.lastRun!!.outcome)
        assertNotNull(after.teamsAt)

        val mirrored = harness.mirror.teamsOf(id).associateBy { it.name }
        assertEquals(expectedTeams.size, mirrored.size)
        for (team in expectedTeams) {
            val name = team.getValue("name").jsonPrimitive.content
            val row = mirrored.getValue(name)
            assertEquals(team.getValue("sprints").jsonObject.getValue("count").jsonPrimitive.content.toInt(), row.sprintCount, name)
            assertEquals(team.getValue("members").jsonObject.getValue("rows").jsonPrimitive.content.toInt(), row.memberCount, name)
        }
        assertEquals(totals.getValue("sprints").jsonPrimitive.content.toInt(), mirrored.values.sumOf { it.sprintCount })
        assertEquals(totals.getValue("memberRows").jsonPrimitive.content.toInt(), mirrored.values.sumOf { it.memberCount })
    }

    @Test
    fun `day two drops Billing from the mirror, counts the bound team gone and re-dates the changed sprint capacities`() = runBlocking {
        val id = connect()
        assertEquals(SyncOutcome.SUCCEEDED, harness.run(id).outcome)
        val billing = flowTeamId(id, "Billing")
        val platform = flowTeamId(id, "Platform")
        harness.bind(PREFIX, id, billing, "Billing")
        harness.bind(PREFIX, id, platform, "Platform")
        val day2 = expected.getValue("day2").jsonObject
        val changes = day2.getValue("capacityChanges").jsonArray.map { it.jsonObject }
        val change = changes.first { it.getValue("team").jsonPrimitive.content == "Platform" }
        try {
            // Day one: both bound teams are in the document.
            assertEquals(0, harness.run(id).counts.gone)
            flip("day2", "day2State")

            val result = harness.run(id)

            assertEquals(SyncOutcome.SUCCEEDED, result.outcome)
            assertEquals(day2.getValue("teams").jsonPrimitive.content.toInt(), result.counts.observed)
            assertEquals(day2.getValue("gone").jsonArray.size, result.counts.gone, "the bound Billing is gone, bound Platform is not")
            val names = harness.mirror.teamsOf(id).map { it.name }
            assertTrue("Billing" !in names && "Platform" in names)
            val changedId = change.getValue("sprintId").jsonPrimitive.content.toLong()
            val sprint = harness.mirror.sprintsOf(id, platform).single { it.sprintId == changedId }
            val newFigure = BigDecimal(change.getValue("to").jsonPrimitive.content)
            assertEquals(0, newFigure.compareTo(sprint.capacityMd), "the new figure replaced the old")
        } finally {
            FlowStubServer.resetScenarios()
        }
    }

    @Test
    fun `an outage fails UPSTREAM_UNAVAILABLE and the mirror keeps its last document until Flow is back`() = runBlocking {
        val id = connect()
        assertEquals(SyncOutcome.SUCCEEDED, harness.run(id).outcome)
        try {
            flip("outage", "outageState")
            val failed = harness.run(id)
            assertEquals("UPSTREAM_UNAVAILABLE", failed.errorCode)
            assertEquals(expectedTeams.size, harness.mirror.teamsOf(id).size, "the last document is still there")
            val status = harness.connections.read(id)!!.status
            assertEquals(Pair(SyncState.FAILED, 1), Pair(status.state, status.consecutiveFailures))
            assertTrue(status.nextPollAt!! > status.lastRun!!.finishedAt!!, "the retry waits")
        } finally {
            FlowStubServer.resetScenarios()
        }
        assertEquals(SyncOutcome.SUCCEEDED, harness.run(id).outcome)
        assertEquals(SyncState.CURRENT, harness.connections.read(id)!!.status.state)
    }

    @Test
    fun `a token the stub does not know fails AUTHENTICATION_FAILED and writes no mirror`() = runBlocking {
        val id = connect(flowToken('q'))
        val result = harness.run(id)
        assertEquals(Pair(SyncOutcome.FAILED, "AUTHENTICATION_FAILED"), Pair(result.outcome, result.errorCode))
        assertEquals(0, harness.mirror.teamsOf(id).size)
        assertEquals(SyncState.FAILED, harness.connections.read(id)!!.status.state)
    }
}
