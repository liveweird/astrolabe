package ch.nokillswit.jira

import ch.nokillswit.infra.db.active
import ch.nokillswit.sync.ConnectorConnection
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
internal suspend fun pollRowsOf(database: R2dbcDatabase): List<ConnectorConnection> = suspendTransaction(database) {
    val connections = JiraConnectionService.Connections
    connections.select(
        connections.id, connections.name, connections.enabled, connections.pollIntervalMinutes,
        connections.discoveredAt, connections.mappingChangedAt, connections.updatedAt,
    ).where { connections.active() }.orderBy(connections.id).toList().map { row ->
        ConnectorConnection(
            id = row[connections.id].value,
            name = row[connections.name],
            enabled = row[connections.enabled],
            pollIntervalMinutes = row[connections.pollIntervalMinutes],
            ready = row[connections.discoveredAt] != null,
            changedAt = maxOf(row[connections.updatedAt], row[connections.mappingChangedAt] ?: 0L, row[connections.discoveredAt] ?: 0L),
        )
    }
}
