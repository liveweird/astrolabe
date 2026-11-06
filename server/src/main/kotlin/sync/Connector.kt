package ch.nokillswit.sync

import io.ktor.util.AttributeKey
import java.util.concurrent.ConcurrentHashMap

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
     * The whole run for the claimed row: reads the upstream, writes the connector's own tables and answers how it ended. A problem of the
     * run itself (an unreadable token, a stale mapping, a failed fetch) is a [SyncResult.failed], never an exception; whatever else is
     * thrown is reported by the runner as `INTERNAL`. It must rethrow cancellation untouched (the runner's deadline and the shutdown
     * both arrive that way), must never hold a database transaction across an upstream call and never takes the plan lock.
     */
    suspend fun run(run: ClaimedRun): SyncResult
}

/** The connectors by kind. Built empty by the composition root; each connector's module registers itself (`configureJira`). */
class SyncConnectors {
    private val byKind = ConcurrentHashMap<SyncKind, Connector>()

    fun register(connector: Connector) {
        check(byKind.putIfAbsent(connector.kind, connector) == null) { "a ${connector.kind} connector is already registered" }
    }

    fun of(kind: SyncKind): Connector? = byKind[kind]
}

val SyncConnectorsKey = AttributeKey<SyncConnectors>("SyncConnectors")
