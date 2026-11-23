package ch.nokillswit.flow

import ch.nokillswit.flow.CapacityAcknowledgeService.Acknowledgements
import ch.nokillswit.infra.catchingFailures
import ch.nokillswit.infra.db.active
import ch.nokillswit.infra.db.lockActiveForWrite
import ch.nokillswit.infra.time.WorkingCalendar
import ch.nokillswit.planning.loadWorkingCalendar
import ch.nokillswit.teams.CapacityWriteTrail
import io.r2dbc.spi.R2dbcException
import kotlinx.coroutines.flow.toList
import org.jetbrains.exposed.v1.core.*
import org.jetbrains.exposed.v1.core.dao.id.EntityID
import org.jetbrains.exposed.v1.core.vendors.ForUpdateOption
import org.jetbrains.exposed.v1.exceptions.ExposedSQLException
import org.jetbrains.exposed.v1.r2dbc.*
import org.jetbrains.exposed.v1.r2dbc.transactions.suspendTransaction
import org.slf4j.LoggerFactory

// Logs under the service's own logger name: the prune moved out of `CapacityAcknowledgeService`, its log line did not.
private val log = LoggerFactory.getLogger(CapacityAcknowledgeService::class.java)

/**
 * Deletes [binding]'s stored rows that are no longer [listed] while the caller holds its row lock. A present team's own
 * `TEAM_GONE` row is always judgeable; sprint rows are judged only when [sprintsJudgeable], and then only for ids in [inMirror].
 * A sprint missing from the mirror remains the run's decision because only it knows whether the document was truncated.
 */
internal suspend fun pruneUnlistedCapacityAcks(
    binding: FlowTeamBindingRow,
    listed: List<CapacityDeviation>,
    inMirror: Set<Long>,
    sprintsJudgeable: Boolean,
): List<Long?> {
    val keep = listedKeys(listed) ?: return emptyList()
    val table = Acknowledgements
    val gone = table.select(table.id, table.sprintId).where { table.bindingId eq binding.id }.toList().filter {
        val sprint = it[table.sprintId]
        sprint == null || (sprintsJudgeable && sprint in inMirror && sprint !in keep)
    }
    if (gone.isEmpty()) return emptyList()
    table.deleteWhere { table.id inList gone.map { it[table.id] } }
    return gone.map { it[table.sprintId] }.sortedWith(compareBy(nullsFirst()) { it })
}

/** The keys of the rows [listed] now (null = the team's own row), or null when nothing may be pruned: the Flow team is gone. */
internal fun listedKeys(listed: List<CapacityDeviation>): Set<Long?>? =
    listed.takeIf { rows -> rows.none { it.kind == CapacityDeviationKind.TEAM_GONE } }?.mapTo(HashSet()) { it.detail.sprintId }

internal fun BindingCapacityFacts?.mirroredSprintIds(): Set<Long> =
    this?.mirror?.sprints.orEmpty().mapTo(HashSet()) { it.sprintId }

/**
 * The prune seam of [CapacityAcknowledgeService] (1.9 to 1.13.3), carved out of it unchanged: the run's connection-wide prune, the capacity
 * write's lock-before-team step and its prune. The three are the service's `internal`/public surface for `FlowObserver` and
 * `configureFlow`'s capacity listener; the service delegates to them. Same tables, same locks, same transactions: the lock-order
 * paragraph of [CapacityAcknowledgeService] and `persistence.md` "Flow capacity acknowledgements" govern.
 */
internal class CapacityAcknowledgePruning(
    private val database: R2dbcDatabase,
    private val deviations: CapacityDeviationService,
    private val bindings: FlowTeamBindingService,
) {
    /**
     * The run's prune of one connection, INSIDE the caller's transaction (the mirror replace: the connection row is already locked and the
     * new mirror is visible): deletes the stored rows that are no longer listed and answers what went, per binding. The rule, per binding
     * that HAS stored rows: an unlinked binding or one of a deleted team loses every row; an active binding of an active team loses the
     * team's own (NULL-sprint) row - the team is back - and, when [sprintsJudgeable] AND the team's stored snapshot is complete, every
     * sprint row whose key is not one of its listed rows (the sprint id of a [CapacityDeviation]); a team still ABSENT from the mirror
     * (its one `TEAM_GONE` row listed) and a
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
            val computed = if (binding == null) null else (listedOrNull(binding, calendar) ?: continue)
            val keep = if (binding == null) null else listedKeys(checkNotNull(computed).deviations) ?: continue
            // Both facts are required. The run knows whether the whole document was truncated; the stored team flag also protects a
            // retained team and a V31 upgrade whose own sprint coverage is still unknown.
            val teamSprintsComplete = computed?.mirror?.sprintsComplete == true
            val gone = stored[bindingId].orEmpty().filter { row ->
                val sprint = row[Acknowledgements.sprintId]
                keep == null || sprint == null || (sprintsJudgeable && teamSprintsComplete && sprint !in keep)
            }
            if (gone.isEmpty()) continue
            doomed += gone.map { it[Acknowledgements.id] }
            cleared += ClearedCapacityAcks(bindingId, gone.map { it[Acknowledgements.sprintId] }.sortedWith(compareBy(nullsFirst()) { it }))
        }
        if (doomed.isNotEmpty()) Acknowledgements.deleteWhere { Acknowledgements.id inList doomed }
        return cleared
    }

    /**
     * The capacity write's FIRST step (1.13.3), INSIDE its transaction and BEFORE the team row is locked: the team's ACTIVE binding
     * row(s) `FOR NO KEY UPDATE` (id order; none = a team without a Flow link, nothing is locked). Taken whether or not the binding
     * has stored rows yet, because an acknowledge of that binding in flight could be about to store one: the lock queues the write behind
     * it, and queues a later acknowledge behind the write, which it then recomputes against. This is the acknowledge's order (binding
     * row, then the team row), so a capacity write and an acknowledge, an unlink or the run's prune can never wait on each other in a
     * circle. Writes nothing. Answers the ids it locked, which [pruneInCapacityWrite] is limited to.
     */
    suspend fun lockBindingsBeforeCapacityWrite(teamId: UInt): List<UInt> = suspendTransaction(database) {
        val owned = FlowTeamBindingService.Bindings
        owned.select(owned.id).where { (owned.teamId eq teamId) and owned.active() }.orderBy(owned.id to SortOrder.ASC)
            .forUpdate(ForUpdateOption.PostgreSQL.ForNoKeyUpdate).toList().map { it[owned.id].value }
    }

    /**
     * The capacity write's LAST step (1.13.3), INSIDE its transaction after the write of [teamId]'s periods (visible to this transaction
     * only): the binding row(s) [lockBindingsBeforeCapacityWrite] locked and the team row are held, so two capacity writes of one team,
     * or one and an acknowledge, are serialised and the second sees the first's committed periods - an "in line and back" ends the
     * acknowledgement at the first write. One read for the team's ACTIVE binding that HAS stored rows (none: nothing is computed), then
     * [pruneUnlistedCapacityAcks]: for a complete snapshot, only a sprint still in the mirror but unlisted, and the team's own row of a
     * present team;
     * for an incomplete snapshot, only that own row, because no sprint result is judgeable. "Gone from the document" stays the run's
     * call. The deletes commit WITH the write and roll back with it. A NON-database failure of the computation
     * keeps the rows (WARN, [listedOrNull]); a database error aborts the write. The audit line goes to [trail], after the commit.
     * **Only the bindings [locked] by that first step are pruned, and none is locked here**: a binding linked (or holding rows) since was
     * never locked by this write, and deleting its rows would break "every write of a binding's acknowledgement rows holds its row lock".
     */
    suspend fun pruneInCapacityWrite(teamId: UInt, locked: List<UInt>, trail: CapacityWriteTrail) {
        if (locked.isEmpty()) return
        val outcome = suspendTransaction(database) {
            val owned = FlowTeamBindingService.Bindings
            val bound = Acknowledgements.innerJoin(owned).select(Acknowledgements.bindingId)
                .where { (owned.teamId eq teamId) and owned.active() and (owned.id inList locked) }.limit(1).toList().singleOrNull()
                ?.get(Acknowledgements.bindingId)?.value
            val binding = bound?.let { bindings.bindingOf(it) }
            val computed = binding?.let { listedOrNull(it) }
            val cleared = when {
                binding == null -> emptyList()
                computed?.mirror?.sprintsComplete == false ->
                    pruneUnlistedCapacityAcks(binding, emptyList(), computed.mirroredSprintIds(), sprintsJudgeable = false)
                computed == null -> emptyList()
                else -> pruneUnlistedCapacityAcks(binding, computed.deviations, computed.mirroredSprintIds(), sprintsJudgeable = true)
            }
            if (binding == null || cleared.isEmpty()) null else CapacityWritePruneOutcome(binding.id, binding.connectionId, cleared)
        } ?: return
        trail.afterCommit { byUserId ->
            auditCapacityAcksCleared(outcome.bindingId, outcome.sprintIds, outcome.connectionId, byUserId, via = "capacity")
        }
    }

    /**
     * [binding]'s deviation rows and the mirror they came from, or null: nothing to compare, or a non-database failure (WARN naming the
     * binding, the rows are kept).
     * A failure with an R2dbcException/ExposedSQLException in its cause chain is RETHROWN: it aborted the Postgres transaction, and
     * swallowing it would let the replace commit as a silent rollback while the run reports WRITTEN - never narrow that check.
     */
    private suspend fun listedOrNull(binding: FlowTeamBindingRow, calendar: WorkingCalendar? = null): BindingCapacityFacts? =
        catchingFailures({ deviations.computeBindingInTransaction(binding, calendar) }) { failure ->
            if (generateSequence<Throwable>(failure) { it.cause }.any { it is R2dbcException || it is ExposedSQLException }) throw failure
            log.warn("Capacity acknowledgements of binding {} kept: not computable ({})", binding.id, failure.javaClass.simpleName)
            null
        }
}
