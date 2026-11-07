package ch.nokillswit.telemetry

import ch.nokillswit.infra.FailureLog
import ch.nokillswit.infra.catchingFailures
import ch.nokillswit.sync.SyncConnectorsKey
import ch.nokillswit.sync.SyncKind
import ch.nokillswit.sync.SyncRunServiceKey
import ch.nokillswit.sync.SyncSchedulerKey
import ch.nokillswit.sync.SyncStatusKernels
import io.ktor.util.Attributes
import org.slf4j.LoggerFactory

private val log = LoggerFactory.getLogger(TelemetrySyncReport::class.java)

/** The failure log's unit: the whole block (one WARN at the first failure, DEBUG while it repeats, INFO when it recovers). */
private const val BLOCK = "sync block"

/**
 * The `sync` block of `GET /telemetry/current` (`.claude/docs/observability.md` "Telemetry"): per registered connector its active
 * connections (`Connector.connections()`), their newest runs and the status derived from both - the SAME [SyncStatusKernels.derive] the
 * connection registry and the Deviations page use, against the telemetry clock. Reads the registry through [attributes] on every request
 * (a test replaces them after this module has run); `SyncSchedulerKey` is published only when the scheduler runs, so its absence reads
 * as `schedulerEnabled: false` while [tickSeconds] (validated config) is reported either way. Not a snapshot: the connector's rows and
 * the runs are two reads, and a run finishing between them shows on the next poll.
 *
 * Every read runs under [statementTimeoutSeconds], the telemetry reads' own `queryTimeout`. The block is auxiliary to the panel, so a
 * failure of its reads (a timeout, a connector that throws) never fails the report: it answers no `connections` (the scheduler fields
 * are still true) and logs the exception CLASS only - a database error can quote a statement.
 */
internal class TelemetrySyncReport(
    private val attributes: Attributes,
    private val tickSeconds: Int,
    private val statementTimeoutSeconds: Int = READ_TIMEOUT_SECONDS,
) {
    private val failures = FailureLog(log, "Telemetry") { it.javaClass.simpleName }

    suspend fun build(now: Long): TelemetrySync {
        val connections = catchingFailures(
            { connections(now).also { failures.ok(BLOCK) } },
            { failure ->
                failures.failed(BLOCK, failure)
                emptyList()
            },
        )
        return TelemetrySync(attributes.contains(SyncSchedulerKey), tickSeconds, connections)
    }

    private suspend fun connections(now: Long): List<TelemetrySyncConnection> {
        val connectors = attributes.getOrNull(SyncConnectorsKey) ?: return emptyList()
        val runs = attributes.getOrNull(SyncRunServiceKey) ?: return emptyList()
        return SyncKind.entries.mapNotNull { kind -> connectors.of(kind)?.let { kind to it } }.flatMap { (kind, connector) ->
            val rows = connector.connections(statementTimeoutSeconds)
            val recent = runs.recentRuns(kind, rows.map { it.id }, queryTimeoutSeconds = statementTimeoutSeconds)
            rows.map { row ->
                TelemetrySyncConnection(
                    kind = kind,
                    connectionId = row.id,
                    name = row.name,
                    pollIntervalMinutes = row.pollIntervalMinutes,
                    ready = row.ready,
                    status = SyncStatusKernels.derive(row, recent.getValue(row.id), now, runs.maxRunMinutes),
                )
            }
        }
    }
}
