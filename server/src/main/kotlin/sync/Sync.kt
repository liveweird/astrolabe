package ch.nokillswit.sync

import io.ktor.server.application.*
import io.ktor.server.auth.authenticate
import io.ktor.server.routing.routing
import io.ktor.util.AttributeKey
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob

/** The background executor of claimed runs - published so a test can await a run (`SyncRunner.await`) instead of sleeping. */
val SyncRunnerKey = AttributeKey<SyncRunner>("SyncRunner")

/**
 * The run registry's module (`.claude/docs/observability.md` "Sync runs"): the executor and the routes. Registered after `configureJira`
 * (which registers the Jira connector in [SyncConnectors]) and before the routing catch-all. The executor's scope is the application's,
 * the shape of `telemetry/Telemetry.kt`: a `SupervisorJob`, cancelled on [ApplicationStopping] with a bounded join so every in-flight run
 * records its `SHUTDOWN` finish before the pool is disposed. There is no scheduler yet (1.3): a run starts only from the manual route.
 */
fun Application.configureSync() {
    val runs = attributes[SyncRunServiceKey]
    val connectors = attributes[SyncConnectorsKey]
    val runner = SyncRunner(CoroutineScope(SupervisorJob() + Dispatchers.IO), runs)
    attributes.put(SyncRunnerKey, runner)
    monitor.subscribe(ApplicationStopping) { runner.shutdown() }
    routing {
        authenticate {
            syncRoutes(runs, runner, connectors)
        }
    }
}
