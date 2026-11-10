package ch.nokillswit

import ch.nokillswit.flow.FlowConnectionRequest
import ch.nokillswit.flow.FlowConnectionService
import ch.nokillswit.flow.FlowMirrorMember
import ch.nokillswit.flow.FlowMirrorSprint
import ch.nokillswit.flow.FlowMirrorStore
import ch.nokillswit.flow.FlowMirrorTeam
import ch.nokillswit.flow.FlowTeamBindingService
import ch.nokillswit.infra.crypto.DEV_DATA_ENCRYPTION_KEY
import ch.nokillswit.infra.crypto.FieldCipher
import ch.nokillswit.infra.outbound.FlowBaseUrlVerdict
import ch.nokillswit.sync.SyncRunService
import java.math.BigDecimal
import java.util.UUID

/** The one origin the service-level Flow tests allow (the real predicate, `FlowOrigins.baseUrlVerdict`, is pinned by `FlowOriginsTest`). */
const val FLOW_TEST_ORIGIN = "http://flow.test:8080"

/** A syntactically valid Flow service token (`flow_int_` + 43 base64url characters); [fill] makes two tokens differ. */
fun flowToken(fill: Char = 'a'): String = "flow_int_" + fill.toString().repeat(43)

fun flowUnique(prefix: String) = "$prefix-${UUID.randomUUID().toString().substring(0, 8)}"

/** The suite's cipher: a real envelope under the key every other test boots with. */
val flowTestCipher = FieldCipher(DEV_DATA_ENCRYPTION_KEY)

/** The connection service over the shared test database, allowing exactly [FLOW_TEST_ORIGIN] (plus whatever [extraOrigins] adds). */
fun newFlowConnectionService(extraOrigins: Set<String> = emptySet()): FlowConnectionService {
    val database = sharedDatabaseForTests()
    return FlowConnectionService(database, flowTestCipher, SyncRunService(database, maxRunMinutes = 10)) {
        if (it == FLOW_TEST_ORIGIN || it in extraOrigins) FlowBaseUrlVerdict.ALLOWED else FlowBaseUrlVerdict.NOT_LISTED
    }
}

/** The origin rule of a service test that is not about origins: every base URL is allowed. */
val anyFlowOrigin: (String) -> FlowBaseUrlVerdict = { FlowBaseUrlVerdict.ALLOWED }

fun newFlowMirrorStore() = FlowMirrorStore(sharedDatabaseForTests())

fun newFlowBindingService() = FlowTeamBindingService(sharedDatabaseForTests())

fun flowRequest(
    name: String = flowUnique("flow-conn"),
    token: String? = flowToken(),
    timeZone: String = "Europe/Warsaw",
    enabled: Boolean = true,
    pollIntervalMinutes: Int? = 60,
) = FlowConnectionRequest(name, FLOW_TEST_ORIGIN, timeZone, token, enabled, pollIntervalMinutes)

fun flowSprint(id: Long, start: Long? = 1_000L, end: Long? = 2_000L, md: String? = "40.00", name: String = "Sprint $id") =
    FlowMirrorSprint(id, 1, name, "CLOSED", start, end, end, true, md?.let(::BigDecimal), md?.let { "CALENDAR" })

fun flowMember(account: String, from: Long = 1L, to: Long? = null, name: String? = "Name $account") =
    FlowMirrorMember(account, name, from, to)

fun flowTeam(
    id: Int,
    name: String = "Flow Team $id",
    sprints: List<FlowMirrorSprint> = emptyList(),
    members: List<FlowMirrorMember> = emptyList(),
) = FlowMirrorTeam(id, name, BigDecimal("30"), sprints, members)

/** The stored `api_token` of connection [id] (the envelope, or null on a deleted row): raw, past the service. */
fun flowStoredToken(id: UInt): String? = jbScalar("SELECT api_token FROM flow_connections WHERE id = ?", id.toInt()) { it.getString(1) }

/** Removes the fixture rows of connections named `namePrefix*` (children first): the shared tables keep nothing for later tests. */
fun removeFlowFixtureRows(namePrefix: String) {
    val mine = "SELECT id FROM flow_connections WHERE name LIKE '$namePrefix%'"
    // The acknowledgements (V26) reference the bindings: they go first.
    val bindings = "SELECT id FROM flow_team_bindings WHERE connection_id IN ($mine)"
    jbSql("DELETE FROM flow_capacity_acknowledgements WHERE binding_id IN ($bindings)")
    for (table in listOf("flow_members", "flow_sprints", "flow_teams", "flow_team_bindings")) {
        jbSql("DELETE FROM $table WHERE connection_id IN ($mine)")
    }
    jbSql("DELETE FROM sync_runs WHERE kind = 'FLOW' AND connection_id IN ($mine)")
    jbSql("DELETE FROM flow_connections WHERE name LIKE '$namePrefix%'")
}
