package ch.nokillswit.sync

import ch.nokillswit.infra.time.MILLIS_PER_HOUR
import ch.nokillswit.infra.time.MILLIS_PER_MINUTE

/** The ceiling of a failure back-off: a dead site is retried at least this often, whatever the failure count. */
const val MAX_BACKOFF_MILLIS = 6 * MILLIS_PER_HOUR

/** The ceiling of the failure jitter: spreading a burst needs minutes, never the half of a 24 h interval. */
const val MAX_JITTER_MILLIS = MILLIS_PER_HOUR

private const val MAX_BACKOFF_DOUBLINGS = 32

/** The share of the back-off a failed connection's retry may be pushed later by: `[0, 1/2)` of it (see [failureJitterMillis]). */
private const val JITTER_DIVISOR = 2

/** A fraction in `[0, 1)` for one (connection id, newest run id); see [failureJitterFraction], the production one. */
typealias JitterFraction = (connectionId: UInt, runId: UInt) -> Double

/** No jitter: every retry exactly at the back-off. For tests that pin the back-off table itself. */
val NO_JITTER: JitterFraction = { _, _ -> 0.0 }

/**
 * How long after a finished run the next poll waits: [intervalMillis] after a success ([trailingFailures] = 0) or the first failure, then
 * doubled per further consecutive failure (`interval x 2^(n-1)`), capped at [MAX_BACKOFF_MILLIS]. Flow's `ingest/SchedulePolicy.kt`
 * `backoffMillis`, cut on the count of failures INCLUDING the newest one, so the first retry waits one interval (before
 * [failureJitterMillis]). An interval LONGER than the cap (up to 24 h) is never shortened by it: a back-off only ever lengthens the wait,
 * so the result is at least the interval. The shift is bounded, so a long failure streak can never overflow.
 */
fun backoffMillis(intervalMillis: Long, trailingFailures: Int): Long {
    val doublings = minOf(maxOf(trailingFailures - 1, 0), MAX_BACKOFF_DOUBLINGS)
    return maxOf(intervalMillis, minOf(intervalMillis * (1L shl doublings), MAX_BACKOFF_MILLIS))
}

/**
 * THE spread of a failed connection's retry, deterministic: a fraction in `[0, 1)` hashed (the splitmix64 finalizer) from the connection
 * id and the id of the newest run. The schedule is never stored, so a random draw per read would make `nextPollAt` flicker, and two
 * replicas would disagree on when to claim; the same two ids always give the same fraction, so the status, every replica and the
 * scheduler agree to the millisecond. Connections that failed in the same tick have different ids and so land at different offsets, and
 * the next failure (a new run id) draws a new offset.
 */
fun failureJitterFraction(connectionId: UInt, runId: UInt): Double {
    var z = (connectionId.toLong() shl Int.SIZE_BITS or runId.toLong()) + SPLITMIX_GAMMA
    z = (z xor (z ushr 30)) * SPLITMIX_MUL_1
    z = (z xor (z ushr 27)) * SPLITMIX_MUL_2
    z = z xor (z ushr 31)
    return (z ushr FRACTION_DROPPED_BITS).toDouble() / (1L shl (Long.SIZE_BITS - FRACTION_DROPPED_BITS)).toDouble()
}

private const val SPLITMIX_GAMMA = -0x61c8864680b583ebL
private const val SPLITMIX_MUL_1 = -0x40a7b892e31b1a47L
private const val SPLITMIX_MUL_2 = -0x6b2fb644ecceee15L
private const val FRACTION_DROPPED_BITS = 11

/**
 * How much later than [backoffMillis] a failed connection's retry is pushed: `fraction x min(backoff / 2, interval / 2, 1 h)`. After a
 * shared outage every connection fails in the same tick and would otherwise retry in the same tick (the two outbound permits are shared);
 * the offset spreads them over up to half an interval (as the back-off is never below the interval, `interval / 2` is the bound that
 * counts, `backoff / 2` only guards the formula). Added to the wait, never subtracted: the wait is still at least the back-off.
 */
fun failureJitterMillis(intervalMillis: Long, backoff: Long, fraction: Double): Long =
    (fraction * minOf(backoff / JITTER_DIVISOR, intervalMillis / JITTER_DIVISOR, MAX_JITTER_MILLIS)).toLong()

/**
 * One run as the policy and the status see it (the registry's row, nothing connector-specific, no error text). [finishedAt] and
 * [outcome] are null while unfinished. The due rule reads only the first three members; [id], [trigger] and [errorCode] ride along for
 * the status's `lastRun` ([SyncStatusKernels.derive]).
 */
data class RunFact(
    val startedAt: Long,
    val finishedAt: Long?,
    val outcome: SyncOutcome?,
    val id: UInt,
    val trigger: SyncTrigger,
    val errorCode: String?,
)

/**
 * The failure streak: how many of the NEWEST FINISHED runs ended other than `SUCCEEDED`, counted back to the first success.
 * `ABANDONED` counts (a crashed run is a failure); an unfinished run is not a result yet and is skipped. [runsNewestFirst] is ordered
 * newest first.
 */
fun trailingFailures(runsNewestFirst: List<RunFact>): Int =
    runsNewestFirst.filter { it.finishedAt != null }.takeWhile { it.outcome != SyncOutcome.SUCCEEDED }.size

/** What the scheduler does with one connection at one tick. */
sealed interface Decision {
    /** Never polled: disabled, not ready (Jira: no discovery; Flow: never tested and never run) or manual only. */
    data object Never : Decision

    /** A run is in flight (younger than `sync.maxRunMinutes`): a claim would be a `409` anyway. */
    data object Running : Decision

    /** Claim a run now. */
    data object Due : Decision

    /** Not before [until] (epoch millis). */
    data class Wait(val until: Long) : Decision
}

/**
 * THE due rule, pure (the scheduler decides with it; the 1.3 status derives `nextPollAt` from it). The state is never stored: it comes
 * from the connection's rows and its runs ([runsNewestFirst], at most the retention of 50), so a manual refresh resets the cadence by
 * itself and a replica that restarts loses nothing.
 *
 * 1. [Decision.Never] for a disabled, not-ready (Jira: no discovery yet; Flow: never tested and never run) or manual-only (no interval)
 *    [connection].
 * 2. The newest run unfinished: [Decision.Running] while it is younger than [maxRunMinutes] (the registry's `isRunning` rule), else it
 *    is a crash and the connection is [Decision.Due] (the claim abandons the row).
 * 3. [Decision.Due] with no run at all, or when the connection changed ([ConnectorConnection.changedAt]: an edit, a mapping change, a
 *    new discovery) after the newest run started - a fixed token is not left waiting out a back-off.
 * 4. Otherwise [Decision.Due] once `now` reaches the newest run's finish + [backoffMillis] of the failure streak (+ [failureJitterMillis]
 *    when the streak is not empty: the retry of connections that failed together is spread, never a success's cadence), else
 *    [Decision.Wait]. The [jitter] is a pure function of the ids ([failureJitterFraction]), so `Wait.until` is the instant the scheduler
 *    really claims, whoever asks.
 */
fun decide(
    connection: ConnectorConnection,
    runsNewestFirst: List<RunFact>,
    now: Long,
    maxRunMinutes: Int,
    jitter: JitterFraction = ::failureJitterFraction,
): Decision {
    val intervalMinutes = connection.pollIntervalMinutes
    if (!connection.enabled || !connection.ready || intervalMinutes == null) return Decision.Never
    val newest = runsNewestFirst.firstOrNull() ?: return Decision.Due
    val finishedAt = newest.finishedAt
    return when {
        finishedAt == null -> if (isRunLive(null, newest.startedAt, now, maxRunMinutes)) Decision.Running else Decision.Due
        connection.changedAt > newest.startedAt -> Decision.Due
        else -> {
            val intervalMillis = intervalMinutes * MILLIS_PER_MINUTE
            val failures = trailingFailures(runsNewestFirst)
            val backoff = backoffMillis(intervalMillis, failures)
            val spread = if (failures == 0) 0L else failureJitterMillis(intervalMillis, backoff, jitter(connection.id, newest.id))
            val nextDue = finishedAt + backoff + spread
            if (now >= nextDue) Decision.Due else Decision.Wait(nextDue)
        }
    }
}
