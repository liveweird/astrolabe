package ch.nokillswit.planning

import io.ktor.server.plugins.BadRequestException
import kotlinx.serialization.Serializable

/** The most ids one order PUT may list (the plan holds about five work streams and twenty programs; the same ceiling as the others). */
const val MAX_PLAN_ORDER_IDS = 1000

/**
 * The wholesale order of the work streams (`PUT /work-stream-order`): [workStreamIds] in the given order become positions 1..n; every
 * other work stream is unlisted (after the listed ones, by name), and an EMPTY list resets to name order. [expectedRevision] is the work
 * stream order's revision as the client read it (`workStreamOrderRevision` of the plan view; any value up to the plan revision while
 * the order was never written).
 */
@Serializable
data class WorkStreamOrderUpdateRequest(
    val expectedRevision: Long,
    val workStreamIds: List<UInt>,
)

/**
 * The wholesale order of one work stream's programs (`PUT /work-streams/{id}/program-order`), the same shape: [programIds] become
 * positions 1..n among the stream's programs; [expectedRevision] is THIS stream's program order revision.
 */
@Serializable
data class ProgramOrderUpdateRequest(
    val expectedRevision: Long,
    val programIds: List<UInt>,
)

/** The answer of an order write: the plan revision it left behind, which is now that list's own order revision. */
@Serializable
data class PlanOrderResponse(val revision: Long)

/** What an order write replaced, for the audit trail: the plan revisions around it and the listed order BEFORE it. */
data class PlanOrderOutcome(val revisionFrom: Long, val revisionTo: Long, val orderFrom: List<UInt>)

/**
 * The request-shape rules shared by both PUTs, checked before the lock: a non-negative revision, at most [MAX_PLAN_ORDER_IDS] ids, no id
 * twice.
 */
private fun validateOrder(expectedRevision: Long, ids: List<UInt>, field: String) {
    if (expectedRevision < 0) throw BadRequestException("expectedRevision must not be negative")
    if (ids.size > MAX_PLAN_ORDER_IDS) throw BadRequestException("$field must list at most $MAX_PLAN_ORDER_IDS ids")
    if (ids.toSet().size != ids.size) throw BadRequestException("$field must be distinct")
}

fun validateWorkStreamOrder(request: WorkStreamOrderUpdateRequest) =
    validateOrder(request.expectedRevision, request.workStreamIds, "workStreamIds")

fun validateProgramOrder(request: ProgramOrderUpdateRequest) =
    validateOrder(request.expectedRevision, request.programIds, "programIds")
