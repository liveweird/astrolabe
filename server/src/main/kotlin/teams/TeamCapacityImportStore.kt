package ch.nokillswit.teams

import ch.nokillswit.authz.NotFoundException
import ch.nokillswit.infra.db.active
import ch.nokillswit.infra.db.insertRows
import ch.nokillswit.infra.db.lockActiveForWrite
import ch.nokillswit.infra.db.nowMillis
import ch.nokillswit.planning.validateManDays
import ch.nokillswit.teams.TeamCapacityService.CapacityPeriods
import io.ktor.server.plugins.BadRequestException
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.flow.toList
import org.jetbrains.exposed.v1.core.ResultRow
import org.jetbrains.exposed.v1.core.and
import org.jetbrains.exposed.v1.core.eq
import org.jetbrains.exposed.v1.core.inList
import org.jetbrains.exposed.v1.r2dbc.R2dbcDatabase
import org.jetbrains.exposed.v1.r2dbc.select
import org.jetbrains.exposed.v1.r2dbc.transactions.suspendTransaction
import org.jetbrains.exposed.v1.r2dbc.update
import java.math.BigDecimal

/**
 * The capacity import's side of [TeamCapacityService] (`flow/` reaches it only through the service's delegates): the reads of a team's
 * ACTIVE periods with their provenance, the batch write [applyImport] with its three writers, and the invariant check that keeps a
 * MANUAL period out of every statement. Same locks and order as the service's own writes (the [listeners], then the team row, then the
 * guard); every function opens its own transaction on [database] and nests into the caller's when there is one.
 */
internal class TeamCapacityImportStore(
    private val database: R2dbcDatabase,
    private val listeners: CapacityWriteListeners,
) {
    /** The ACTIVE periods of [teamId] by `effectiveFrom` with their provenance; read-only. */
    suspend fun rowsOf(teamId: UInt): List<CapacityPeriodRow> = suspendTransaction(database) {
        activeCapacityPeriods(teamId)
            .map { it.toImportRow() }
            .toList()
    }

    /** [rowsOf] for many teams in ONE statement: the same predicate and order, grouped by team; a team without a period has no entry. */
    suspend fun rowsOfTeams(teamIds: Collection<UInt>): Map<UInt, List<CapacityPeriodRow>> {
        if (teamIds.isEmpty()) return emptyMap()
        return suspendTransaction(database) {
            activeCapacityPeriods(teamIds)
                .map { it[CapacityPeriods.teamId].value to it.toImportRow() }
                .toList()
                .groupBy({ it.first }, { it.second })
        }
    }

    private fun ResultRow.toImportRow() = CapacityPeriodRow(
        id = this[CapacityPeriods.id].value,
        effectiveFrom = this[CapacityPeriods.effectiveFrom],
        mdPerWeek = this[CapacityPeriods.mdPerWeek],
        wipLimit = this[CapacityPeriods.wipLimit],
        source = CapacitySource.valueOf(this[CapacityPeriods.capacitySource]),
        flowSprintId = this[CapacityPeriods.flowSprintId],
        flowSprintName = this[CapacityPeriods.flowSprintName],
    )

    /** The batch write behind [TeamCapacityService.applyImport], whose KDoc states the contract. */
    suspend fun <S> applyImport(
        teamId: UInt,
        guard: TeamGuard,
        trail: CapacityWriteTrail,
        decide: suspend (periods: List<CapacityPeriodRow>) -> Pair<CapacityImportWrites, S>,
    ): CapacityImportApplied<S> = suspendTransaction(database) {
        val locks = listeners.lockBeforeTeam(teamId)
        if (!TeamService.Teams.lockActiveForWrite(teamId)) throw NotFoundException(TEAM_NOT_FOUND)
        guard(teamId)
        val locked = rowsOf(teamId)
        val (writes, extra) = decide(locked)
        requireOnlyFlowPeriodsChanged(locked, writes)
        val stamp = nowMillis()
        deleteImported(teamId, writes.deletes, stamp)
        val updated = writes.updates.map { updateImported(teamId, locked.single { row -> row.id == it.periodId }, it, stamp) }
        val created = createImported(teamId, writes.creates, stamp)
        if (created.isNotEmpty() || updated.isNotEmpty() || writes.deletes.isNotEmpty()) listeners.settle(teamId, locks, trail)
        CapacityImportApplied(created, updated, writes.deletes, extra)
    }

    private suspend fun deleteImported(teamId: UInt, ids: List<UInt>, stamp: Long) {
        if (ids.isEmpty()) return
        val count = CapacityPeriods.update({ importable(teamId) and (CapacityPeriods.id inList ids) }) {
            it[markedAsDeleted] = true
            it[updatedAt] = stamp
        }
        check(count == ids.size) { "capacity import: $count of ${ids.size} periods were removable" }
    }

    private suspend fun updateImported(
        teamId: UInt,
        before: CapacityPeriodRow,
        update: CapacityImportUpdate,
        stamp: Long,
    ): CapacityImportUpdated {
        val count = CapacityPeriods.update({ importable(teamId) and (CapacityPeriods.id eq update.periodId) }) {
            it[mdPerWeek] = update.mdPerWeek
            it[flowSprintId] = update.flowSprintId
            it[flowSprintName] = update.flowSprintName
            it[updatedAt] = stamp
        }
        check(count == 1) { "capacity import: period ${update.periodId} was not updatable" }
        val values = CapacityPeriodValues(before.effectiveFrom, before.mdPerWeek, before.wipLimit)
        return CapacityImportUpdated(
            update.periodId, values, before.flowSprintId, before.flowSprintName,
            update.mdPerWeek, update.flowSprintId, update.flowSprintName,
        )
    }

    private suspend fun createImported(teamId: UInt, creates: List<CapacityImportCreate>, stamp: Long): List<CapacityImportCreated> {
        if (creates.isEmpty()) return emptyList()
        CapacityPeriods.insertRows(creates) { c ->
            this[CapacityPeriods.teamId] = teamId
            this[CapacityPeriods.effectiveFrom] = c.effectiveFrom
            this[CapacityPeriods.mdPerWeek] = c.mdPerWeek
            this[CapacityPeriods.wipLimit] = null
            this[CapacityPeriods.capacitySource] = CapacitySource.FLOW.name
            this[CapacityPeriods.flowSprintId] = c.flowSprintId
            this[CapacityPeriods.flowSprintName] = c.flowSprintName
            this[CapacityPeriods.createdAt] = stamp
            this[CapacityPeriods.updatedAt] = stamp
        }
        // The multi-row insert returns no ids: the new rows are found by their (team, date) key, which is unique among ACTIVE periods.
        val ids = CapacityPeriods.select(CapacityPeriods.id, CapacityPeriods.effectiveFrom)
            .where {
                (CapacityPeriods.teamId eq teamId) and CapacityPeriods.active() and
                    (CapacityPeriods.effectiveFrom inList creates.map { it.effectiveFrom })
            }
            .toList().associate { it[CapacityPeriods.effectiveFrom] to it[CapacityPeriods.id].value }
        return creates.map { CapacityImportCreated(checkNotNull(ids[it.effectiveFrom]), it.effectiveFrom, it.mdPerWeek, it.flowSprintId) }
    }

    /** The only rows the import may change: this team's ACTIVE periods the import itself wrote. */
    private fun importable(teamId: UInt) =
        (CapacityPeriods.teamId eq teamId) and CapacityPeriods.active() and (CapacityPeriods.capacitySource eq CapacitySource.FLOW.name)
}

/**
 * The import's invariants over the rows read under the team lock, checked before anything is written (a violation is a bug in the caller,
 * `IllegalStateException`, and aborts the transaction): only FLOW periods are updated or removed, no period twice, each new date is free
 * among the periods that remain (a removed period's date is free again) and distinct, and every figure is a valid man-day figure.
 */
private fun requireOnlyFlowPeriodsChanged(locked: List<CapacityPeriodRow>, writes: CapacityImportWrites) {
    val flow = locked.filter { it.source == CapacitySource.FLOW }.mapTo(HashSet()) { it.id }
    val touched = writes.updates.map { it.periodId } + writes.deletes
    check(touched.all { it in flow }) { "capacity import: only FLOW periods may be updated or removed" }
    check(touched.toSet().size == touched.size) { "capacity import: a period is written once" }
    val taken = locked.filter { it.id !in writes.deletes }.mapTo(HashSet()) { it.effectiveFrom }
    check(writes.creates.all { taken.add(it.effectiveFrom) }) { "capacity import: a new period needs a free date" }
    val figures = writes.creates.map { it.mdPerWeek } + writes.updates.map { it.mdPerWeek }
    check(figures.all { manDaysValid(it) }) { "capacity import: a figure is outside the man-day bounds" }
}

/** Whether [figure] passes the capacity period's man-day rule ([validateManDays]), as a boolean for an invariant check. */
private fun manDaysValid(figure: BigDecimal): Boolean = try {
    validateManDays(figure.toDouble(), "mdPerWeek")
    true
} catch (_: BadRequestException) {
    false
}
