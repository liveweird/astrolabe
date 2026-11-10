package ch.nokillswit.flow

import ch.nokillswit.audit.audit
import ch.nokillswit.authz.ConflictException
import ch.nokillswit.authz.NotFoundException
import ch.nokillswit.infra.catchingFailures
import ch.nokillswit.infra.db.lockActiveForWrite
import ch.nokillswit.infra.db.nowMillis
import ch.nokillswit.infra.time.WorkingCalendar
import ch.nokillswit.planning.DeviationSeverity
import ch.nokillswit.planning.creatorsOf
import ch.nokillswit.planning.loadWorkingCalendar
import ch.nokillswit.sync.STALE_DEVIATIONS_PROBLEM
import ch.nokillswit.teams.TeamGuard
import io.ktor.util.AttributeKey
import io.r2dbc.spi.R2dbcException
import kotlinx.coroutines.flow.toList
import org.jetbrains.exposed.v1.core.*
import org.jetbrains.exposed.v1.core.dao.id.EntityID
import org.jetbrains.exposed.v1.core.dao.id.UIntIdTable
import org.jetbrains.exposed.v1.exceptions.ExposedSQLException
import org.jetbrains.exposed.v1.r2dbc.*
import org.jetbrains.exposed.v1.r2dbc.transactions.suspendTransaction
import org.slf4j.LoggerFactory

val CapacityAcknowledgeServiceKey = AttributeKey<CapacityAcknowledgeService>("CapacityAcknowledgeService")

private val log = LoggerFactory.getLogger(CapacityAcknowledgeService::class.java)

/** What a committed acknowledge leaves for the route's audit line (written AFTER the commit): the binding, its Flow team and the row. */
class CapacityAcknowledgeOutcome(
    val acknowledgement: CapacityAcknowledgement,
    val connectionId: UInt,
    val teamId: UInt,
    val flowTeamId: Int,
    val kind: CapacityDeviationKind,
    val severity: DeviationSeverity,
    /** The Flow sprint ids (null = the team's own row) of the binding's stored rows the write pruned because they were no longer listed. */
    val cleared: List<Long?>,
)

/** What a prune removed from ONE binding: the Flow sprint ids of the deleted rows, `null` standing for the team's own `TEAM_GONE` row. */
class ClearedCapacityAcks(val bindingId: UInt, val sprintIds: List<Long?>)

/** What a committed un-acknowledge leaves for the audit line: the binding and the fingerprint that was cleared. */
class CapacityUnacknowledgeOutcome(
    val connectionId: UInt,
    val teamId: UInt,
    val flowTeamId: Int,
    val fingerprint: String,
)

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
 * reads `current = false`. Two places prune: [pruneConnectionInTransaction], inside the mirror replace of a run (connection-wide), and
 * [acknowledge], for the binding it locks - which judges only a sprint that is STILL IN THE MIRROR but unlisted, and the returned
 * team's own row; "gone from the document" is the run's call, because only it knows whether the document was sprints-truncated. The
 * connection delete removes every row ([Acknowledgements.deleteForConnectionInTransaction]).
 * Nothing prunes at a plan-side edit (the capacity import, a manual period): a sprint brought in line AND back to the same figures by
 * edits alone, with no run and no acknowledge in between, still reads acknowledged (`flow-sync.md` "Acknowledge"). A team ABSENT from
 * Flow's document keeps its sprint rows (nothing can be judged while it is gone) and a sprints-truncated document judges no sprint key
 * (it still clears a returned team's own row, an unlinked binding's rows and a dead team's).
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
 * binding -> connection, so there is no cycle.
 */
class CapacityAcknowledgeService(
    private val database: R2dbcDatabase,
    private val deviations: CapacityDeviationService,
    private val bindings: FlowTeamBindingService,
    /** The sprints the mirror holds: the acknowledge prunes only rows whose sprint is still in it (the run judges the rest). */
    private val mirror: FlowMirrorStore,
) {
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
        val rows = deviations.computeBindingInTransaction(binding).orEmpty()
        val row = rows.firstOrNull { it.detail.sprintId == sprintId }
            ?: throw ConflictException(
                if (sprintId == null) "The team has no deviation of its own" else "The sprint has no deviation to acknowledge",
                STALE_DEVIATIONS_PROBLEM,
            )
        if (row.fingerprint != fingerprint) throw ConflictException("The deviation changed since it was read", STALE_DEVIATIONS_PROBLEM)
        val cleared = pruneUnlisted(binding, rows)
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

    /** Clears the acknowledgement of [sprintId]'s row (null = the team's own) of [bindingId], current or stale; `404` if none. */
    suspend fun unacknowledge(bindingId: UInt, sprintId: Long?, guard: TeamGuard): CapacityUnacknowledgeOutcome =
        suspendTransaction(database) {
            val binding = lockedBinding(bindingId, guard)
            val cleared = Acknowledgements.select(Acknowledgements.fingerprint).where { keyOf(bindingId, sprintId) }.toList().singleOrNull()
                ?.get(Acknowledgements.fingerprint) ?: throw NotFoundException("Acknowledgement not found")
            Acknowledgements.deleteWhere { keyOf(bindingId, sprintId) }
            CapacityUnacknowledgeOutcome(binding.connectionId, binding.teamId, binding.flowTeamId, cleared)
        }

    /**
     * The run's prune of one connection, INSIDE the caller's transaction (the mirror replace: the connection row is already locked and the
     * new mirror is visible): deletes the stored rows that are no longer listed and answers what went, per binding. The rule, per binding
     * that HAS stored rows: an unlinked binding or one of a deleted team loses every row; an active binding of an active team loses the
     * team's own (NULL-sprint) row - the team is back - and, when [sprintsJudgeable], every sprint row whose key is not one of its listed
     * rows (the sprint id of a [CapacityDeviation]); a team still ABSENT from the mirror (its one `TEAM_GONE` row listed) and a
     * computation that answers null (nothing to compare) keep everything. A sprints-truncated document is NOT [sprintsJudgeable] (Flow
     * cut it at the sprint cap across all teams, so a sprint missing from it was merely not sent): it judges only what does not depend on
     * sprints - the returned team's own row, an unlinked binding, a dead team. A binding whose computation fails with a NON-database
     * error keeps its rows and logs a WARN naming it (one binding's failure neither deletes nor stalls the mirror); a database error
     * propagates (the transaction is aborted). Lock order: the binding rows `FOR NO KEY UPDATE` in id order, BEFORE any stored row is
     * read or deleted, and only the bindings that have stored rows, so a run on a connection without any takes no binding lock. One
     * `DELETE` at the end.
     */
    internal suspend fun pruneConnectionInTransaction(connectionId: UInt, sprintsJudgeable: Boolean = true): List<ClearedCapacityAcks> {
        val owned = FlowTeamBindingService.Bindings
        val candidates = Acknowledgements.innerJoin(owned).select(Acknowledgements.bindingId)
            .where { owned.connectionId eq connectionId }.toList().map { it[Acknowledgements.bindingId].value }.distinct().sorted()
        if (candidates.isEmpty()) return emptyList()
        val locked = candidates.filter { owned.lockActiveForWrite(it) }.toSet()
        val stored = Acknowledgements.select(Acknowledgements.id, Acknowledgements.bindingId, Acknowledgements.sprintId)
            .where { Acknowledgements.bindingId inList candidates }.toList().groupBy { it[Acknowledgements.bindingId].value }
        val live = bindings.activeBindingsWithTeams(listOf(connectionId), null).associate { it.binding.id to it.binding }
        val calendar = loadWorkingCalendar()
        val doomed = ArrayList<EntityID<UInt>>()
        val cleared = ArrayList<ClearedCapacityAcks>()
        for (bindingId in candidates) {
            // Not locked = unlinked (soft-deleted); not live = its team was deleted: neither lists anything, so all rows go (keep = null).
            val binding = live[bindingId]?.takeIf { bindingId in locked }
            val keep = if (binding == null) null else (keptKeysOrNull(binding, calendar) ?: continue)
            val gone = stored[bindingId].orEmpty().filter { row ->
                val sprint = row[Acknowledgements.sprintId]
                keep == null || sprint == null || (sprintsJudgeable && sprint !in keep)
            }
            if (gone.isEmpty()) continue
            doomed += gone.map { it[Acknowledgements.id] }
            cleared += ClearedCapacityAcks(bindingId, gone.map { it[Acknowledgements.sprintId] }.sortedWith(compareBy(nullsFirst()) { it }))
        }
        if (doomed.isNotEmpty()) Acknowledgements.deleteWhere { Acknowledgements.id inList doomed }
        return cleared
    }

    /**
     * [binding]'s listed keys; null when nothing may be pruned: nothing to compare, the team is gone, or a non-database failure (WARN).
     * A failure with an R2dbcException/ExposedSQLException in its cause chain is RETHROWN: it aborted the Postgres transaction, and
     * swallowing it would let the replace commit as a silent rollback while the run reports WRITTEN - never narrow that check.
     */
    private suspend fun keptKeysOrNull(binding: FlowTeamBindingRow, calendar: WorkingCalendar): Set<Long?>? =
        catchingFailures({ keptKeys(deviations.computeBindingInTransaction(binding, calendar)) }) { failure ->
            if (generateSequence<Throwable>(failure) { it.cause }.any { it is R2dbcException || it is ExposedSQLException }) throw failure
            log.warn("Capacity acknowledgements of binding {} kept: not computable ({})", binding.id, failure.javaClass.simpleName)
            null
        }

    /**
     * Deletes binding [binding]'s stored rows that are no longer listed (the caller holds its row lock) and answers their sprint ids: the
     * team's own row (the team is present, or [listed] would be its `TEAM_GONE` row) and the sprint rows whose sprint is STILL IN THE
     * MIRROR but not listed (in line, closed, skipped). A sprint missing from the mirror is left to the run, which knows whether the
     * document was sprints-truncated; nothing at all when the team is gone (nothing can be judged).
     */
    private suspend fun pruneUnlisted(binding: FlowTeamBindingRow, listed: List<CapacityDeviation>): List<Long?> {
        val keep = keptKeys(listed) ?: return emptyList()
        val inMirror = mirror.teamSprintsOf(binding.connectionId, binding.flowTeamId)?.sprints.orEmpty().mapTo(HashSet()) { it.sprintId }
        val gone = Acknowledgements.select(Acknowledgements.id, Acknowledgements.sprintId)
            .where { Acknowledgements.bindingId eq binding.id }.toList().filter {
                val sprint = it[Acknowledgements.sprintId]
                sprint == null || (sprint in inMirror && sprint !in keep)
            }
        if (gone.isEmpty()) return emptyList()
        val ids = gone.map { it[Acknowledgements.id] }
        Acknowledgements.deleteWhere { Acknowledgements.id inList ids }
        return gone.map { it[Acknowledgements.sprintId] }.sortedWith(compareBy(nullsFirst()) { it })
    }

    /** The keys of the rows [listed] now (null = the team's own row), or null when nothing may be pruned: nothing to compare, or gone. */
    private fun keptKeys(listed: List<CapacityDeviation>?): Set<Long?>? =
        listed?.takeIf { rows -> rows.none { it.kind == CapacityDeviationKind.TEAM_GONE } }?.mapTo(HashSet()) { it.detail.sprintId }

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

/**
 * `flow.capacity_acknowledgements_cleared` (after the commit): the stored rows of binding [bindingId] that lost their acknowledgement
 * because they are no longer listed. [via] = `run` (the mirror replace: [byUserId] is the login that asked for the run, null for a
 * scheduled one, and [runId] the run) or `acknowledge` (the caller). `sprintIds` is ascending, `none` for the team's own row.
 */
internal fun auditCapacityAcksCleared(
    bindingId: UInt,
    sprintIds: List<Long?>,
    connectionId: UInt,
    byUserId: UInt?,
    via: String,
    runId: UInt? = null,
) {
    val fields = mutableListOf<Pair<String, Any?>>(
        "byUserId" to byUserId?.toLong(),
        "bindingId" to bindingId.toLong(),
        "connectionId" to connectionId.toLong(),
        "count" to sprintIds.size,
        "sprintIds" to sprintIds.joinToString(",") { it?.toString() ?: "none" },
        "via" to via,
    )
    if (runId != null) fields += "runId" to runId.toLong()
    audit("flow.capacity_acknowledgements_cleared", *fields.toTypedArray())
}
