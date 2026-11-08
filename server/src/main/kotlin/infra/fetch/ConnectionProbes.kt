package ch.nokillswit.infra.fetch

import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.TimeoutCancellationException
import kotlinx.coroutines.withTimeout
import kotlinx.serialization.Serializable

/**
 * The Test-connection probe harness every connector shares (`jira/`, `flow/`): the row, [ProbeRun] and the two verdict codes. It lives
 * under `infra/` because the two connectors never name each other (`PackageBoundaryTest`).
 */

/** One probed endpoint's outcome. Never carries the token, a URL or a query string. */
@Serializable
data class ConnectionTestRow(
    val name: String,
    val path: String,
    val required: Boolean,
    val ok: Boolean,
    val status: Int? = null,
    val code: String? = null,
    val scopeHint: String? = null,
)

/** The row code of a probe that never ran because an earlier probe failed (`ok: false`, so a skipped REQUIRED row still fails the test). */
const val SKIPPED_CODE = "SKIPPED"

/** A probe's own verdict that is not an upstream failure (a configured project key the token cannot see): the row's [code]. */
class ProbeFailure(val code: String) : RuntimeException(code)

/**
 * The probe harness of Test connection (Flow's `ProbeRun`, ported): runs each endpoint check in SEQUENCE, at most [probeTimeoutMs] each
 * and [totalBudgetMs] together, never throwing - every outcome becomes a [ConnectionTestRow] in [rows]. Created when the test starts (its
 * total budget runs from [now] at construction).
 */
class ProbeRun(
    /** Test seam: an injected clock lets a test simulate the TOTAL budget eroding across probes without a real sleep. */
    private val now: () -> Long,
    totalBudgetMs: Long = TOTAL_BUDGET_MS,
    private val probeTimeoutMs: Long = PROBE_TIMEOUT_MS,
) {
    private val deadline = now() + totalBudgetMs
    private val collected = mutableListOf<ConnectionTestRow>()

    val rows: List<ConnectionTestRow> get() = collected

    /** Records a row for a check that never reached the network (it cannot start). */
    fun fail(name: String, path: String, required: Boolean, code: String, scopeHint: String? = null) {
        collected += ConnectionTestRow(name, path, required, ok = false, code = code, scopeHint = scopeHint)
    }

    /** Records a row for a probe that was not run because an earlier probe failed: not a failure of its own endpoint ([SKIPPED_CODE]). */
    fun skip(name: String, path: String, required: Boolean) = fail(name, path, required, SKIPPED_CODE)

    @Suppress("LongParameterList") // the row's own fields: one call shape for every probe
    suspend fun probe(name: String, path: String, required: Boolean, scopeHint: String? = null, block: suspend () -> Unit) {
        // The remaining TOTAL budget, not just [probeTimeoutMs]: a budget checked only once per probe never shrinks the probe's OWN
        // timeout, so a run of near-the-cap probes could together run well past the documented 30 s. The smaller of the two wins.
        val remaining = deadline - now()
        if (remaining <= 0) {
            fail(name, path, required, "TIMEOUT", scopeHint)
            return
        }
        try {
            withTimeout(minOf(probeTimeoutMs, remaining)) { block() }
            collected += ConnectionTestRow(name, path, required, ok = true, scopeHint = scopeHint)
        } catch (_: TimeoutCancellationException) {
            fail(name, path, required, "TIMEOUT", scopeHint)
        } catch (cause: CancellationException) {
            // A GENUINE coroutine cancellation (the caller's scope was cancelled) is not a probe outcome: it propagates, never a row.
            // Distinct from TimeoutCancellationException above, this function's own bounded wait expiring.
            throw cause
        } catch (cause: FetchException) {
            collected += ConnectionTestRow(
                name, path, required, ok = false, status = cause.status, code = cause.code, scopeHint = scopeHint,
            )
        } catch (cause: ProbeFailure) {
            fail(name, path, required, cause.code, scopeHint)
        } catch (_: RuntimeException) {
            // A raw `.jsonObject`/`.jsonArray`/`.jsonPrimitive` cast (here, or one a future client forgets to route through its decode
            // helper) throws `IllegalArgumentException` on a shape mismatch: reported as the one malformed probe, never a crashed test.
            fail(name, path, required, "INVALID_RESPONSE", scopeHint)
        }
    }

    private companion object {
        const val PROBE_TIMEOUT_MS = 10_000L
        const val TOTAL_BUDGET_MS = 30_000L
    }
}
