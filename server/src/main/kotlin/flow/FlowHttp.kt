package ch.nokillswit.flow

import ch.nokillswit.infra.fetch.DEFAULT_REQUEST_DEADLINE_MILLIS
import ch.nokillswit.infra.fetch.FetchSource
import ch.nokillswit.infra.fetch.OutboundPermits
import ch.nokillswit.infra.fetch.SourceHttp
import ch.nokillswit.infra.fetch.defaultMaxResponseNodes
import io.ktor.client.HttpClient
import kotlinx.coroutines.delay

// Flow's flavour of the shared transport (`infra/fetch/SourceHttp.kt`, the way `jira/JiraHttp.kt` wraps it): its name, its response-cap
// setting and the `Authorization` header. Flow sends no rate-limit pause signal on a success (its 429 is the transport's own, retried with
// backoff), so the source carries `RateLimitSignal.NONE`.

/** The Flow upstream as the fetch machinery names it: messages start "Flow fetch failed", the cap is `flow.maxResponseBytes`. */
internal val FLOW_SOURCE = FetchSource("Flow", "flow.maxResponseBytes")

/** The shared transport for Flow. Every parameter is [SourceHttp]'s; `configureFlow` and the tests build it here. */
internal fun createFlowHttp(
    client: HttpClient,
    maxRetries: Int,
    maxResponseBytes: Long,
    maxConcurrentRequests: Int,
    requestDeadlineMillis: Long = DEFAULT_REQUEST_DEADLINE_MILLIS,
    random: () -> Double = Math::random,
    sleeper: suspend (Long) -> Unit = { delay(it) },
    clock: () -> Long = System::currentTimeMillis,
    maxResponseNodes: Long = defaultMaxResponseNodes(maxResponseBytes),
    permits: OutboundPermits? = null,
): SourceHttp = SourceHttp(
    client, maxRetries, maxResponseBytes, maxConcurrentRequests, FLOW_SOURCE, requestDeadlineMillis, random, sleeper, clock,
    maxResponseNodes, permits,
)

/** `Authorization` header value for a Flow service token - never logged (`.claude/docs/security.md` "Log hygiene"). */
internal fun flowAuthHeader(apiToken: String): String = "Bearer $apiToken"
