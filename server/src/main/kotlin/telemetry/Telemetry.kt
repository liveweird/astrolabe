package ch.nokillswit.telemetry

import ch.nokillswit.infra.db.PoolSnapshot
import ch.nokillswit.infra.db.PoolStatsKey
import ch.nokillswit.infra.db.R2dbcDatabaseKey
import ch.nokillswit.plugins.MetricRegistryKey
import io.ktor.server.application.Application
import io.ktor.server.application.ApplicationStarted
import io.ktor.server.application.ApplicationStopping
import io.ktor.util.AttributeKey
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeoutOrNull

private const val SHUTDOWN_JOIN_TIMEOUT_MS = 2_000L

/** Published once the sampler runs - `TelemetryWiringTest`'s "sampler started" seam, and the handle a test ticks by hand. */
val TelemetrySamplerKey = AttributeKey<TelemetrySampler>("TelemetrySampler")

/**
 * Test seam (`TelemetryWiringTest`): put on `Application.attributes` from a test's `application {}` block - which runs after the yaml
 * modules and before [ApplicationStarted], where the sampler reads it - to replace the clock, the
 * probes, the process identity or the first-tick delay of the sampler `configureTelemetry` starts. Every field defaults to the real
 * thing. `TelemetrySamplerTest` bypasses it and constructs the sampler directly.
 */
class TelemetryOverrides(
    val clock: () -> Long = System::currentTimeMillis,
    val jvm: JvmProbe? = null,
    val cgroup: CgroupProbe? = null,
    val identity: ProcessIdentity? = null,
    val firstTickDelayMillis: Long = FIRST_TICK_DELAY_MILLIS,
)

val TelemetryOverridesKey = AttributeKey<TelemetryOverrides>("TelemetryOverrides")

/**
 * The telemetry sampler's module (`.claude/docs/observability.md` "Telemetry"): the process samples itself. `telemetry.*` is validated
 * on every boot, enabled or not; the sampler
 * itself starts on [ApplicationStarted] (so a test's `application {}` overrides are visible) and is cancelled on
 * [ApplicationStopping], before the connection pool is disposed. Registered after
 * `configureBootstrap` (`application.yaml`); `configureMonitoring` has already published the metric registry and
 * `configureDatabase` the database and pool figures.
 */
fun Application.configureTelemetry() {
    val config = readTelemetryConfig(environment.config)
    if (!config.enabled) return

    monitor.subscribe(ApplicationStarted) { app ->
        val overrides = app.attributes.getOrNull(TelemetryOverridesKey) ?: TelemetryOverrides()
        val poolStats: () -> PoolSnapshot? = app.attributes.getOrNull(PoolStatsKey) ?: { null }
        val latency = app.attributes.getOrNull(MetricRegistryKey)?.let(::LatencyCollector)
        val sampler = TelemetrySampler(
            store = TelemetryStore(app.attributes[R2dbcDatabaseKey], config.statementTimeoutSeconds),
            config = config,
            identity = overrides.identity ?: ProcessIdentity.detect(),
            clock = overrides.clock,
            jvm = overrides.jvm ?: JvmProbe(),
            cgroup = overrides.cgroup ?: CgroupProbe(),
            poolStats = poolStats,
            extraProcessCollectors = listOfNotNull(latency?.let { ProcessCollector("latency") { it.collect() } }),
            heavyCollectors = heavyCollectors(config),
            firstTickDelayMillis = overrides.firstTickDelayMillis,
        )
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
        sampler.start(scope)
        app.attributes.put(TelemetrySamplerKey, sampler)
        app.monitor.subscribe(ApplicationStopping) {
            val rootJob = scope.coroutineContext[Job]
            scope.cancel()
            // A bounded join, so an in-flight tick has released its pooled connection before the pool is disposed.
            if (rootJob != null) runBlocking { withTimeoutOrNull(SHUTDOWN_JOIN_TIMEOUT_MS) { rootJob.join() } }
        }
    }
}
