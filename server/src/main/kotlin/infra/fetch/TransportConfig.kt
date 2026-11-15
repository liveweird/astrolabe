package ch.nokillswit.infra.fetch

import ch.nokillswit.infra.config.requireConfigInt
import ch.nokillswit.infra.config.requireConfigLong
import io.ktor.server.config.ApplicationConfig

// The five boot settings every connector's outbound transport reads (`SourceHttp`'s timeout, deadline, body cap, permits and retries),
// read and bounded in ONE place. Each connector still owns its bounds and its other settings; a malformed or out-of-range value refuses
// startup naming the key, never anything else (`requireConfigInt`, `requireConfigLong`).

/** The inclusive bounds of a connector's transport settings: a connector's own, because Jira's body cap and permits differ from Flow's. */
class TransportBounds(
    val requestTimeoutSeconds: LongRange,
    val requestDeadlineSeconds: LongRange,
    val maxResponseBytes: LongRange,
    val maxConcurrentRequests: IntRange,
    val maxRetries: IntRange,
)

/** A connector's validated transport settings, as `<prefix>.requestTimeoutSeconds`, `.requestDeadlineSeconds`, … configure them. */
class TransportConfig(
    val requestTimeoutSeconds: Long,
    val requestDeadlineSeconds: Long,
    val maxResponseBytes: Long,
    val maxConcurrentRequests: Int,
    val maxRetries: Int,
)

/**
 * Reads the five transport settings under [prefix] (`jira`, `flow`) and checks each against [bounds]. The keys are read in the order of
 * [TransportConfig]'s fields, so a config with several bad values names the same first key the hand-written reads always did.
 */
fun readTransportConfig(config: ApplicationConfig, prefix: String, bounds: TransportBounds): TransportConfig = TransportConfig(
    requestTimeoutSeconds = requireConfigLong(
        config, "$prefix.requestTimeoutSeconds", bounds.requestTimeoutSeconds.first, bounds.requestTimeoutSeconds.last,
    ),
    requestDeadlineSeconds = requireConfigLong(
        config, "$prefix.requestDeadlineSeconds", bounds.requestDeadlineSeconds.first, bounds.requestDeadlineSeconds.last,
    ),
    maxResponseBytes = requireConfigLong(config, "$prefix.maxResponseBytes", bounds.maxResponseBytes.first, bounds.maxResponseBytes.last),
    maxConcurrentRequests = requireConfigInt(
        config, "$prefix.maxConcurrentRequests", bounds.maxConcurrentRequests.first, bounds.maxConcurrentRequests.last,
    ),
    maxRetries = requireConfigInt(config, "$prefix.maxRetries", bounds.maxRetries.first, bounds.maxRetries.last),
)
