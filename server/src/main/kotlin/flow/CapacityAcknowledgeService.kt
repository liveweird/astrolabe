package ch.nokillswit.flow

import ch.nokillswit.authz.ConflictException
import ch.nokillswit.authz.NotFoundException
import ch.nokillswit.infra.db.insertRows
import ch.nokillswit.infra.db.lockActiveForWrite
import ch.nokillswit.infra.db.nowMillis
import ch.nokillswit.infra.json.FINGERPRINT_WIDTH
import ch.nokillswit.planning.creatorsOf
import ch.nokillswit.sync.STALE_DEVIATIONS_PROBLEM
import ch.nokillswit.teams.CapacityWriteTrail
import ch.nokillswit.teams.TeamGuard
import io.ktor.util.AttributeKey
import kotlinx.coroutines.flow.toList
import org.jetbrains.exposed.v1.core.*
import org.jetbrains.exposed.v1.core.dao.id.UIntIdTable
import org.jetbrains.exposed.v1.r2dbc.*
import org.jetbrains.exposed.v1.r2dbc.transactions.suspendTransaction

val CapacityAcknowledgeServiceKey = AttributeKey<CapacityAcknowledgeService>("CapacityAcknowledgeService")

/** A stored acknowledgement row: the fingerprint it was made on, when, and the acknowledging login's id. */
internal class StoredCapacityAck(val fingerprint: String, val at: Long, val byUserId: UInt)

/**
 * The per-sprint acknowledgement of a capacity deviation (1.9, V26 `flow_capacity_acknowledgements`): the service OWNS the table and
 * READS the binding, its team and, through [CapacityDeviationService], the whole deviation computation. **No plan lock and no
 * revision bump**: an acknowledgement is not plan state (like a binding or a capacity period). The key is (binding, Flow sprint id);
 * a null sprint is the binding's own `TEAM_GONE` row. Rows are HARD: an un-acknowledge deletes, a re-acknowledge rewrites the stamp.
 *
 * **An acknowledgement lives only while its row is listed (1.10).** A row that is no longer listed - the sprint is in line, closed,
 * skipped or gone from Flow's document, the team is back (its `TEAM_GONE` row), the binding is unlinked or its team deleted - loses its
 * acknowledgement, so a difference that returns is OPEN. A STALE acknowledgement (the row is still listed, its figures moved) stays: it
 * reads `current = false`. Three places prune: [pruneConnectionInTransaction], inside the mirror replace of a run (connection-wide),
 * [acknowledge], for the binding it locks, and [pruneInCapacityWrite], the plan-side edit (a manual period or the capacity import)
 * INSIDE its transaction, for the team's binding - the last two judge only a sprint that is STILL IN THE MIRROR but unlisted, and the
 * returned team's own row; "gone from the document" is the run's call, because only it knows whether the document was sprints-truncated.
 * The connection delete removes every row ([Acknowledgements.deleteForConnectionInTransaction]).
 * The capacity write's prune runs in the write's own transaction (1.13.3), after the write's statements and under the binding row lock
 * [lockBindingsBeforeCapacityWrite] took BEFORE the team row (the acknowledge's order): two capacity writes of one team are serialised
 * by it and the second prune sees the first's periods, so an "in line and back" cannot stay acknowledged. A holiday or time-zone edit
 * still prunes nobody (`flow-sync.md` "Acknowledge"). A team ABSENT from Flow's document keeps its sprint rows (nothing can be judged
 * while it is gone) and a sprints-truncated document judges no sprint key (it still clears a returned team's own row, an unlinked
 * binding's rows and a dead team's).
 *
 * The batch [acknowledgeAll] (1.10) is the same protocol over a list of rows: all or nothing, one lock, one stamp, one prune.
 * [unacknowledgeAll] (1.11) is the batch of the withdrawal: the same lock and guard, no recompute, no prune.
 *
 * Both single writes run in ONE short transaction in the Jira acknowledge's order: the binding row `FOR NO KEY UPDATE`
 * ([lockActiveForWrite]; gone = `404`), the binding re-read with its team ACTIVE (a dead team = `404`), the caller's [TeamGuard] run
 * AGAIN against the stored team (the route passes `requireTeamManagerOrAdmin(…, teams::lockedIsActiveManager)`: a request can be held
 * open between its outer guard and this lock, so only this verdict authorizes the write), and then - for [acknowledge] - the binding's
 * rows RECOMPUTED here ([CapacityDeviationService.computeBindingInTransaction]) and the named row compared with the fingerprint the
 * client saw. **Invariant: every write of a binding's acknowledgement rows holds that binding's row lock**, so the UPDATE-then-INSERT
 * below is exact and two multi-row writes (a prune, a batch) can never lock one binding's rows in opposite orders; the unique index
 * `uq_flow_capacity_acks_key` is only the backstop. A capacity PUT is not excluded (statement-by-statement READ COMMITTED reads): a
 * change landing in between makes the compare a `409` (the client reads again) or, at worst, stores the fingerprint of a mixed state -
 * harmless for the STAMP, because a stored fingerprint is re-compared on every read and such an acknowledgement just reads
 * `current = false`. The PRUNE reads the same unlocked inputs, so a plan edit landing mid-computation can make it delete a row that
 * the next read would still list (a re-acknowledge restores it) or keep one it should delete (the next run or acknowledge removes it):
 * a stored decision is lost at worst, never stored wrongly.
 *
 * **Lock order:** the acknowledge is [FlowTeamBindingService.unbind]'s shape - the binding row FIRST, then the guard's team and person
 * rows `FOR SHARE`, then the acknowledgement rows; it takes neither the bind lock nor the connection row. The run's prune is the
 * connection-first path: the connection row (the replace's `FOR NO KEY UPDATE`), then the binding rows `FOR NO KEY UPDATE` in id order,
 * then the acknowledgement rows - the link's, the match's and the connection delete's order (connection, then bindings). Nobody goes
 * binding -> connection, so there is no cycle. A capacity write (1.13.3) is the third binding-first path: the binding row(s)
 * ([lockBindingsBeforeCapacityWrite]), then the team row `FOR NO KEY UPDATE`, then the guard's manager and person rows `FOR SHARE`, then
 * its period writes, then the acknowledgement rows ([pruneInCapacityWrite]). The one global order is connection, binding, team, person,
 * acknowledgement rows; the link takes its OWN team's binding rows before its `FOR SHARE` on the team for the same reason
 * ([FlowTeamBindingService.bind]).
 */
class CapacityAcknowledgeService(
    private val database: R2dbcDatabase,
    private val deviations: CapacityDeviationService,
    private val bindings: FlowTeamBindingService,
) {
    private val pruning = CapacityAcknowledgePruning(database, deviations, bindings)

    object Acknowledgements : UIntIdTable("flow_capacity_acknowledgements") {
        val bindingId = reference("binding_id", FlowTeamBindingService.Bindings)

        /** Flow's sprint id; NULL = the binding's `TEAM_GONE` row (`NULLS NOT DISTINCT` makes it unique too). */
        val sprintId = long("sprint_id").nullable()
        val fingerprint = varchar("fingerprint", length = FINGERPRINT_WIDTH)
        val ackAt = long("ack_at")

        /** The acknowledging login's id (`users.id` is BIGINT; V26 has the FK, no `users` import here: `flow/` names no `users` type). */
        val ackByUserId = long("ack_by_user_id")

        /**
         * The stored acknowledgements of [bindingIds] in ONE statement, keyed (binding, sprint id; null = the team's own row): the view's
         * read, inside its snapshot ([CapacityDeviationService] reads the table without owning it, so it needs no service instance).
         */
        internal suspend fun storedOf(bindingIds: Collection<UInt>): Map<Pair<UInt, Long?>, StoredCapacityAck> {
            if (bindingIds.isEmpty()) return emptyMap()
            return select(bindingId, sprintId, fingerprint, ackAt, ackByUserId).where { bindingId inList bindingIds }.toList().associate {
                (it[bindingId].value to it[sprintId]) to StoredCapacityAck(it[fingerprint], it[ackAt], it[ackByUserId].toUInt())
            }
        }

        /**
         * Removes every acknowledgement of every binding of [connectionId] INSIDE the caller's open transaction and answers how many rows
         * went: the connection delete's step, taken AFTER its soft delete of the bindings (their rows are locked by then).
         */
        suspend fun deleteForConnectionInTransaction(connectionId: UInt): Int {
            val owned = FlowTeamBindingService.Bindings
            return deleteWhere { bindingId inSubQuery owned.select(owned.id).where { owned.connectionId eq connectionId } }
        }
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
        val computed = deviations.computeBindingInTransaction(binding)
        val rows = computed?.deviations.orEmpty()
        val row = rows.firstOrNull { it.detail.sprintId == sprintId }
            ?: throw ConflictException(
                if (sprintId == null) "The team has no deviation of its own" else "The sprint has no deviation to acknowledge",
                STALE_DEVIATIONS_PROBLEM,
            )
        if (row.fingerprint != fingerprint) throw ConflictException("The deviation changed since it was read", STALE_DEVIATIONS_PROBLEM)
        val cleared = pruneUnlistedCapacityAcks(
            binding, rows, computed.mirroredSprintIds(), sprintsJudgeable = computed?.mirror?.sprintsComplete == true,
        )
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
            binding.connectionId, binding.teamId, binding.flowTeamId, row.kind, row.severity, cleared,
        )
    }

    /**
     * The batch of [acknowledge] (1.10): stamps every row named in [items] (each: the sprint, null = the team's own row, and the
     * fingerprint the client read) with ONE time and ONE login, in ONE transaction. The binding row is locked once, the guard run again,
     * the rows recomputed once. **All or nothing**: a named row that is not listed now, or whose fingerprint differs, is `409`
     * [STALE_DEVIATIONS_PROBLEM] and nothing is stored (nor pruned: the transaction rolls back). Only the named rows are written, never
     * an open row the client did not name. The acknowledge's prune applies once, after the checks; the named rows are listed, so it can
     * never remove one of them. The named keys' stored rows are deleted and re-inserted in one multi-row statement (the binding row lock
     * makes that exact; `uq_flow_capacity_acks_key` is the backstop).
     */
    suspend fun acknowledgeAll(
        bindingId: UInt,
        items: List<CapacityAcknowledgeRequest>,
        byUserId: UInt,
        guard: TeamGuard,
    ): CapacityAcknowledgeAllOutcome = suspendTransaction(database) {
        validateCapacityAcknowledgeAll(CapacityAcknowledgeAllRequest(items))
        val binding = lockedBinding(bindingId, guard)
        val computed = deviations.computeBindingInTransaction(binding)
        val rows = computed?.deviations.orEmpty()
        val listed = rows.associateBy { it.detail.sprintId }
        val named = items.map { item ->
            val what = item.sprintId?.let { "Sprint $it" } ?: "The team's own row"
            val row = listed[item.sprintId] ?: throw ConflictException("$what has no deviation to acknowledge", STALE_DEVIATIONS_PROBLEM)
            if (row.fingerprint != item.fingerprint) {
                throw ConflictException("$what changed since it was read", STALE_DEVIATIONS_PROBLEM)
            }
            row
        }
        val cleared = pruneUnlistedCapacityAcks(
            binding, rows, computed.mirroredSprintIds(), sprintsJudgeable = computed?.mirror?.sprintsComplete == true,
        )
        val stamp = nowMillis()
        deleteKeys(bindingId, items.map { it.sprintId })
        Acknowledgements.insertRows(items) { item ->
            this[Acknowledgements.bindingId] = bindingId
            this[Acknowledgements.sprintId] = item.sprintId
            this[Acknowledgements.fingerprint] = item.fingerprint
            this[Acknowledgements.ackAt] = stamp
            this[Acknowledgements.ackByUserId] = byUserId.toLong()
        }
        val by = creatorsOf(listOf(byUserId))[byUserId]?.name
        CapacityAcknowledgeAllOutcome(
            items.zip(named).map { (item, row) ->
                val acknowledgement = CapacityAcknowledgement(bindingId, item.sprintId, item.fingerprint, stamp, by)
                AcknowledgedCapacityRow(acknowledgement, row.kind, row.severity)
            },
            binding.connectionId, binding.teamId, binding.flowTeamId, cleared,
        )
    }

    /**
     * The batch of [unacknowledge] (1.11): deletes the stored acknowledgement of every row named in [sprintIds] (null = the team's own
     * row), current or stale, in ONE transaction under the binding row lock and the guard run again. **All or nothing**: a named row with
     * no stored acknowledgement is `409` [STALE_DEVIATIONS_PROBLEM] (the list changed since the client read it) and nothing is deleted.
     * Nothing is recomputed and nothing pruned: a withdrawal compares no figure.
     */
    suspend fun unacknowledgeAll(bindingId: UInt, sprintIds: List<Long?>, guard: TeamGuard): CapacityUnacknowledgeAllOutcome =
        suspendTransaction(database) {
            validateCapacityUnacknowledgeAll(CapacityUnacknowledgeAllRequest(sprintIds.map(::CapacityUnacknowledgeItem)))
            val binding = lockedBinding(bindingId, guard)
            val stored = Acknowledgements.select(Acknowledgements.sprintId, Acknowledgements.fingerprint)
                .where { Acknowledgements.bindingId eq bindingId }.toList()
                .associate { it[Acknowledgements.sprintId] to it[Acknowledgements.fingerprint] }
            val cleared = sprintIds.map { sprint ->
                val what = sprint?.let { "Sprint $it" } ?: "The team's own row"
                sprint to (stored[sprint] ?: throw ConflictException("$what has no acknowledgement to withdraw", STALE_DEVIATIONS_PROBLEM))
            }
            deleteKeys(bindingId, sprintIds)
            CapacityUnacknowledgeAllOutcome(cleared, binding.connectionId, binding.teamId, binding.flowTeamId)
        }

    /** Deletes the stored rows of [keys] (null = the team's own row) of [bindingId] in one statement; the caller holds the binding lock. */
    private suspend fun deleteKeys(bindingId: UInt, keys: List<Long?>) {
        val sprints = keys.filterNotNull()
        val teamRow = if (null in keys) Acknowledgements.sprintId.isNull() else Op.FALSE
        Acknowledgements.deleteWhere {
            (Acknowledgements.bindingId eq bindingId) and ((Acknowledgements.sprintId inList sprints) or teamRow)
        }
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

    /** The run's connection-wide prune, inside the mirror replace's transaction ([CapacityAcknowledgePruning]). */
    internal suspend fun pruneConnectionInTransaction(connectionId: UInt, sprintsJudgeable: Boolean = true): List<ClearedCapacityAcks> =
        pruning.pruneConnectionInTransaction(connectionId, sprintsJudgeable)

    /** The capacity write's first step, the binding lock before the team row ([CapacityAcknowledgePruning]). */
    suspend fun lockBindingsBeforeCapacityWrite(teamId: UInt): List<UInt> = pruning.lockBindingsBeforeCapacityWrite(teamId)

    /** The capacity write's last step, the prune inside the write's transaction ([CapacityAcknowledgePruning]). */
    suspend fun pruneInCapacityWrite(teamId: UInt, locked: List<UInt>, trail: CapacityWriteTrail) =
        pruning.pruneInCapacityWrite(teamId, locked, trail)

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
    }
}
