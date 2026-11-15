package ch.nokillswit.sync

import ch.nokillswit.infra.fetch.BACKOFF_MS_KEY
import ch.nokillswit.infra.fetch.CallTally
import ch.nokillswit.infra.fetch.FetchException
import ch.nokillswit.infra.fetch.RATE_LIMITED_KEY
import ch.nokillswit.infra.fetch.TENANT_PAUSED_MS_KEY
import kotlinx.coroutines.withContext

// The envelope every connector's run shares (`Connector.run`): a typed failure, the run's own tally, and the one place that turns the
// outcome of `execute` into a `SyncResult`. A connector (`jira/`, `flow/`) owns only what it observes; `sync/` names no connector.

/**
 * A typed run failure the connector reports as `FAILED` + [code]; none involves a call to the upstream. The [detail] is fixed text: never
 * a URL, a token or a value from the upstream.
 */
internal class RunProblem(val code: String, val detail: String) : RuntimeException(detail)

/**
 * The run's mutable tally of its own work (the registry's counters); the throttling figures come from the [CallTally]. Every change calls
 * [onChange], which [runWithTally] points at the run's meter, so a run cut from outside (its deadline, a shutdown) keeps what it had
 * spent. A connector with more run state than the counters extends it.
 */
internal open class RunProgress {
    var onChange: () -> Unit = {}
    var calls = 0
        set(value) {
            field = value
            onChange()
        }
    var observed = 0
        set(value) {
            field = value
            onChange()
        }
    var gone = 0
        set(value) {
            field = value
            onChange()
        }
}

/**
 * The failure text of a run: the typed code and the status, never the endpoint (or URL, with its query) the exception's own message
 * quotes. [label] is the upstream's name ("Jira", "Flow"), the one its [FetchException] messages open with.
 */
internal fun fetchFailureDetail(label: String, failure: FetchException): String =
    "$label fetch failed: ${failure.code}" + (failure.status?.let { " ($it)" } ?: "")

/**
 * Runs [execute] inside a fresh [CallTally] and answers its [SyncResult]: success with the counters, a [RunProblem] as its own code and
 * detail, a [FetchException] as its code and [fetchFailureDetail]; the counters ride every failure. The meter of [run] is kept current
 * through [progress] while [execute] works.
 */
internal suspend fun runWithTally(
    run: ClaimedRun,
    progress: RunProgress,
    label: String,
    execute: suspend () -> Unit,
): SyncResult {
    val tally = CallTally()

    fun counts(): SyncCounts {
        val throttle = tally.snapshot()
        return SyncCounts(
            observed = progress.observed,
            gone = progress.gone,
            calls = progress.calls,
            rateLimited = (throttle[RATE_LIMITED_KEY] ?: 0L).toInt(),
            backoffMs = (throttle[BACKOFF_MS_KEY] ?: 0L) + (throttle[TENANT_PAUSED_MS_KEY] ?: 0L),
        )
    }
    progress.onChange = { run.meter.counts = counts() }
    return withContext(tally) {
        try {
            execute()
            SyncResult.succeeded(counts())
        } catch (problem: RunProblem) {
            SyncResult.failed(problem.code, problem.detail, counts())
        } catch (failure: FetchException) {
            SyncResult.failed(failure.code, fetchFailureDetail(label, failure), counts())
        }
    }
}
