package ch.nokillswit.infra.fetch

import io.ktor.http.Headers
import io.ktor.http.HttpMethod
import kotlin.coroutines.AbstractCoroutineContextElement
import kotlin.coroutines.CoroutineContext
import kotlinx.coroutines.sync.Semaphore
import kotlinx.coroutines.withTimeoutOrNull
import kotlinx.serialization.json.JsonElement

// The value types of one `SourceHttp` call (split out of `SourceHttp.kt` to keep it under the source-file size cap).

/** What one request needs on every attempt; [pauseKey] names the tenant whose shared pause it obeys (null = none). */
internal class PendingCall(
    val method: HttpMethod,
    val url: String,
    val query: List<Pair<String, String>>,
    val jsonBody: JsonElement?,
    val authHeader: String?,
    val statusCodeOverrides: Map<Int, String>,
    val pauseKey: String?,
    /** The sync job's [CallTally] when the call runs inside one, else null. */
    val tally: CallTally?,
    /** Told the size of the response body on the wire, once it is read (the size a character-per-run ceiling charges). */
    val onWireBytes: ((Int) -> Unit)?,
    /**
     * Applied to the parsed tree (and the response headers) while the big-parse lock is still held (`SourceHttp.requestAs`);
     * identity for a plain request.
     */
    val transform: (JsonElement, Headers) -> Any?,
)

/** One attempt's verdict: the parsed body, or "try again" with what the backoff decision needs. */
internal sealed interface Outcome

internal class Done(val value: Any?) : Outcome

internal class Retry(
    val retryAfterSeconds: Long?,
    /** True for a 429, or a 5xx carrying `Retry-After`: the TENANT is rate limiting, so its other calls pause too. */
    val pausesOthers: Boolean,
    val terminal: () -> FetchException,
) : Outcome

/**
 * A coroutine-context element: an INTERACTIVE caller (a plain user's bind) will not queue for a permit longer than [millis]. A call that
 * would wait longer fails fast with `BUSY` instead, so a burst of binds cannot hold an administrator's Test connection behind them. The
 * permit pool stays Jira's one process-wide pool, the one `JiraHeapFit` sized the heap on; nothing here adds a permit. (The process has a
 * second, separate pool and big-parse lock for Flow, kept inside the heap reserve by its own tight bounds: `.claude/docs/security.md`
 * "The Flow consumer".)
 */
class PermitWait(val millis: Long) : AbstractCoroutineContextElement(Key) {
    companion object Key : CoroutineContext.Key<PermitWait>
}

/** One call's hold on a semaphore permit, so it can be handed back while the call only waits (backoff, a tenant pause). */
internal class Permit(private val semaphore: Semaphore) {
    private var held = false

    /** Takes a permit, waiting at most [limitMillis] (null = as long as it takes); false when none came free in time. */
    suspend fun acquire(limitMillis: Long? = null): Boolean {
        when {
            limitMillis == null -> {
                semaphore.acquire()
                held = true
            }
            semaphore.tryAcquire() -> held = true
            // `held` is set in the same resumption that returns from acquire(): a cancel or timeout landing right after the grant still
            // finds it set, so the caller's `release()` hands the permit back.
            else -> withTimeoutOrNull(limitMillis.coerceAtLeast(0)) {
                semaphore.acquire()
                held = true
            }
        }
        return held
    }

    fun release() {
        if (held) {
            held = false
            semaphore.release()
        }
    }
}
