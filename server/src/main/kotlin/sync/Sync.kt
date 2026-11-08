package ch.nokillswit.sync

import ch.nokillswit.infra.config.requireConfigInt
import io.ktor.server.application.*
import io.ktor.server.auth.authenticate
import io.ktor.server.routing.routing
import io.ktor.util.AttributeKey
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob

/** The background executor of claimed runs - published so a test can await a run (`SyncRunner.await`) instead of sleeping. */
val SyncRunnerKey = AttributeKey<SyncRunner>("SyncRunner")

/** The scheduler, published once it runs; absent when `sync.scheduler.enabled` is false. Its loop ends with the application. */
val SyncSchedulerKey = AttributeKey<SyncScheduler>("SyncScheduler")

/** `sync.tickSeconds` bounds: a tick is a few indexed reads, so under 15 s is pointless and over 10 min makes a 5-minute interval a lie. */
internal const val MIN_TICK_SECONDS = 15
internal const val MAX_TICK_SECONDS = 600

/**
 * Test seam (`SyncBootTest`): put a first-tick delay in millis on `Application.attributes` from a test's `application {}` block - which
 * runs after the yaml modules and before [ApplicationStarted] - so a boot test is independent of the real 10 s delay. Absent in production.
 */
val SyncFirstTickDelayKey = AttributeKey<Long>("SyncFirstTickDelayMillis")

private const val MILLIS_PER_SECOND = 1_000L

/**
 * The run registry's module (`.claude/docs/observability.md` "Sync runs"): the executor, the scheduler and the routes. Registered after
 * `configureJira` and `configureFlow` (which register the Jira and Flow connectors in [SyncConnectors]) and before the routing
 * catch-all. The executor's scope is the application's, the shape of `telemetry/Telemetry.kt`: a `SupervisorJob`, cancelled on
 * [ApplicationStopping] with a bounded join so every in-flight run records its `SHUTDOWN` finish before the pool is disposed.
 *
 * **The scheduler (1.3)** is one coroutine on that SAME scope, launched on [ApplicationStarted] (so the connectors and a test's
 * `application {}` are in place): `runner.shutdown()` ends it, there is no second scope and no second hook. `sync.tickSeconds` (15..600)
 * is validated on every boot, the scheduler enabled or not; `sync.scheduler.enabled` false (the test harness's default) starts no loop
 * at all, and a run then starts only from the manual route.
 */
fun Application.configureSync() {
    val config = environment.config
    val tickSeconds = requireConfigInt(config, "sync.tickSeconds", MIN_TICK_SECONDS, MAX_TICK_SECONDS)
    val enabledKey = "sync.scheduler.enabled"
    val rawEnabled = config.property(enabledKey).getString()
    val schedulerEnabled = rawEnabled.toBooleanStrictOrNull() ?: error("Config \"$enabledKey\" must be true or false (was \"$rawEnabled\")")
    val runs = attributes[SyncRunServiceKey]
    val connectors = attributes[SyncConnectorsKey]
    val runner = SyncRunner(CoroutineScope(SupervisorJob() + Dispatchers.IO), runs)
    attributes.put(SyncRunnerKey, runner)
    monitor.subscribe(ApplicationStopping) { runner.shutdown() }
    if (schedulerEnabled) {
        monitor.subscribe(ApplicationStarted) { app ->
            val scheduler = SyncScheduler(
                runs, runner, connectors, tickMillis = tickSeconds * MILLIS_PER_SECOND,
                firstTickDelayMillis = app.attributes.getOrNull(SyncFirstTickDelayKey) ?: DEFAULT_FIRST_TICK_DELAY_MILLIS,
            )
            scheduler.start()
            app.attributes.put(SyncSchedulerKey, scheduler)
        }
    }
    routing {
        authenticate {
            syncRoutes(runs, runner, connectors)
        }
    }
}
