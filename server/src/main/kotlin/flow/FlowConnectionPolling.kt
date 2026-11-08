package ch.nokillswit.flow

import ch.nokillswit.infra.db.active
import ch.nokillswit.sync.ConnectorConnection
import ch.nokillswit.sync.SyncKind
import ch.nokillswit.sync.SyncRunService
import ch.nokillswit.sync.SyncStatus
import ch.nokillswit.sync.SyncStatusKernels
import kotlinx.coroutines.flow.toList
import org.jetbrains.exposed.v1.core.*
import org.jetbrains.exposed.v1.r2dbc.*
import org.jetbrains.exposed.v1.r2dbc.transactions.suspendTransaction

/**
 * The scheduler's rows of the Flow connections (`FlowConnectionService.pollRows`, the twin of `jira/JiraConnectionPolling.kt`): every
 * ACTIVE connection, in id order, as the connector-agnostic [ConnectorConnection]. It selects EIGHT columns by name - never the encrypted
 * token - so the timer's read can neither decrypt a credential nor carry one into a log line.
 *
 * `ready` is "a Test connection passed, or a run has already mirrored a document" (`last_test_ok` or `teams_at`), and it is STICKY the
 * way Jira's `discovered_at != null` is: an untested connection could only fail, so it is not polled, but once Flow has answered a run
 * the connection stays pollable. C4 clears the test verdict on a changed token or zone (the last test judged the old ones) and a later
 * Test that hit a Flow outage records `last_test_ok = false`; neither may stop a connection that has run from polling (the rotated token
 * is exactly what must be tried at once). `changedAt` is the later of the row's last edit and its last test: a rotated token
 * (`updated_at`) or a fresh passing test makes the connection due at once, whatever a failure back-off says.
 */
internal suspend fun pollRowsOf(database: R2dbcDatabase, queryTimeoutSeconds: Int = 0): List<ConnectorConnection> =
    suspendTransaction(database) {
        queryTimeout = queryTimeoutSeconds
        val connections = FlowConnectionService.Connections
        connections.select(
            connections.id, connections.name, connections.enabled, connections.pollIntervalMinutes,
            connections.lastTestOk, connections.teamsAt, connections.updatedAt, connections.lastTestedAt,
        ).where { connections.active() }.orderBy(connections.id).toList().map { it.toConnectorConnection() }
    }

/** A connection row as the scheduler and the status see it; needs the eight columns of [pollRowsOf] among the row's. */
internal fun ResultRow.toConnectorConnection(): ConnectorConnection {
    val connections = FlowConnectionService.Connections
    return ConnectorConnection(
        id = this[connections.id].value,
        name = this[connections.name],
        enabled = this[connections.enabled],
        pollIntervalMinutes = this[connections.pollIntervalMinutes],
        ready = this[connections.lastTestOk] == true || this[connections.teamsAt] != null,
        changedAt = maxOf(this[connections.updatedAt], this[connections.lastTestedAt] ?: 0L),
    )
}

/**
 * The status of each of [connections] (`SyncStatusKernels.derive`): the connections' newest runs read INSIDE the caller's open
 * transaction (it opens none), one indexed query per connection, judged against the registry's clock. Index-aligned with [connections].
 */
internal suspend fun SyncRunService.statusesInTransaction(connections: List<ConnectorConnection>): List<SyncStatus> {
    val now = now()
    val recent = recentRunsInTransaction(SyncKind.FLOW, connections.map { it.id })
    return connections.map { SyncStatusKernels.derive(it, recent.getValue(it.id), now, maxRunMinutes) }
}
