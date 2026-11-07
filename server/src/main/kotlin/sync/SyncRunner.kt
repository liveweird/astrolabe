package ch.nokillswit.sync

import ch.nokillswit.infra.catchingFailures
import java.util.concurrent.ConcurrentHashMap
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.Job
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.cancel
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeoutOrNull
import org.slf4j.LoggerFactory

private val log = LoggerFactory.getLogger("ch.nokillswit.sync")

/** How long a run's own finish may take, shutdown included (the row is its only record; a stuck database cannot hold the process). */
private const val FINISH_TIMEOUT_MS = 10_000L

/** How long the shutdown waits for in-flight runs to write their `FAILED/SHUTDOWN` row before the pool is disposed. */
const val SHUTDOWN_JOIN_TIMEOUT_MS = 5_000L

private const val MILLIS_PER_MINUTE = 60_000L

/** A run must end before another claim may abandon it: one minute under `sync.maxRunMinutes`, but never under half a minute. */
internal fun runDeadlineMillis(maxRunMinutes: Int): Long = maxOf(maxRunMinutes * MILLIS_PER_MINUTE - MILLIS_PER_MINUTE, MIN_DEADLINE_MS)

private const val MIN_DEADLINE_MS = 30_000L

/**
 * Executes claimed runs in the background, after the request that claimed them has answered `202`. [scope] is the application's: a
 * `SupervisorJob` so one run's failure never touches another, cancelled by [shutdown] on `ApplicationStopping`.
 *
 * **Every way a run can end writes its row, or leaves it to the age-based abandonment:**
 * - the connector returns: its [SyncResult] is stored;
 * - it throws something other than cancellation: `FAILED` / `INTERNAL`, the exception CLASS only (a message can name a statement);
 * - it outlives [deadlineMillis] (shorter than the claim's validity, so a live run is never abandoned under itself): `FAILED` /
 *   `RUN_DEADLINE`;
 * - the scope is cancelled (shutdown): `FAILED` / `SHUTDOWN`, written inside `NonCancellable`, then the cancellation is rethrown
 *   untouched;
 * - the process dies, or the finish itself cannot be written: the row stays unfinished and the next claim of the connection after
 *   `sync.maxRunMinutes` abandons it.
 */
class SyncRunner(
    private val scope: CoroutineScope,
    private val runs: SyncRunService,
    private val deadlineMillis: Long = runDeadlineMillis(runs.maxRunMinutes),
) {
    private val jobs = ConcurrentHashMap<UInt, Job>()

    /** Starts [run] in the background and returns at once. `ATOMIC`: even a scope cancelled meanwhile still writes the row's finish. */
    fun start(connector: Connector, run: ClaimedRun) {
        val job = scope.launch(start = CoroutineStart.ATOMIC) { execute(connector, run) }
        jobs[run.id] = job
        job.invokeOnCompletion { jobs.remove(run.id) }
    }

    /**
     * Launches [block] on the runner's own scope: the scheduler's loop lives here, so [shutdown] ends it together with the runs it started
     * (one scope, one bounded join, before the pool is disposed) and no second shutdown hook exists.
     */
    fun launch(block: suspend CoroutineScope.() -> Unit): Job = scope.launch(block = block)

    /** Suspends until run [runId] has ended (its row is written); returns at once for a run that is not in flight here. */
    suspend fun await(runId: UInt) {
        jobs[runId]?.join()
    }

    /** `ApplicationStopping`: cancels every run and waits (bounded) for each to record `SHUTDOWN` before the pool goes. */
    fun shutdown() {
        val root = scope.coroutineContext[Job]
        scope.cancel()
        if (root != null) runBlocking { withTimeoutOrNull(SHUTDOWN_JOIN_TIMEOUT_MS) { root.join() } }
    }

    private suspend fun execute(connector: Connector, run: ClaimedRun) {
        val meter = run.meter
        val result = try {
            withTimeoutOrNull(deadlineMillis) { connector.run(run) }
                ?: SyncResult.failed(SyncErrorCodes.DEADLINE, "The run was cut at its deadline of ${deadlineMillis / 1000} s", meter.counts)
        } catch (cancelled: CancellationException) {
            if (currentCoroutineContext().isActive) {
                // Not ours: a timeout a callee leaked. The run did not complete, but nothing is shutting down.
                SyncResult.failed(SyncErrorCodes.DEADLINE, "A step of the run timed out", run.meter.counts)
            } else {
                record(run, SyncResult.failed(SyncErrorCodes.SHUTDOWN, "The application stopped while the run was in flight", meter.counts))
                throw cancelled
            }
        } catch (failure: Exception) {
            // The failure's CLASSES and frames, never its message: an R2DBC or Exposed message can quote a statement or a stored value.
            log.error("Sync run {} ({} {}) failed unexpectedly: {}", run.id, run.kind, run.connectionId, describeWithoutMessage(failure))
            SyncResult.failed(SyncErrorCodes.INTERNAL, failure.javaClass.simpleName, run.meter.counts)
        }
        record(run, result)
    }

    /** Writes the finish (never cancellable, bounded) and the outcome line; a finish that fails is logged and left to the abandonment. */
    private suspend fun record(run: ClaimedRun, result: SyncResult) {
        var failed = false
        val written = catchingFailures(
            { withContext(NonCancellable) { withTimeoutOrNull(FINISH_TIMEOUT_MS) { runs.finish(run.id, result) } } },
            { failure ->
                failed = true
                log.error("Sync run {} ({} {}) could not be finished: {}", run.id, run.kind, run.connectionId, failure.javaClass.simpleName)
                null
            },
        )
        when {
            failed -> log.warn("Sync run {} stays unfinished; the next claim after the claim's lifetime will abandon it", run.id)
            written == null -> log.warn("Sync run {} was not finished in time; the next claim will abandon it", run.id)
            !written -> log.warn(
                "Sync run {} was already finished (abandoned) or removed (its connection was deleted) when it ended as {}",
                run.id, result.outcome,
            )
            result.outcome == SyncOutcome.SUCCEEDED -> log.info(
                "Sync run {} ({} connection {}) succeeded: observed={}, gone={}, calls={}, rateLimited={}, backoffMs={}",
                run.id, run.kind, run.connectionId, result.counts.observed, result.counts.gone, result.counts.calls,
                result.counts.rateLimited, result.counts.backoffMs,
            )
            else -> log.warn(
                "Sync run {} ({} connection {}) failed: {} observed={}, gone={}, calls={}",
                run.id, run.kind, run.connectionId, result.errorCode, result.counts.observed, result.counts.gone, result.counts.calls,
            )
        }
    }
}

private const val LOGGED_FRAMES = 12

/** "Cls <- Cause" with the first frames of the stack: enough to find the site of a failure, nothing a message could carry. */
internal fun describeWithoutMessage(failure: Throwable): String {
    val chain = generateSequence(failure) { it.cause?.takeIf { cause -> cause !== it } }.take(5).joinToString(" <- ") { it.javaClass.name }
    return chain + " at " + failure.stackTrace.take(LOGGED_FRAMES).joinToString(" | ")
}
