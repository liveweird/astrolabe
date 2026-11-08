package ch.nokillswit.sync

import io.ktor.util.AttributeKey
import java.util.concurrent.ConcurrentHashMap

/**
 * What the scheduler may know of one connection of a connector - the poll row, never a credential or the upstream's snapshot.
 * [pollIntervalMinutes] is null for a manual-only connection; [ready] is false until the connection has been tested (a poll of an
 * untested connection could only fail); [changedAt] is the latest instant its reading inputs changed (an edit, a mapping change, a
 * discovery), which makes it due at once whatever a failure back-off says ([decide]).
 */
data class ConnectorConnection(
    val id: UInt,
    val name: String,
    val enabled: Boolean,
    val pollIntervalMinutes: Int?,
    val ready: Boolean,
    val changedAt: Long,
)

/**
 * One kind of upstream the registry runs (Flow's `ingest/Connector.kt`, trimmed to what two connectors need). A connector knows its own
 * connection table, credentials and fetch code; the registry knows only rows of `sync_runs`.
 */
interface Connector {
    val kind: SyncKind

    /**
     * Throws `BadRequestException` when [connectionId] is not a connection this kind can run now (unknown, deleted or disabled): the
     * manual route asks BEFORE claiming, so a refused request leaves no row behind.
     */
    suspend fun requireRunnable(connectionId: UInt)

    /**
     * The connector's ACTIVE (not deleted) connections as the scheduler needs them, in id order: disabled and manual-only ones included
     * (the status reads them too), each as a [ConnectorConnection]. One cheap read; it must never carry a token or the upstream's snapshot.
     */
    suspend fun connections(): List<ConnectorConnection>

    /**
     * [connections] under a statement budget of [queryTimeoutSeconds] (whole seconds, the transaction's `queryTimeout`; 0 = none): the
     * telemetry read API's reads all carry one. The default ignores the budget, so a connector that does not own a database (a test
     * fake) needs nothing; the Jira and Flow connectors apply it.
     */
    suspend fun connections(queryTimeoutSeconds: Int): List<ConnectorConnection> = connections()

    /**
     * The whole run for the claimed row: reads the upstream, writes the connector's own tables and answers how it ended. A problem of the
     * run itself (an unreadable token, a stale mapping, a failed fetch) is a [SyncResult.failed], never an exception; whatever else is
     * thrown is reported by the runner as `INTERNAL`. It must rethrow cancellation untouched (the runner's deadline and the shutdown
     * both arrive that way), must never hold a database transaction across an upstream call and never takes the plan lock.
     */
    suspend fun run(run: ClaimedRun): SyncResult
}

/**
 * The connectors by kind. Built empty by the composition root; each connector's module registers itself (`configureJira`,
 * `configureFlow`).
 */
class SyncConnectors {
    private val byKind = ConcurrentHashMap<SyncKind, Connector>()

    fun register(connector: Connector) {
        check(byKind.putIfAbsent(connector.kind, connector) == null) { "a ${connector.kind} connector is already registered" }
    }

    fun of(kind: SyncKind): Connector? = byKind[kind]
}

val SyncConnectorsKey = AttributeKey<SyncConnectors>("SyncConnectors")
