package ch.nokillswit.flow

import ch.nokillswit.sync.ConnectorConnection
import ch.nokillswit.sync.pollRowsOf
import org.jetbrains.exposed.v1.core.ResultRow
import org.jetbrains.exposed.v1.r2dbc.R2dbcDatabase

/**
 * The scheduler's rows of the Flow connections (`FlowConnectionService.pollRows`, the twin of `jira/JiraConnectionPolling.kt`): every
 * ACTIVE connection, in id order, as the connector-agnostic [ConnectorConnection] (the read itself is `sync/ConnectionRegistry.kt`'s
 * [pollRowsOf]). It selects EIGHT columns by name - never the encrypted token - so the timer's read can neither decrypt a credential nor
 * carry one into a log line.
 *
 * `ready` is "a Test connection passed, or a run has already mirrored a document" (`last_test_ok` or `teams_at`), and it is STICKY the
 * way Jira's `discovered_at != null` is: an untested connection could only fail, so it is not polled, but once Flow has answered a run
 * the connection stays pollable. C4 clears the test verdict on a changed token or zone (the last test judged the old ones) and a later
 * Test that hit a Flow outage records `last_test_ok = false`; neither may stop a connection that has run from polling (the rotated token
 * is exactly what must be tried at once). `changedAt` is the later of the row's last edit and its last test: a rotated token
 * (`updated_at`) or a fresh passing test makes the connection due at once, whatever a failure back-off says.
 */
internal suspend fun flowPollRows(database: R2dbcDatabase, queryTimeoutSeconds: Int = 0): List<ConnectorConnection> {
    val connections = FlowConnectionService.Connections
    return pollRowsOf(
        database, connections, listOf(connections.lastTestOk, connections.teamsAt, connections.lastTestedAt), queryTimeoutSeconds,
        ResultRow::toConnectorConnection,
    )
}

/** A connection row as the scheduler and the status see it; needs the eight columns of [flowPollRows] among the row's. */
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
