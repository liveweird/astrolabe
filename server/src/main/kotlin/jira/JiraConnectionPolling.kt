package ch.nokillswit.jira

import ch.nokillswit.sync.ConnectorConnection
import ch.nokillswit.sync.pollRowsOf
import org.jetbrains.exposed.v1.core.ResultRow
import org.jetbrains.exposed.v1.r2dbc.R2dbcDatabase

/**
 * The scheduler's rows of the Jira connections (`JiraConnectionService.pollRows`): every ACTIVE connection, in id order, as the
 * connector-agnostic [ConnectorConnection] (the read itself is `sync/ConnectionRegistry.kt`'s [pollRowsOf]). It selects SEVEN columns by
 * name - never the encrypted token, never the discovery snapshot (up to ~300 KB), the mapping or the site - so the timer's read can
 * neither decrypt a credential nor carry one into a log line.
 *
 * `ready` is "a passing Test connection stored a discovery" (`discovered_at`), the one thing a run needs besides a readable token.
 * `changedAt` is the latest of the row's edit (`updated_at`), its last real mapping change and its last discovery: whichever input of
 * a run changed last, the very inputs the observer's full-read rule watches (jira-sync.md "Observations and the run").
 */
internal suspend fun jiraPollRows(database: R2dbcDatabase, queryTimeoutSeconds: Int = 0): List<ConnectorConnection> {
    val connections = JiraConnectionService.Connections
    return pollRowsOf(
        database, connections, listOf(connections.discoveredAt, connections.mappingChangedAt), queryTimeoutSeconds,
        ResultRow::toConnectorConnection,
    )
}

/** A connection row as the scheduler and the status see it; needs the seven columns of [jiraPollRows] among the row's. */
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
