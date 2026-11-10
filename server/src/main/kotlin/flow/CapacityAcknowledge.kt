package ch.nokillswit.flow

import ch.nokillswit.sync.requireFingerprintShape
import io.ktor.server.plugins.BadRequestException
import kotlinx.serialization.Serializable

/*
 * The per-sprint acknowledge of a capacity deviation (1.9): the wire DTOs and the shape rule. The write is
 * [CapacityAcknowledgeService], the routes `CapacityAcknowledgeRoutes.kt`, the document `flow-sync.md` "Acknowledge (1.9)"; 1.10 adds
 * the batch.
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

/** The most rows one acknowledge-all names: a binding cannot list more rows than Flow's document holds sprints. */
const val MAX_CAPACITY_ACKNOWLEDGE_ROWS = FLOW_SPRINT_CAP

/**
 * `POST /integrations/flow/team-bindings/{id}/acknowledge-all` (1.10): the rows the client lists as open, each with the fingerprint it read
 * (the single acknowledge's pair). All or nothing: one row that is not listed now, or has another fingerprint, is the shared `409`.
 */
@Serializable
data class CapacityAcknowledgeAllRequest(val items: List<CapacityAcknowledgeRequest>)

/** The shape rules of [CapacityAcknowledgeAllRequest]: 1..[MAX_CAPACITY_ACKNOWLEDGE_ROWS] valid items, no row twice; `400` otherwise. */
fun validateCapacityAcknowledgeAll(request: CapacityAcknowledgeAllRequest): CapacityAcknowledgeAllRequest {
    if (request.items.isEmpty() || request.items.size > MAX_CAPACITY_ACKNOWLEDGE_ROWS) {
        throw BadRequestException("items must hold 1 to $MAX_CAPACITY_ACKNOWLEDGE_ROWS rows")
    }
    request.items.forEach(::validateCapacityAcknowledge)
    if (request.items.mapTo(HashSet()) { it.sprintId }.size != request.items.size) {
        throw BadRequestException("items must name each row once")
    }
    return request
}

/** What `POST …/acknowledge-all` answers: the stored acknowledgements, in the request's order. */
@Serializable
data class CapacityAcknowledgeBatch(val acknowledged: List<CapacityAcknowledgement>)

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
