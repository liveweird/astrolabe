package ch.nokillswit.jira

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
 * The scheduler's rows of the Jira connections (`JiraConnectionService.pollRows`): every ACTIVE connection, in id order, as the
 * connector-agnostic [ConnectorConnection]. It selects SEVEN columns by name - never the encrypted token, never the discovery snapshot
 * (up to ~300 KB), the mapping or the site - so the timer's read can neither decrypt a credential nor carry one into a log line.
 *
 * `ready` is "a passing Test connection stored a discovery" (`discovered_at`), the one thing a run needs besides a readable token.
 * `changedAt` is the latest of the row's edit (`updated_at`), its last real mapping change and its last discovery: whichever input of
 * a run changed last, the very inputs the observer's full-read rule watches (jira-sync.md "Observations and the run").
 */
internal suspend fun pollRowsOf(database: R2dbcDatabase, queryTimeoutSeconds: Int = 0): List<ConnectorConnection> =
    suspendTransaction(database) {
        queryTimeout = queryTimeoutSeconds
        val connections = JiraConnectionService.Connections
        connections.select(
            connections.id, connections.name, connections.enabled, connections.pollIntervalMinutes,
            connections.discoveredAt, connections.mappingChangedAt, connections.updatedAt,
        ).where { connections.active() }.orderBy(connections.id).toList().map { it.toConnectorConnection() }
    }

/** A connection row as the scheduler and the status see it; needs the seven columns of [pollRowsOf] among the row's. */
internal fun ResultRow.toConnectorConnection(): ConnectorConnection {
    val connections = JiraConnectionService.Connections
    return ConnectorConnection(
        id = this[connections.id].value,
        name = this[connections.name],
        enabled = this[connections.enabled],
        pollIntervalMinutes = this[connections.pollIntervalMinutes],
        ready = this[connections.discoveredAt] != null,
        changedAt = maxOf(this[connections.updatedAt], this[connections.mappingChangedAt] ?: 0L, this[connections.discoveredAt] ?: 0L),
    )
}

/**
 * The status of each of [connections] (1.3, `SyncStatusKernels.derive`): the connections' newest runs read INSIDE the caller's open
 * transaction (it opens none), one indexed query per connection, judged against the registry's clock. Index-aligned with [connections].
 */
internal suspend fun SyncRunService.statusesInTransaction(connections: List<ConnectorConnection>): List<SyncStatus> {
    val now = now()
    val recent = recentRunsInTransaction(SyncKind.JIRA, connections.map { it.id })
    return connections.map { SyncStatusKernels.derive(it, recent.getValue(it.id), now, maxRunMinutes) }
}
