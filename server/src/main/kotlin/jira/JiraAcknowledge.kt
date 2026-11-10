package ch.nokillswit.jira

import ch.nokillswit.sync.requireFingerprintShape
import kotlinx.serialization.Serializable

/** `POST /integrations/jira/bindings/{id}/acknowledge`: the [fingerprint] the client read off the deviations view's item. */
@Serializable
data class AcknowledgeRequest(val fingerprint: String)

/** The shape rule of [AcknowledgeRequest.fingerprint] (64 lower-case hex), shared by the route and the service. */
fun validateAcknowledge(request: AcknowledgeRequest): AcknowledgeRequest {
    requireFingerprintShape(request.fingerprint)
    return request
}

/**
 * The stored acknowledgement: [acknowledgedAt] epoch millis, [acknowledgedBy] the acknowledging login's ACTIVE person's name, else its
 * display name - never the email (the `createdBy` rule).
 */
@Serializable
data class Acknowledgement(val bindingId: UInt, val fingerprint: String, val acknowledgedAt: Long, val acknowledgedBy: String?)
