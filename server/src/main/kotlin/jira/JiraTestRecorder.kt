package ch.nokillswit.jira

import ch.nokillswit.infra.db.active
import io.ktor.util.AttributeKey
import kotlinx.coroutines.flow.toList
import org.jetbrains.exposed.v1.core.*
import org.jetbrains.exposed.v1.core.vendors.ForUpdateOption
import org.jetbrains.exposed.v1.r2dbc.*
import org.jetbrains.exposed.v1.r2dbc.transactions.suspendTransaction

val JiraTestRecorderKey = AttributeKey<JiraTestRecorder>("JiraTestRecorder")

/** What [JiraTestRecorder.recordTest] did: whether the result was stored, and the `discovered_at` now on the row. */
data class TestRecording(val recorded: Boolean, val discoveredAt: Long?)

/** [JiraTestRecorder.readDiscovery]'s answer for a connection no passing Test connection has discovered yet. */
const val NO_DISCOVERY = ""

/**
 * Where a stored-token Test connection's result lands: `last_tested_at`, `last_test_ok`, `cloud_id` and the discovery snapshot of the
 * `jira_connections` row. Split out of [JiraConnectionService] (the registry, the only code that touches `api_token`): this class never
 * selects, writes or sees the token column, so the credential's only readers stay the three in the service.
 */
class JiraTestRecorder(private val database: R2dbcDatabase) {
    private val connections = JiraConnectionService.Connections

    /**
     * Records a stored-token Test connection: `last_tested_at`/`last_test_ok` always (the real verdict), `cloud_id` when the test resolved
     * one, and - when [discovery] is given (both `field` and `issuetype` answered, whatever the other probes said) - the snapshot and
     * `discovered_at`. Skipped (`recorded` false) if the row vanished or was edited since [JiraTestTarget.expectedUpdatedAt] was read (a
     * rotated token, say: the result judged the old one). Does not bump `updated_at`. [TestRecording.discoveredAt] is the instant of the
     * snapshot now stored (this one, or the earlier one a test without a snapshot leaves in place).
     */
    suspend fun recordTest(
        id: UInt,
        expectedUpdatedAt: Long,
        cloudId: String?,
        ok: Boolean,
        discovery: JiraDiscovery?,
        at: Long,
    ): TestRecording =
        suspendTransaction(database) {
            // Only the columns the staleness check reads (never `api_token`, never the snapshot); the lock covers the whole row.
            val row = connections.select(connections.id, connections.updatedAt, connections.discoveredAt)
                .where { (connections.id eq id) and connections.active() }
                .forUpdate(ForUpdateOption.PostgreSQL.ForNoKeyUpdate).toList().singleOrNull()
            if (row == null || row[connections.updatedAt] != expectedUpdatedAt) return@suspendTransaction TestRecording(false, null)
            connections.update({ (connections.id eq id) and connections.active() }) {
                it[lastTestedAt] = at
                it[lastTestOk] = ok
                cloudId?.let { resolved -> it[connections.cloudId] = resolved }
                if (discovery != null) {
                    it[connections.discovery] = discovery.toStoredJson()
                    it[discoveredAt] = discovery.discoveredAt
                }
            }
            TestRecording(true, discovery?.discoveredAt ?: row[connections.discoveredAt])
        }

    /** The stored snapshot: null when the connection is missing, [NO_DISCOVERY] when no passing test stored one yet. */
    suspend fun readDiscovery(id: UInt): String? = suspendTransaction(database) {
        val row = connections.select(connections.discovery).where { (connections.id eq id) and connections.active() }
            .toList().singleOrNull() ?: return@suspendTransaction null
        row[connections.discovery] ?: NO_DISCOVERY
    }
}
