package ch.nokillswit.planning

import ch.nokillswit.authz.ConflictException
import ch.nokillswit.authz.orNotFound
import ch.nokillswit.infra.db.active
import ch.nokillswit.infra.db.insertRows
import ch.nokillswit.infra.db.nowMillis
import io.ktor.server.plugins.BadRequestException
import io.ktor.util.AttributeKey
import kotlinx.coroutines.flow.toList
import org.jetbrains.exposed.v1.core.*
import org.jetbrains.exposed.v1.r2dbc.*

val PlanOrderServiceKey = AttributeKey<PlanOrderService>("PlanOrderService")

/**
 * The shared order of the work streams and of each work stream's programs (V34; `plan-tree.md`): `work_stream_orders` (one global
 * list, its revision `plan_state.work_stream_order_revision`), `program_orders` (one list per work stream, its revision
 * `program_order_state.revision`). Hard-delete position joins rewritten wholesale (`persistence.md` "Soft delete"), the V13/V17 shape:
 * no row means "by name", the order before V34, so nothing is stored for a list nobody re-arranged. Every write runs in [withPlanWrite]
 * (the revision compare and the rewrite are atomic with every other plan writer) and compares against ITS list's own revision, never
 * the plan revision: another list's reorder or any other plan write never stales it.
 */
class PlanOrderService(private val database: R2dbcDatabase) {
    object WorkStreamOrders : Table("work_stream_orders") {
        val workStreamId = reference("work_stream_id", WorkStreamService.WorkStreams)
        val position = integer("position")
        override val primaryKey = PrimaryKey(workStreamId)
    }

    object ProgramOrders : Table("program_orders") {
        val programId = reference("program_id", ProgramService.Programs)
        val workStreamId = reference("work_stream_id", WorkStreamService.WorkStreams)
        val position = integer("position")
        override val primaryKey = PrimaryKey(programId)
    }

    object ProgramOrderState : Table("program_order_state") {
        val workStreamId = reference("work_stream_id", WorkStreamService.WorkStreams)
        val revision = long("revision")
        val updatedAt = long("updated_at")
        override val primaryKey = PrimaryKey(workStreamId)
    }

    /**
     * Replaces the work stream order under the plan lock, in this order: the stale check -> every id must name an ACTIVE work stream
     * (400) -> the rewrite: the listed streams get positions 1..n in order, every other stream is unlisted, an empty list removes every
     * row (the reset) -> the stamp. The stale check is `stored order revision > expectedRevision` or `expectedRevision >` the plan
     * revision under the lock: 409 `urn:astrolabe:problem:stale-revision`, nothing written. An order never written has revision 0, so
     * its first write passes with any valid `expectedRevision`. ADMIN-only: the route's `requireAdmin` is the whole guard (a registry's
     * writes are not re-guarded under the lock). A throw anywhere rolls the bump back with the rest.
     */
    suspend fun replaceWorkStreamOrder(request: WorkStreamOrderUpdateRequest): PlanOrderOutcome {
        validateWorkStreamOrder(request)
        val ids = request.workStreamIds
        val write = database.withPlanWrite { revision ->
            if (readWorkStreamOrderRevision() > request.expectedRevision || request.expectedRevision > revision) {
                throw ConflictException(
                    "The work stream order changed after revision ${request.expectedRevision}; reload the plan",
                    problemType = STALE_REVISION_PROBLEM,
                )
            }
            requireActiveWorkStreams(ids)
            val before = listedWorkStreams()
            WorkStreamOrders.deleteAll()
            WorkStreamOrders.insertRows(ids.withIndex()) { (index, id) ->
                this[WorkStreamOrders.workStreamId] = id
                this[WorkStreamOrders.position] = index + 1
            }
            stampWorkStreamOrderRevision(revision + 1)
            before
        }
        return PlanOrderOutcome(revisionFrom = write.revision - 1, revisionTo = write.revision, orderFrom = write.value)
    }

    /**
     * Replaces one work stream's program order under the plan lock, in this order: the stream's chain is re-read (gone = 404) ->
     * [guard] (the caller's `requireOwnerOrAdmin` against that chain as of the lock: 403, no bump) -> the stale check against THIS
     * stream's program order revision -> every id must name an ACTIVE program OF THIS stream (400) -> the rewrite. The rewrite deletes
     * `WHERE work_stream_id = ? OR program_id IN (ids)`, so a row a rolled-back build left behind (a program that moved or was deleted
     * without its hook) cannot break the insert; the listed programs get 1..n, the stream's others are unlisted.
     */
    suspend fun replaceProgramOrder(workStreamId: UInt, request: ProgramOrderUpdateRequest, guard: PlanGuard): PlanOrderOutcome {
        validateProgramOrder(request)
        val ids = request.programIds
        val write = database.withPlanWrite { revision ->
            guard(workStreamChain(workStreamId).orNotFound("Work stream"))
            if (programOrderRevisionOf(workStreamId) > request.expectedRevision || request.expectedRevision > revision) {
                throw ConflictException(
                    "This work stream's program order changed after revision ${request.expectedRevision}; reload the plan",
                    problemType = STALE_REVISION_PROBLEM,
                )
            }
            requireProgramsOfStream(workStreamId, ids)
            val before = listedPrograms(workStreamId)
            val sweep: Op<Boolean> = if (ids.isEmpty()) {
                ProgramOrders.workStreamId eq workStreamId
            } else {
                (ProgramOrders.workStreamId eq workStreamId) or (ProgramOrders.programId inList ids)
            }
            ProgramOrders.deleteWhere { sweep }
            ProgramOrders.insertRows(ids.withIndex()) { (index, id) ->
                this[ProgramOrders.programId] = id
                this[ProgramOrders.workStreamId] = workStreamId
                this[ProgramOrders.position] = index + 1
            }
            stampProgramOrderRevision(workStreamId, revision + 1)
            before
        }
        return PlanOrderOutcome(revisionFrom = write.revision - 1, revisionTo = write.revision, orderFrom = write.value)
    }
}

/**
 * Every id must name an ACTIVE work stream: a client-supplied id is a 400, never a foreign-key 500. The plan lock keeps it true until
 * commit.
 */
private suspend fun requireActiveWorkStreams(ids: List<UInt>) {
    if (ids.isEmpty()) return
    val streams = WorkStreamService.WorkStreams
    val found = streams.select(streams.id).where { (streams.id inList ids) and streams.active() }.toList()
        .map { it[streams.id].value }.toSet()
    val missing = ids.filter { it !in found }
    if (missing.isNotEmpty()) {
        throw BadRequestException("Unknown or deleted work stream ids: ${missing.take(MAX_LISTED_MISSING).joinToString(", ")}")
    }
}

/** Every id must name an ACTIVE program whose work stream is [workStreamId]: a program of another stream cannot enter this list (400). */
private suspend fun requireProgramsOfStream(workStreamId: UInt, ids: List<UInt>) {
    if (ids.isEmpty()) return
    val programs = ProgramService.Programs
    val found = programs.select(programs.id)
        .where { (programs.id inList ids) and (programs.workStreamId eq workStreamId) and programs.active() }
        .toList().map { it[programs.id].value }.toSet()
    val missing = ids.filter { it !in found }
    if (missing.isNotEmpty()) {
        throw BadRequestException(
            "Unknown, deleted or other-work-stream program ids: ${missing.take(MAX_LISTED_MISSING).joinToString(", ")}",
        )
    }
}

/** The listed work streams in position order (the audit's `orderFrom`). Runs inside the caller's transaction. */
private suspend fun listedWorkStreams(): List<UInt> {
    val orders = PlanOrderService.WorkStreamOrders
    return orders.select(orders.workStreamId).orderBy(orders.position).toList().map { it[orders.workStreamId].value }
}

/** The stream's listed programs in position order. Runs inside the caller's transaction. */
private suspend fun listedPrograms(workStreamId: UInt): List<UInt> {
    val orders = PlanOrderService.ProgramOrders
    return orders.select(orders.programId).where { orders.workStreamId eq workStreamId }.orderBy(orders.position).toList()
        .map { it[orders.programId].value }
}

/** The stream's stored program order revision, or 0 when it was never written. Runs inside the caller's transaction. */
internal suspend fun programOrderRevisionOf(workStreamId: UInt): Long {
    val state = PlanOrderService.ProgramOrderState
    return state.select(state.revision).where { state.workStreamId eq workStreamId }.toList().singleOrNull()?.get(state.revision) ?: 0L
}

private suspend fun stampProgramOrderRevision(workStreamId: UInt, revision: Long) {
    val state = PlanOrderService.ProgramOrderState
    val stamp = nowMillis()
    val updated = state.update({ state.workStreamId eq workStreamId }) {
        it[state.revision] = revision
        it[updatedAt] = stamp
    }
    if (updated == 0) {
        state.insert {
            it[state.workStreamId] = workStreamId
            it[state.revision] = revision
            it[updatedAt] = stamp
        }
    }
}

/**
 * Takes a deleted work stream out of the work stream order and closes the gap: the row is hard-deleted and the positions above it
 * shift down by one in ONE `UPDATE` (`uq_work_stream_orders_position` is DEFERRABLE INITIALLY DEFERRED, so it is only checked at
 * commit). `WorkStreamService.delete` calls it in the same plan-locked transaction. The order revision is NOT stamped (the team
 * order's rule: the admin's list is still the admin's list); an unlisted stream is a no-op.
 */
internal suspend fun removeFromWorkStreamOrder(workStreamId: UInt) {
    val orders = PlanOrderService.WorkStreamOrders
    val position = orders.select(orders.position).where { orders.workStreamId eq workStreamId }.toList()
        .singleOrNull()?.get(orders.position) ?: return
    orders.deleteWhere { orders.workStreamId eq workStreamId }
    orders.update({ orders.position greater position }) { it[orders.position] = orders.position - 1 }
}

/**
 * Takes a program out of its work stream's order and closes the gap in that stream's list: `ProgramService.delete` calls it when the
 * program is deleted and `ProgramService.move` when it changes work stream (it leaves the source list and is unlisted in the target),
 * in the same plan-locked transaction. Never stamps the order revision; an unlisted program is a no-op.
 */
internal suspend fun removeFromProgramOrder(programId: UInt) {
    val orders = PlanOrderService.ProgramOrders
    val row = orders.select(orders.workStreamId, orders.position).where { orders.programId eq programId }.toList()
        .singleOrNull() ?: return
    val streamId = row[orders.workStreamId].value
    val position = row[orders.position]
    orders.deleteWhere { orders.programId eq programId }
    orders.update({ (orders.workStreamId eq streamId) and (orders.position greater position) }) {
        it[orders.position] = orders.position - 1
    }
}
