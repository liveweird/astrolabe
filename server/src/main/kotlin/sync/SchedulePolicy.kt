package ch.nokillswit.sync

import ch.nokillswit.infra.time.MILLIS_PER_HOUR
import ch.nokillswit.infra.time.MILLIS_PER_MINUTE

/** The ceiling of a failure back-off: a dead site is retried at least this often, whatever the failure count. */
const val MAX_BACKOFF_MILLIS = 6 * MILLIS_PER_HOUR

private const val MAX_BACKOFF_DOUBLINGS = 32

/**
 * How long after a finished run the next poll waits: [intervalMillis] after a success ([trailingFailures] = 0) or the first failure, then
 * doubled per further consecutive failure (`interval x 2^(n-1)`), capped at [MAX_BACKOFF_MILLIS]. Flow's `ingest/SchedulePolicy.kt`
 * `backoffMillis`, cut on the count of failures INCLUDING the newest one, so the first retry waits exactly one interval. An interval
 * LONGER than the cap (up to 24 h) is never shortened by it: a back-off only ever lengthens the wait, so the result is at least the
 * interval. The shift is bounded, so a long failure streak can never overflow.
 */
fun backoffMillis(intervalMillis: Long, trailingFailures: Int): Long {
    val doublings = minOf(maxOf(trailingFailures - 1, 0), MAX_BACKOFF_DOUBLINGS)
    return maxOf(intervalMillis, minOf(intervalMillis * (1L shl doublings), MAX_BACKOFF_MILLIS))
}

/** One run as the policy sees it (the registry's row, nothing connector-specific). [finishedAt] and [outcome] are null while unfinished. */
data class RunFact(val startedAt: Long, val finishedAt: Long?, val outcome: SyncOutcome?)

/**
 * The failure streak: how many of the NEWEST FINISHED runs ended other than `SUCCEEDED`, counted back to the first success.
 * `ABANDONED` counts (a crashed run is a failure); an unfinished run is not a result yet and is skipped. [runsNewestFirst] is ordered
 * newest first.
 */
fun trailingFailures(runsNewestFirst: List<RunFact>): Int =
    runsNewestFirst.filter { it.finishedAt != null }.takeWhile { it.outcome != SyncOutcome.SUCCEEDED }.size

/** What the scheduler does with one connection at one tick. */
sealed interface Decision {
    /** Never polled: disabled, never tested (no discovery) or manual only. */
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
 * 1. [Decision.Never] for a disabled, not-ready (no discovery yet) or manual-only (no interval) [connection].
 * 2. The newest run unfinished: [Decision.Running] while it is younger than [maxRunMinutes] (the registry's `isRunning` rule), else it
 *    is a crash and the connection is [Decision.Due] (the claim abandons the row).
 * 3. [Decision.Due] with no run at all, or when the connection changed ([ConnectorConnection.changedAt]: an edit, a mapping change, a
 *    new discovery) after the newest run started - a fixed token is not left waiting out a back-off.
 * 4. Otherwise [Decision.Due] once `now` reaches the newest run's finish + [backoffMillis] of the failure streak, else [Decision.Wait].
 */
fun decide(connection: ConnectorConnection, runsNewestFirst: List<RunFact>, now: Long, maxRunMinutes: Int): Decision {
    val intervalMinutes = connection.pollIntervalMinutes
    if (!connection.enabled || !connection.ready || intervalMinutes == null) return Decision.Never
    val newest = runsNewestFirst.firstOrNull() ?: return Decision.Due
    val finishedAt = newest.finishedAt
    return when {
        finishedAt == null ->
            if (newest.startedAt >= now - maxRunMinutes * MILLIS_PER_MINUTE) Decision.Running else Decision.Due
        connection.changedAt > newest.startedAt -> Decision.Due
        else -> {
            val nextDue = finishedAt + backoffMillis(intervalMinutes * MILLIS_PER_MINUTE, trailingFailures(runsNewestFirst))
            if (now >= nextDue) Decision.Due else Decision.Wait(nextDue)
        }
    }
}
