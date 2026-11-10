package ch.nokillswit.infra.fetch

import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.atomic.AtomicLong

// The per-tenant shared rate-limit pause of `SourceHttp` (split out of `SourceHttp.kt` to keep it under the source-file size cap).

/**
 * Per tenant key: the epoch-millis [clock] instant before which no call of that tenant starts a request. A tenant's entry stays for
 * the process's life (one tiny entry per cloud id). [sleeper] is the cancellable wait (a test injects a no-op).
 */
internal class TenantPauses(
    private val clock: () -> Long,
    private val sleeper: suspend (Long) -> Unit,
) {
    private val pauses = ConcurrentHashMap<String, AtomicLong>()

    /**
     * The instant [pauseKey]'s tenant is paused until, if that is still ahead and is not [seen] (the one a wait already served: a
     * test's no-op [sleeper] and frozen clock must not loop forever).
     */
    fun pending(pauseKey: String?, seen: Long): Long? {
        val target = pauseKey?.let { pauses[it]?.get() } ?: return null
        return target.takeIf { it > clock() && it != seen }
    }

    /** Suspends until [pauseKey]'s pause has passed (re-checking if it was extended); returns the last pause instant waited for. */
    suspend fun await(pauseKey: String?, seen: Long, tally: CallTally?): Long {
        var waitedFor = seen
        while (true) {
            val target = pending(pauseKey, waitedFor) ?: return waitedFor
            waitedFor = target
            val wait = target - clock()
            tally?.addTenantPause(wait.coerceAtLeast(0))
            sleeper(wait)
        }
    }

    /** Records "not before [untilMillis]" for [pauseKey]: `max(current, untilMillis)`. */
    fun record(pauseKey: String, untilMillis: Long) {
        pauses.computeIfAbsent(pauseKey) { AtomicLong(0) }.accumulateAndGet(untilMillis) { a, b -> maxOf(a, b) }
    }
}
