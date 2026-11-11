package ch.nokillswit.jira

import java.util.concurrent.ConcurrentHashMap

/** The runs in a row in which the gone probe got no answer at all, after which its retries back off (see [GoneProbeDamper]). */
internal const val GONE_PROBE_FAILING_RUNS = 3

/** What ending a run did to a streak: [TRIPPED] = it just reached [GONE_PROBE_FAILING_RUNS]; [RECOVERED] = a tripped one ended. */
internal enum class StreakChange { NONE, TRIPPED, RECOVERED }

/**
 * The back-off of a gone probe that keeps failing (1.13), the census loop guard's shape ([CensusLoopGuard]). A **failing run** is one
 * whose probe sent at least one read and got no answer at all (a 200, a 404 or a 403 is an answer); an **answering run** got at least
 * one; a run that sent nothing, or was cut by a stop (never reported to [endRun]), changes nothing. After [GONE_PROBE_FAILING_RUNS]
 * SCHEDULED failing runs in a row the connection is **tripped**: a SCHEDULED run asks only the newly flagged bindings (rank 0 of
 * [goneProbeQueue]) unless `jira.censusHours` have passed since the last scheduled run that was allowed to retry ([retriesAllowed]). A
 * MANUAL run (Refresh now) always asks everything, but a manual run that gets no answer neither counts toward the streak nor restarts the
 * retry clock; a manual run that gets an answer ends the streak, as any answering run does.
 *
 * It also keeps, per connection, what the queue needs: for its rotation, the last time each binding's read FAILED ([lastTried]: the least
 * recently tried goes first, so stuck bindings cannot trip the breaker ahead of every other one on every run). That rotation map outlives
 * a streak but never its binding: an answer removes the entry, [retain] drops every binding that is no longer gone, and [forget] drops all.
 *
 * The state is IN MEMORY, one small record per connection id (removed when nothing is left in it, when the connection's config changed,
 * or when a run finds the connection deleted or with nothing bound; a connection deleted between runs keeps its small record until a
 * restart, bounded and never read again): the server is one process and the sync runs inside it. A restart starts the count over, which
 * costs at most three more failing runs - accepted. Thread-safe: runs of different connections are concurrent, and every update is
 * atomic per key.
 */
internal class GoneProbeDamper {
    private data class State(
        val failingRuns: Int = 0,
        val retriedAt: Long = 0L,
        val tried: Map<UInt, Long> = emptyMap(),
    )

    private val states = ConcurrentHashMap<UInt, State>()

    /** The failing runs in a row counted so far (0 when there is no streak). */
    fun failingRuns(connectionId: UInt): Int = states[connectionId]?.failingRuns ?: 0

    /** Whether the connection is past [GONE_PROBE_FAILING_RUNS] failing runs in a row. */
    fun tripped(connectionId: UInt): Boolean = failingRuns(connectionId) >= GONE_PROBE_FAILING_RUNS

    /**
     * Whether a run at [now] may ask the retry ranks (1 and 2) of [goneProbeQueue]: a [manual] run always, any run while the connection is
     * not tripped, and a tripped scheduled run once [intervalMs] have passed since the last run that retried.
     */
    fun retriesAllowed(connectionId: UInt, manual: Boolean, now: Long, intervalMs: Long): Boolean {
        val state = states[connectionId]
        return manual || state == null || state.failingRuns < GONE_PROBE_FAILING_RUNS || now - state.retriedAt >= intervalMs
    }

    /** When each binding's read last failed (the queue's rotation key); empty when none is remembered. */
    fun lastTried(connectionId: UInt): Map<UInt, Long> = states[connectionId]?.tried.orEmpty()

    /** Keeps the memory of only the bindings in [goneIds] (the ones the sweep still judges gone): the rest left the queue for good. */
    fun retain(connectionId: UInt, goneIds: Set<UInt>) = update(connectionId) {
        it.copy(tried = it.tried.filterKeys { id -> id in goneIds })
    }

    /** A read of [bindingId] failed at [now]: remembered for the rotation. */
    fun failed(connectionId: UInt, bindingId: UInt, now: Long) {
        states.compute(connectionId) { _, old -> (old ?: State()).let { it.copy(tried = it.tried + (bindingId to now)) } }
    }

    /** Jira answered about [bindingId]: it no longer waits in the rotation. */
    fun answered(connectionId: UInt, bindingId: UInt) = update(connectionId) { it.copy(tried = it.tried - bindingId) }

    /** Whether no failing run has been counted yet: the streak's first failing run is the one that warns (per-issue lines, the breaker). */
    fun firstFailingRun(connectionId: UInt): Boolean = failingRuns(connectionId) == 0

    /**
     * Counts the run that ended normally: [sent] reads went out and [answered] of them got an answer; [retried] = the run was allowed to
     * ask the retry ranks (so a tripped connection's retry clock restarts at [now]); [manual] = a Refresh now. Nothing sent: nothing
     * changes. An answer: the streak (its count and clock) ends, and it is [StreakChange.RECOVERED] when it had tripped. No answer: one
     * more failing run - except a [manual] one, which changes nothing (a Refresh now neither counts nor restarts the retry clock).
     */
    fun endRun(connectionId: UInt, sent: Int, answered: Int, retried: Boolean, manual: Boolean, now: Long): StreakChange {
        if (sent == 0 || (answered == 0 && manual)) return StreakChange.NONE
        var change = StreakChange.NONE
        states.compute(connectionId) { _, old ->
            val state = old ?: State()
            val next = if (answered > 0) {
                if (state.failingRuns >= GONE_PROBE_FAILING_RUNS) change = StreakChange.RECOVERED
                state.copy(failingRuns = 0, retriedAt = 0L)
            } else {
                val runs = state.failingRuns + 1
                if (runs == GONE_PROBE_FAILING_RUNS) change = StreakChange.TRIPPED
                state.copy(failingRuns = runs, retriedAt = if (retried) now else state.retriedAt)
            }
            next.takeIf { it != State() }
        }
        return change
    }

    /** The connection's reading inputs changed or a run found it deleted: the streak and the rotation start over. */
    fun forget(connectionId: UInt) {
        states.remove(connectionId)
    }

    private fun update(connectionId: UInt, change: (State) -> State) {
        states.computeIfPresent(connectionId) { _, state -> change(state).takeIf { it != State() } }
    }
}
