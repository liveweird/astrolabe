package ch.nokillswit.jira

import java.util.concurrent.ConcurrentHashMap

/** The unconverged runs in a row after which a census is no longer forced into a full read (see [CensusLoopGuard]). */
internal const val MAX_UNCONVERGED_RUNS = 3

/** What counting one unconverged run found: [tripped] = past the threshold; [first] = the streak's first such run (the one that warns). */
internal class LoopTrip(val tripped: Boolean, val first: Boolean)

/**
 * The loop guard of the census self-heal: a connection whose census cannot converge (an in-scope issue that can never become a mirror
 * row - a type or level the census refuses - or a children read that always fails) would otherwise clear or leave unstamped its
 * `census_at` on every poll, and so read in full forever. It keeps TWO streaks per connection, so "in a row" is true of each:
 * [heal] counts the runs that cleared `census_at`, [failure] the runs whose children pass failed. Past [MAX_UNCONVERGED_RUNS] the
 * caller stops forcing the full read and warns once per streak ([LoopTrip.first]); [healReset] / [failureReset] / [failureSweepDone]
 * end a streak (and re-arm its warning), [healSettled] holds a tripped heal streak at the threshold, and [forget] drops the entry.
 *
 * The state is IN MEMORY, one small record per connection id (removed when both streaks are empty, when the connection's config changed
 * or when a run finds the connection deleted): the server is one process and the sync runs inside it, so no table is needed. A restart
 * resets the counts, which costs at most one more round of full reads before the guard trips again - accepted. Thread-safe: runs of
 * different connections are concurrent, and every update is atomic per key.
 */
internal class CensusLoopGuard {
    private data class Streaks(val heals: Int = 0, val failures: Int = 0, val healWarned: Boolean = false, val failWarned: Boolean = false)

    private val states = ConcurrentHashMap<UInt, Streaks>()

    /** Counts one run of [connectionId] that cleared `census_at` (a sweep listed an issue the mirror lacks). */
    fun heal(connectionId: UInt): LoopTrip = count(connectionId, failure = false)

    /** Counts one run of [connectionId] whose children pass failed. */
    fun failure(connectionId: UInt): LoopTrip = count(connectionId, failure = true)

    /** A tripped heal streak whose forced full read was just ordered: back to the threshold, so the next heal trips at once. */
    fun healSettled(connectionId: UInt) = update(connectionId) { it.copy(heals = minOf(it.heals, MAX_UNCONVERGED_RUNS)) }

    /** A conclusive converged run: the heal streak (and its warning) starts over. */
    fun healReset(connectionId: UInt) = update(connectionId) { it.copy(heals = 0, healWarned = false) }

    /** A completed children FULL read: the failure streak (and its warning) starts over. */
    fun failureReset(connectionId: UInt) = update(connectionId) { it.copy(failures = 0, failWarned = false) }

    /**
     * A completed children id SWEEP: ends an UNtripped failure streak, but not a tripped one - the sweep working does not mean the full
     * read that keeps failing works, and resetting would let the daily forced full read cost a fresh run of failing full reads.
     */
    fun failureSweepDone(connectionId: UInt) = update(connectionId) {
        if (it.failures > MAX_UNCONVERGED_RUNS) it else it.copy(failures = 0, failWarned = false)
    }

    /** The connection's reading inputs changed (a full read is forced anyway) or it is gone: both streaks start over. */
    fun forget(connectionId: UInt) {
        states.remove(connectionId)
    }

    private fun count(connectionId: UInt, failure: Boolean): LoopTrip {
        var trip = LoopTrip(tripped = false, first = false)
        states.compute(connectionId) { _, old ->
            val s = old ?: Streaks()
            val n = (if (failure) s.failures else s.heals) + 1
            val warned = if (failure) s.failWarned else s.healWarned
            val tripped = n > MAX_UNCONVERGED_RUNS
            trip = LoopTrip(tripped, first = tripped && !warned)
            if (failure) s.copy(failures = n, failWarned = warned || tripped) else s.copy(heals = n, healWarned = warned || tripped)
        }
        return trip
    }

    private fun update(connectionId: UInt, change: (Streaks) -> Streaks) {
        states.computeIfPresent(connectionId) { _, s -> change(s).takeIf { it != Streaks() } }
    }
}
