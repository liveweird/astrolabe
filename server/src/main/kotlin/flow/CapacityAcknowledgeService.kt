package ch.nokillswit.flow

import ch.nokillswit.authz.ConflictException
import ch.nokillswit.authz.NotFoundException
import ch.nokillswit.infra.db.lockActiveForWrite
import ch.nokillswit.infra.db.nowMillis
import ch.nokillswit.planning.DeviationSeverity
import ch.nokillswit.planning.creatorsOf
import ch.nokillswit.sync.STALE_DEVIATIONS_PROBLEM
import ch.nokillswit.teams.TeamGuard
import io.ktor.util.AttributeKey
import kotlinx.coroutines.flow.toList
import org.jetbrains.exposed.v1.core.*
import org.jetbrains.exposed.v1.core.dao.id.UIntIdTable
import org.jetbrains.exposed.v1.r2dbc.*
import org.jetbrains.exposed.v1.r2dbc.transactions.suspendTransaction

val CapacityAcknowledgeServiceKey = AttributeKey<CapacityAcknowledgeService>("CapacityAcknowledgeService")

/** What a committed acknowledge leaves for the route's audit line (written AFTER the commit): the binding, its Flow team and the row. */
class CapacityAcknowledgeOutcome(
    val acknowledgement: CapacityAcknowledgement,
    val connectionId: UInt,
    val teamId: UInt,
    val flowTeamId: Int,
    val kind: CapacityDeviationKind,
    val severity: DeviationSeverity,
)

/** What a committed un-acknowledge leaves for the audit line: the binding and the fingerprint that was cleared. */
class CapacityUnacknowledgeOutcome(
    val connectionId: UInt,
    val teamId: UInt,
    val flowTeamId: Int,
    val fingerprint: String,
)

/**
 * The per-sprint acknowledgement of a capacity deviation (1.9, V26 `flow_capacity_acknowledgements`): the service OWNS the table and
 * READS the binding, its team and, through [CapacityDeviationService], the whole deviation computation. **No plan lock and no
 * revision bump**: an acknowledgement is not plan state (like a binding or a capacity period). The key is (binding, Flow sprint id);
 * a null sprint is the binding's own `TEAM_GONE` row. Rows are HARD: an un-acknowledge deletes, a re-acknowledge rewrites the stamp.
 *
 * Both writes run in ONE short transaction in the Jira acknowledge's order: the binding row `FOR NO KEY UPDATE`
 * ([lockActiveForWrite]; gone = `404`), the binding re-read with its team ACTIVE (a dead team = `404`), the caller's [TeamGuard] run
 * AGAIN against the stored team (the route passes `requireTeamManagerOrAdmin(…, teams::lockedIsActiveManager)`: a request can be held
 * open between its outer guard and this lock, so only this verdict authorizes the write), and then - for [acknowledge] - the binding's
 * rows RECOMPUTED here ([CapacityDeviationService.computeBindingInTransaction]) and the named row compared with the fingerprint the
 * client saw. Every acknowledge or withdrawal of one binding queues behind its row lock, so the UPDATE-then-INSERT below is exact;
 * the unique index `uq_flow_capacity_acks_key` is only the backstop. The mirror's run replace and a capacity PUT are not excluded
 * (statement-by-statement READ COMMITTED reads): a change landing in between makes the compare a `409` (the client reads again) or, at
 * worst, stores the fingerprint of a mixed state - harmless, because a stored fingerprint is re-compared on every read and such an
 * acknowledgement just reads `current = false`.
 *
 * **Lock order:** the acknowledge is [FlowTeamBindingService.unbind]'s shape - the binding row FIRST, then the guard's team and person
 * rows `FOR SHARE`, then the acknowledgement rows. It takes neither the bind lock nor the connection row, so it joins the no-cycle
 * argument as a second binding-first path.
 */
class CapacityAcknowledgeService(
    private val database: R2dbcDatabase,
    private val deviations: CapacityDeviationService,
    private val bindings: FlowTeamBindingService,
) {
    object Acknowledgements : UIntIdTable("flow_capacity_acknowledgements") {
        val bindingId = reference("binding_id", FlowTeamBindingService.Bindings)

        /** Flow's sprint id; NULL = the binding's `TEAM_GONE` row (`NULLS NOT DISTINCT` makes it unique too). */
        val sprintId = long("sprint_id").nullable()
        val fingerprint = varchar("fingerprint", length = FINGERPRINT_WIDTH)
        val ackAt = long("ack_at")

        /** The acknowledging login's id (`users.id` is BIGINT; V26 has the FK, no `users` import here: `flow/` names no `users` type). */
        val ackByUserId = long("ack_by_user_id")
    }

    /**
     * Stamps the acknowledgement of [sprintId]'s row (null = the team's own) of binding [bindingId] with [fingerprint] by login
     * [byUserId]. `409` [STALE_DEVIATIONS_PROBLEM] when the binding has no such row now, or its fingerprint is not [fingerprint]; a
     * second acknowledge of the same state simply restamps who and when.
     */
    suspend fun acknowledge(
        bindingId: UInt,
        sprintId: Long?,
        fingerprint: String,
        byUserId: UInt,
        guard: TeamGuard,
    ): CapacityAcknowledgeOutcome = suspendTransaction(database) {
        validateCapacityAcknowledge(CapacityAcknowledgeRequest(sprintId, fingerprint))
        val binding = lockedBinding(bindingId, guard)
        val row = deviations.computeBindingInTransaction(binding).orEmpty().firstOrNull { it.detail.sprintId == sprintId }
            ?: throw ConflictException(
                if (sprintId == null) "The team has no deviation of its own" else "The sprint has no deviation to acknowledge",
                STALE_DEVIATIONS_PROBLEM,
            )
        if (row.fingerprint != fingerprint) throw ConflictException("The deviation changed since it was read", STALE_DEVIATIONS_PROBLEM)
        val stamp = nowMillis()
        val updated = Acknowledgements.update({ keyOf(bindingId, sprintId) }) {
            it[this.fingerprint] = fingerprint
            it[ackAt] = stamp
            it[ackByUserId] = byUserId.toLong()
        }
        if (updated == 0) {
            Acknowledgements.insert {
                it[this.bindingId] = bindingId
                it[this.sprintId] = sprintId
                it[this.fingerprint] = fingerprint
                it[ackAt] = stamp
                it[ackByUserId] = byUserId.toLong()
            }
        }
        val by = creatorsOf(listOf(byUserId))[byUserId]?.name
        CapacityAcknowledgeOutcome(
            CapacityAcknowledgement(bindingId, sprintId, fingerprint, stamp, by),
            binding.connectionId, binding.teamId, binding.flowTeamId, row.kind, row.severity,
        )
    }

    /** Clears the acknowledgement of [sprintId]'s row (null = the team's own) of [bindingId], current or stale; `404` if none. */
    suspend fun unacknowledge(bindingId: UInt, sprintId: Long?, guard: TeamGuard): CapacityUnacknowledgeOutcome =
        suspendTransaction(database) {
            val binding = lockedBinding(bindingId, guard)
            val cleared = Acknowledgements.select(Acknowledgements.fingerprint).where { keyOf(bindingId, sprintId) }.toList().singleOrNull()
                ?.get(Acknowledgements.fingerprint) ?: throw NotFoundException("Acknowledgement not found")
            Acknowledgements.deleteWhere { keyOf(bindingId, sprintId) }
            CapacityUnacknowledgeOutcome(binding.connectionId, binding.teamId, binding.flowTeamId, cleared)
        }

    /** Locks binding [bindingId] (`404` once gone), re-reads it with its ACTIVE team (`404` when dead) and runs [guard] on that team. */
    private suspend fun lockedBinding(bindingId: UInt, guard: TeamGuard): FlowTeamBindingRow {
        if (!FlowTeamBindingService.Bindings.lockActiveForWrite(bindingId)) throw NotFoundException(NOT_FOUND)
        // `bindingOf` nests into this transaction: the read runs under the row lock just taken.
        val binding = bindings.bindingOf(bindingId) ?: throw NotFoundException(NOT_FOUND)
        guard(binding.teamId)
        return binding
    }

    /** The row's key as a predicate; a null sprint is `IS NULL` (the `TEAM_GONE` row), never `= NULL`. */
    private fun keyOf(bindingId: UInt, sprintId: Long?): Op<Boolean> {
        val sprint = sprintId?.let { Acknowledgements.sprintId eq it } ?: Acknowledgements.sprintId.isNull()
        return (Acknowledgements.bindingId eq bindingId) and sprint
    }

    private companion object {
        const val NOT_FOUND = "Flow team binding not found"
        const val FINGERPRINT_WIDTH = 64
    }
}
