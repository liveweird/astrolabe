package ch.nokillswit.jira

import ch.nokillswit.planning.DeviationKind
import ch.nokillswit.sync.requireFingerprintShape
import kotlinx.serialization.Serializable

/**
 * `POST /integrations/jira/bindings/{id}/acknowledge`: the [fingerprint] the client read off the deviations view's item (always the
 * item's LIST fingerprint, whichever form) and, since 1.12, the [kind] of the ONE line to acknowledge. Without a [kind] (every request
 * before 1.12) the call acknowledges the binding's lines that have no current acknowledgement (all of them when each has one).
 */
@Serializable
data class AcknowledgeRequest(val fingerprint: String, val kind: DeviationKind? = null)

/** The shape rule of [AcknowledgeRequest.fingerprint] (64 lower-case hex), shared by the route and the service. */
fun validateAcknowledge(request: AcknowledgeRequest): AcknowledgeRequest {
    requireFingerprintShape(request.fingerprint)
    return request
}

/**
 * The stored acknowledgement: [kind] the line it covers (null = the kind-less form, which covered the lines without a current
 * acknowledgement), [fingerprint] the item's LIST fingerprint the client sent (the per-line fingerprints stay in the table),
 * [acknowledgedAt] epoch millis, [acknowledgedBy] the acknowledging login's ACTIVE person's name, else its display name - never the
 * email (the `createdBy` rule).
 */
@Serializable
data class Acknowledgement(
    val bindingId: UInt,
    val kind: DeviationKind?,
    val fingerprint: String,
    val acknowledgedAt: Long,
    val acknowledgedBy: String?,
)
