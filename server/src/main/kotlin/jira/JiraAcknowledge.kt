package ch.nokillswit.jira

import io.ktor.server.plugins.BadRequestException
import kotlinx.serialization.Serializable

/**
 * `409` problem type of the acknowledge: the fingerprint the client saw is not the one of the binding's deviations now, or the
 * binding has none to acknowledge. The client re-reads the view and decides again.
 */
const val STALE_DEVIATIONS_PROBLEM = "urn:astrolabe:problem:stale-deviations"

private val FINGERPRINT_SHAPE = Regex("^[0-9a-f]{64}$")

/** `POST /integrations/jira/bindings/{id}/acknowledge`: the [fingerprint] the client read off the deviations view's item. */
@Serializable
data class AcknowledgeRequest(val fingerprint: String)

/** The shape rule of [AcknowledgeRequest.fingerprint] (64 lower-case hex), shared by the route and the service. */
fun validateAcknowledge(request: AcknowledgeRequest): AcknowledgeRequest {
    if (!FINGERPRINT_SHAPE.matches(request.fingerprint)) {
        throw BadRequestException("fingerprint must be 64 lower-case hexadecimal characters")
    }
    return request
}

/**
 * The stored acknowledgement: [acknowledgedAt] epoch millis, [acknowledgedBy] the acknowledging login's ACTIVE person's name, else its
 * display name - never the email (the `createdBy` rule).
 */
@Serializable
data class Acknowledgement(val bindingId: UInt, val fingerprint: String, val acknowledgedAt: Long, val acknowledgedBy: String?)
