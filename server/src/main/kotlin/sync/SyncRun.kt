package ch.nokillswit.sync

import kotlinx.serialization.Serializable

/**
 * The run registry's vocabulary (V21 `sync_runs`). A run is one pass of a connector over one connection of its [SyncKind]; the registry is
 * connector-agnostic, so Flow's connector (1.5) adds a kind and nothing else. `sync/` imports no connector package.
 */
enum class SyncKind { JIRA }

/** Who started a run: a person clicking "Refresh now" ([MANUAL]) or the scheduler (1.3). */
enum class SyncTrigger { MANUAL, SCHEDULED }

/** `ABANDONED` is written only by a LATER claim that found the run still unfinished after `sync.maxRunMinutes`. */
enum class SyncOutcome { SUCCEEDED, FAILED, ABANDONED }

/** `409` problem type: a run of this kind is already unfinished for the connection (the claim's unique index answered). */
const val RUN_IN_PROGRESS_PROBLEM = "urn:astrolabe:problem:run-in-progress"

/** The run's own failure codes besides the connector's (a `FetchException` code or a connector-typed one). */
object SyncErrorCodes {
    const val DEADLINE = "RUN_DEADLINE"
    const val SHUTDOWN = "SHUTDOWN"
    const val INTERNAL = "INTERNAL"
    const val ABANDONED = "ABANDONED"
}

/** `POST /integrations/sync/runs`. */
@Serializable
data class SyncRunRequest(val kind: SyncKind, val connectionId: UInt)

/**
 * A run as the API shows it. `finishedAt`/`outcome` are null while it runs; `errorDetail` never carries a URL with a query or a token.
 * [running] is the registry's own verdict ([SyncRunService.isRunning]): an unfinished run younger than `sync.maxRunMinutes`. An unfinished
 * run that is not [running] was interrupted (a crash leaves its row unfinished until the next claim abandons it), so no client judges
 * a run's age by its own clock.
 */
@Serializable
data class SyncRunResponse(
    val id: UInt,
    val kind: SyncKind,
    val connectionId: UInt,
    val trigger: SyncTrigger,
    val requestedByUserId: UInt?,
    val startedAt: Long,
    val finishedAt: Long?,
    val outcome: SyncOutcome?,
    val errorCode: String?,
    val errorDetail: String?,
    val running: Boolean,
    val observedCount: Int,
    val goneCount: Int,
    val callCount: Int,
    val rateLimitedCount: Int,
    val backoffMs: Long,
)

/** `GET /integrations/sync/runs`: the newest runs first, at most [MAX_LISTED_RUNS] (the retention per connection). */
@Serializable
data class SyncRunList(val items: List<SyncRunResponse>)

/** The runs kept per (kind, connection): the claim prunes the older finished ones, and one list never answers more. */
const val MAX_LISTED_RUNS = 50

/**
 * The counters a connector has reached so far, published as it goes ([ClaimedRun.meter]) so a run CUT from outside - its deadline, the
 * application's shutdown - still records the calls, rate limiting and backoff it had spent instead of zeros.
 */
class RunMeter {
    @Volatile
    var counts: SyncCounts = SyncCounts()
}

/** A run just claimed: its row exists and is unfinished. [byUserId] is null for a scheduled run. */
class ClaimedRun(
    val id: UInt,
    val kind: SyncKind,
    val connectionId: UInt,
    val trigger: SyncTrigger,
    val byUserId: UInt?,
    val startedAt: Long,
    val meter: RunMeter = RunMeter(),
)

/** What a run did, in the registry's counters (calls = Jira requests issued, not retries). */
data class SyncCounts(
    val observed: Int = 0,
    val gone: Int = 0,
    val calls: Int = 0,
    val rateLimited: Int = 0,
    val backoffMs: Long = 0,
)

/** How a run ended. [errorCode] is a machine code; [errorDetail] a short operator hint (clamped by [SyncRunService.finish]). */
data class SyncResult(val outcome: SyncOutcome, val counts: SyncCounts, val errorCode: String? = null, val errorDetail: String? = null) {
    init {
        require(outcome != SyncOutcome.ABANDONED) { "a run cannot abandon itself" }
    }

    companion object {
        fun succeeded(counts: SyncCounts) = SyncResult(SyncOutcome.SUCCEEDED, counts)

        fun failed(code: String, detail: String? = null, counts: SyncCounts = SyncCounts()) =
            SyncResult(SyncOutcome.FAILED, counts, code, detail)
    }
}
