package ch.nokillswit.flow

import ch.nokillswit.sync.requireFingerprintShape
import io.ktor.server.plugins.BadRequestException
import kotlinx.serialization.Serializable

/*
 * The per-sprint acknowledge of a capacity deviation (1.9): the wire DTOs and the shape rule. The write is
 * [CapacityAcknowledgeService], the routes `CapacityAcknowledgeRoutes.kt`, the document `flow-sync.md` "Acknowledge (1.9)".
 */

/**
 * `POST /integrations/flow/team-bindings/{id}/acknowledge`: the [fingerprint] the client read off a row of the capacity deviation view,
 * and that row's [sprintId]. A [sprintId] of `null` names the binding's own `TEAM_GONE` row. The key is REQUIRED on the wire (no default),
 * so a client that forgot it gets a `400` instead of acknowledging the team by accident.
 */
@Serializable
data class CapacityAcknowledgeRequest(val sprintId: Long?, val fingerprint: String)

/** The shape rules of [CapacityAcknowledgeRequest]: a positive sprint id (or null) and a 64-hex fingerprint; `400` otherwise. */
fun validateCapacityAcknowledge(request: CapacityAcknowledgeRequest): CapacityAcknowledgeRequest {
    if (request.sprintId != null && request.sprintId < 1) {
        throw BadRequestException("sprintId must be a positive number or null for the team's own row")
    }
    requireFingerprintShape(request.fingerprint)
    return request
}

/**
 * The stored acknowledgement the POST answers: the Jira `Acknowledgement` plus the row's [sprintId] (null = the team's own row).
 * [acknowledgedAt] is epoch millis, [acknowledgedBy] the acknowledging login's ACTIVE person's name else its display name (never the
 * email; the `createdBy` rule).
 */
@Serializable
data class CapacityAcknowledgement(
    val bindingId: UInt,
    val sprintId: Long?,
    val fingerprint: String,
    val acknowledgedAt: Long,
    val acknowledgedBy: String?,
)
