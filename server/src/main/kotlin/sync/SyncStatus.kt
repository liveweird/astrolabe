package ch.nokillswit.sync

import ch.nokillswit.infra.time.MILLIS_PER_MINUTE
import kotlinx.serialization.Serializable

/**
 * A connection's sync state, derived per read (never stored; Flow's `DataSourceState`, `ingest/DataSource.kt`): [DISABLED] switched off,
 * [FAILED] its newest finished run failed or was abandoned, or its newest run was interrupted (unfinished, older than the claim window,
 * not yet abandoned by a later claim: a crash on a connection nothing polls), [NEVER_SYNCED] no run ever succeeded, [STALE] the last
 * success is older than [STALE_INTERVAL_MULTIPLIER] intervals, else [CURRENT].
 */
enum class SyncState { NEVER_SYNCED, CURRENT, STALE, FAILED, DISABLED }

/** A connection with a polling interval is [SyncState.STALE] once its last success started more than this many intervals ago. */
const val STALE_INTERVAL_MULTIPLIER = 3

/**
 * A connection's newest run (any trigger, running or not). A run left unfinished by a crash keeps `finishedAt = null` until the next
 * claim abandons it, so [running] is the registry's one rule ([isRunLive]): true only for an unfinished run younger than
 * `sync.maxRunMinutes`. An unfinished run that is not [running] was interrupted. No error text, no counters: operational, no secret.
 */
@Serializable
data class SyncLastRun(
    val id: UInt,
    val startedAt: Long,
    val finishedAt: Long?,
    val outcome: SyncOutcome?,
    val errorCode: String?,
    val trigger: SyncTrigger,
    val running: Boolean,
)

/**
 * What the registry, the Deviations page and the telemetry panel say of a connection's sync. [lastSucceededAt] is the START of the newest
 * `SUCCEEDED` run (the incremental watermark: the data is as of then); [consecutiveFailures] the trailing failed or abandoned runs
 * ([trailingFailures], plus an interrupted newest run); [nextPollAt] when the scheduler will claim next, null for a disabled, untested,
 * manual-only or running connection and "now" for a due one.
 */
@Serializable
data class SyncStatus(
    val state: SyncState,
    val lastRun: SyncLastRun?,
    val lastSucceededAt: Long?,
    val consecutiveFailures: Int,
    val nextPollAt: Long?,
)

/** THE running rule: unfinished and claimed less than [maxRunMinutes] before [now]. Older, the row was interrupted. */
fun isRunLive(finishedAt: Long?, startedAt: Long, now: Long, maxRunMinutes: Int): Boolean =
    finishedAt == null && startedAt >= now - maxRunMinutes * MILLIS_PER_MINUTE

object SyncStatusKernels {
    /**
     * The status of [connection] from its runs ([runsNewestFirst], at most the retention of 50), pure. The state is, in order:
     * disabled -> [SyncState.DISABLED]; the newest FINISHED run not `SUCCEEDED` (a failure or an abandonment), or an INTERRUPTED newest
     * row (unfinished and no longer [isRunLive]: it counts like an abandonment, even before a claim writes one) -> [SyncState.FAILED];
     * no `SUCCEEDED` run -> [SyncState.NEVER_SYNCED]; a polling interval and the last success older than
     * [STALE_INTERVAL_MULTIPLIER] x the interval (strictly) -> [SyncState.STALE]; else [SyncState.CURRENT] (a manual-only connection
     * stays current after any success: its staleness is the administrator's choice, `lastSucceededAt` shows it).
     * [SyncStatus.nextPollAt] comes from the SAME [decide] the scheduler runs, never a second copy of the back-off.
     */
    fun derive(connection: ConnectorConnection, runsNewestFirst: List<RunFact>, now: Long, maxRunMinutes: Int): SyncStatus {
        val newest = runsNewestFirst.firstOrNull()
        val lastSucceeded = runsNewestFirst.firstOrNull { it.outcome == SyncOutcome.SUCCEEDED }
        val newestFinished = runsNewestFirst.firstOrNull { it.finishedAt != null }
        // Only the newest row can be unfinished (the unique index admits one), so an interrupted run is the newest one.
        val interrupted = newest != null && newest.finishedAt == null && !isRunLive(null, newest.startedAt, now, maxRunMinutes)
        val intervalMinutes = connection.pollIntervalMinutes
        val state = when {
            !connection.enabled -> SyncState.DISABLED
            interrupted || (newestFinished != null && newestFinished.outcome != SyncOutcome.SUCCEEDED) -> SyncState.FAILED
            lastSucceeded == null -> SyncState.NEVER_SYNCED
            intervalMinutes != null && now - lastSucceeded.startedAt > STALE_INTERVAL_MULTIPLIER * intervalMinutes * MILLIS_PER_MINUTE ->
                SyncState.STALE
            else -> SyncState.CURRENT
        }
        return SyncStatus(
            state = state,
            lastRun = newest?.let {
                SyncLastRun(
                    it.id, it.startedAt, it.finishedAt, it.outcome, it.errorCode, it.trigger,
                    running = isRunLive(it.finishedAt, it.startedAt, now, maxRunMinutes),
                )
            },
            lastSucceededAt = lastSucceeded?.startedAt,
            consecutiveFailures = trailingFailures(runsNewestFirst) + if (interrupted) 1 else 0,
            nextPollAt = when (val decision = decide(connection, runsNewestFirst, now, maxRunMinutes)) {
                Decision.Due -> now
                is Decision.Wait -> decision.until
                Decision.Never, Decision.Running -> null
            },
        )
    }
}
