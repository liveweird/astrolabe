package ch.nokillswit.infra.fetch

import io.ktor.util.AttributeKey
import kotlinx.coroutines.sync.Semaphore

/**
 * The in-flight-call permits of the outbound transports, shared across connectors: every [SourceHttp] built over one pool draws on it,
 * so the in-flight response bodies (`maxConcurrentRequests x maxResponseBytes`) stay bounded however many connectors exist, and a permit is
 * what bounds how many bodies exist at once. A connector's wiring may publish the pool on `Application.attributes` ([OutboundPermitsKey]).
 */
class OutboundPermits(val count: Int) {
    val semaphore = Semaphore(count)
}

val OutboundPermitsKey = AttributeKey<OutboundPermits>("OutboundPermits")
