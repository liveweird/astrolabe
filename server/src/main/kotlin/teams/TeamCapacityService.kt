package ch.nokillswit.teams

import ch.nokillswit.authz.NotFoundException
import ch.nokillswit.infra.db.SoftDeletable
import ch.nokillswit.infra.db.active
import ch.nokillswit.infra.db.existsActive
import ch.nokillswit.infra.db.insertRows
import ch.nokillswit.infra.db.localDate
import ch.nokillswit.infra.db.lockActiveForWrite
import ch.nokillswit.infra.db.nowMillis
import ch.nokillswit.planning.validateManDays
import io.ktor.server.plugins.BadRequestException
import io.ktor.util.AttributeKey
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.flow.toList
import org.jetbrains.exposed.v1.core.ResultRow
import org.jetbrains.exposed.v1.core.SortOrder
import org.jetbrains.exposed.v1.core.and
import org.jetbrains.exposed.v1.core.dao.id.UIntIdTable
import org.jetbrains.exposed.v1.core.eq
import org.jetbrains.exposed.v1.core.inList
import org.jetbrains.exposed.v1.r2dbc.R2dbcDatabase
import org.jetbrains.exposed.v1.r2dbc.insert
import org.jetbrains.exposed.v1.r2dbc.select
import org.jetbrains.exposed.v1.r2dbc.selectAll
import org.jetbrains.exposed.v1.r2dbc.transactions.suspendTransaction
import org.jetbrains.exposed.v1.r2dbc.update
import java.math.BigDecimal

val TeamCapacityServiceKey = AttributeKey<TeamCapacityService>("TeamCapacityService")

private const val TEAM_NOT_FOUND = "Team not found"
private const val PERIOD_NOT_FOUND = "Capacity period not found"

/**
 * The guard a capacity write re-runs INSIDE its transaction, after the team row is locked — the route hands in
 * `requireTeamManagerOrAdmin(caller, teamId, TeamService::lockedIsActiveManager)`, so only this inner verdict authorizes the write.
 */
typealias TeamGuard = suspend (teamId: UInt) -> Unit

/**
 * Team capacity periods (V16). Team data, not plan state: every write is ONE transaction of its own that first locks the team row
 * (`FOR NO KEY UPDATE`, so a team delete racing it either commits first — 404 — or waits and then cascades the new period too), then
 * re-runs the manager guard against the locked state, then writes. No plan lock and no plan-revision bump. A period start date is
 * unique among a team's ACTIVE periods (`uq_team_capacity_periods_team_from_active`, 409).
 */
class TeamCapacityService(private val database: R2dbcDatabase) {
    object CapacityPeriods : UIntIdTable("team_capacity_periods"), SoftDeletable {
        val teamId = reference("team_id", TeamService.Teams)

        /** Any calendar day (`DATE`); the period holds from here until the team's next ACTIVE period. */
        val effectiveFrom = localDate("effective_from")

        /** Man-days per week, `NUMERIC(8,2)`: the stored value is exactly the validated one. */
        val mdPerWeek = decimal("md_per_week", 8, 2)

        /** Null = no WIP limit while the period is in force; otherwise `1..99` (`ck_team_capacity_periods_wip`). */
        val wipLimit = integer("wip_limit").nullable()

        /**
         * V24: `MANUAL` or `FLOW` ([CapacitySource]); a PUT always writes `MANUAL`, the capacity import writes `FLOW`
         * (`ck_team_capacity_periods_source`). Named `capacitySource`: Exposed's `Table.source` is taken.
         */
        val capacitySource = varchar("source", length = 10).default(CapacitySource.MANUAL.name)

        /** V24: the Flow sprint a `FLOW` period was imported for (its id and name); both null on a manual period. */
        val flowSprintId = long("flow_sprint_id").nullable()
        val flowSprintName = varchar("flow_sprint_name", length = 255).nullable()
        val createdAt = long("created_at")
        val updatedAt = long("updated_at")
        override val markedAsDeleted = bool("marked_as_deleted").default(false)
    }

    /** The periods of an ACTIVE team in `effectiveFrom` order, or null when the team is missing or deleted. */
    suspend fun list(teamId: UInt): CapacityPeriodList? = suspendTransaction(database) {
        if (!TeamService.Teams.existsActive(teamId)) return@suspendTransaction null
        CapacityPeriodList(periodsOf(teamId))
    }

    /** The period, or null when it or its team is deleted. */
    suspend fun read(id: UInt): CapacityPeriodResponse? = suspendTransaction(database) {
        val teams = TeamService.Teams
        CapacityPeriods.innerJoin(teams)
            .selectAll()
            .where { (CapacityPeriods.id eq id) and CapacityPeriods.active() and teams.active() }
            .toList()
            .singleOrNull()
            ?.toResponse()
    }

    /** The team an ACTIVE period of an ACTIVE team belongs to — the routes' read-before-guard lookup; null = 404. */
    suspend fun teamIdOf(id: UInt): UInt? = suspendTransaction(database) {
        val teams = TeamService.Teams
        CapacityPeriods.innerJoin(teams)
            .select(CapacityPeriods.teamId)
            .where { (CapacityPeriods.id eq id) and CapacityPeriods.active() and teams.active() }
            .toList()
            .singleOrNull()
            ?.get(CapacityPeriods.teamId)?.value
    }

    /**
     * Adds a period to [teamId]: the team is locked (gone = 404), [guard] re-run, then the insert; a start date another ACTIVE period of
     * the team already holds is the partial index's 409. 
     * [values] are re-validated here ([requireValidCapacity]: a direct caller gets a 400).
     */
    suspend fun create(teamId: UInt, values: CapacityPeriodValues, guard: TeamGuard): UInt = suspendTransaction(database) {
        requireValidCapacity(values)
        if (!TeamService.Teams.lockActiveForWrite(teamId)) throw NotFoundException(TEAM_NOT_FOUND)
        guard(teamId)
        val stamp = nowMillis()
        CapacityPeriods.insert {
            it[this.teamId] = teamId
            it[effectiveFrom] = values.effectiveFrom
            it[mdPerWeek] = values.mdPerWeek
            it[wipLimit] = values.wipLimit
            it[capacitySource] = CapacitySource.MANUAL.name
            it[createdAt] = stamp
            it[updatedAt] = stamp
        }[CapacityPeriods.id].value
    }

    /**
     * Full replace of a period (an absent limit CLEARS it): the team is locked, the period re-read under the lock (gone = 404), [guard]
     * re-run, then the write. A same-values PUT writes nothing. Moving onto another ACTIVE period's date is the partial index's 409.
     */
    suspend fun update(id: UInt, values: CapacityPeriodValues, guard: TeamGuard): CapacityUpdateOutcome = suspendTransaction(database) {
        requireValidCapacity(values)
        val locked = lockedPeriod(id, guard)
        val outcome = CapacityUpdateOutcome(locked.teamId, locked.values, values, locked.source)
        if (outcome.changed) {
            CapacityPeriods.update({ (CapacityPeriods.id eq id) and CapacityPeriods.active() }) {
                it[effectiveFrom] = values.effectiveFrom
                it[mdPerWeek] = values.mdPerWeek
                it[wipLimit] = values.wipLimit
                // A person's save takes the period over: it is no longer the import's to update or remove.
                it[capacitySource] = CapacitySource.MANUAL.name
                it[flowSprintId] = null
                it[flowSprintName] = null
                it[updatedAt] = nowMillis()
            }
        }
        outcome
    }

    /** Soft-deletes a period (its date is free again): the team locked, the period re-read (gone = 404), [guard] re-run. */
    suspend fun delete(id: UInt, guard: TeamGuard) {
        suspendTransaction(database) {
            lockedPeriod(id, guard)
            CapacityPeriods.update({ (CapacityPeriods.id eq id) and CapacityPeriods.active() }) {
                it[markedAsDeleted] = true
                it[updatedAt] = nowMillis()
            }
        }
    }

    /**
     * The ACTIVE periods of [teamId] by `effectiveFrom` (the view's and the kernel's input; one team has a handful). Nests into the
     * caller's transaction when there is one.
     */
    internal suspend fun periodsOf(teamId: UInt): List<CapacityPeriodResponse> = suspendTransaction(database) {
        CapacityPeriods.selectAll()
            .where { (CapacityPeriods.teamId eq teamId) and CapacityPeriods.active() }
            .orderBy(CapacityPeriods.effectiveFrom to SortOrder.ASC, CapacityPeriods.id to SortOrder.ASC)
            .map { it.toResponse() }
            .toList()
    }

    /**
     * The ACTIVE periods of [teamId] by `effectiveFrom` with their provenance ([CapacityPeriodRow]) - the capacity import's input
     * (`flow/`), read-only and nesting into the caller's transaction like [periodsOf].
     */
    suspend fun importRowsOf(teamId: UInt): List<CapacityPeriodRow> = suspendTransaction(database) {
        CapacityPeriods.selectAll()
            .where { (CapacityPeriods.teamId eq teamId) and CapacityPeriods.active() }
            .orderBy(CapacityPeriods.effectiveFrom to SortOrder.ASC, CapacityPeriods.id to SortOrder.ASC)
            .map { it.toImportRow() }
            .toList()
    }

    /**
     * [importRowsOf] for many teams in ONE statement (the capacity deviation view's batch read, `flow/`): the same predicate and order,
     * grouped by team; a team without a period has no entry. Read-only, nesting into the caller's transaction like [importRowsOf].
     */
    suspend fun importRowsOfTeams(teamIds: Collection<UInt>): Map<UInt, List<CapacityPeriodRow>> {
        if (teamIds.isEmpty()) return emptyMap()
        return suspendTransaction(database) {
            CapacityPeriods.selectAll()
                .where { (CapacityPeriods.teamId inList teamIds) and CapacityPeriods.active() }
                .orderBy(CapacityPeriods.effectiveFrom to SortOrder.ASC, CapacityPeriods.id to SortOrder.ASC)
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

    /**
     * The capacity import's batch write (`flow/CapacityImportService.apply`): ONE transaction that locks the team row (gone = 404), re-runs
     * [guard] against the locked state (403), reads the team's ACTIVE periods UNDER that lock and hands them to [decide], which returns the
     * writes (plus whatever [S] the caller wants back). [decide] runs inside the transaction, so what it reads (the Flow mirror) and the
     * periods it is shown are one consistent view for the writes; it throws (404, 403...) to abandon the batch before anything is written.
     * **A MANUAL period is never written, whatever [decide] returns**: every update and delete is checked against the locked rows (FLOW,
     * ACTIVE, this team) and again in its own `WHERE`, and a violation aborts the whole transaction (an invariant bug, a 500, nothing
     * written). Order: deletes, then updates, then the creates (`insertRows`, one multi-row statement per chunk), so a freed date can be
     * taken again under `uq_team_capacity_periods_team_from_active`. Updates set the figure and the sprint and KEEP the WIP limit.
     */
    suspend fun <S> applyImport(
        teamId: UInt,
        guard: TeamGuard,
        decide: suspend (periods: List<CapacityPeriodRow>) -> Pair<CapacityImportWrites, S>,
    ): CapacityImportApplied<S> = suspendTransaction(database) {
        if (!TeamService.Teams.lockActiveForWrite(teamId)) throw NotFoundException(TEAM_NOT_FOUND)
        guard(teamId)
        val locked = importRowsOf(teamId)
        val (writes, extra) = decide(locked)
        requireOnlyFlowPeriodsChanged(locked, writes)
        val stamp = nowMillis()
        deleteImported(teamId, writes.deletes, stamp)
        val updated = writes.updates.map { updateImported(teamId, locked.single { row -> row.id == it.periodId }, it, stamp) }
        val created = createImported(teamId, writes.creates, stamp)
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

    /** A period re-read under its team's row lock: the team it belongs to, its STORED values and its source. */
    private class LockedPeriod(val teamId: UInt, val values: CapacityPeriodValues, val source: CapacitySource)

    /**
     * The shared head of [update] and [delete]: the period's team is read, LOCKED (gone = 404), the period re-read under that lock
     * (gone = 404) and [guard] re-run against the locked state (403).
     */
    private suspend fun lockedPeriod(id: UInt, guard: TeamGuard): LockedPeriod {
        val teamId = CapacityPeriods.select(CapacityPeriods.teamId)
            .where { (CapacityPeriods.id eq id) and CapacityPeriods.active() }
            .toList().singleOrNull()?.get(CapacityPeriods.teamId)?.value
            ?: throw NotFoundException(PERIOD_NOT_FOUND)
        if (!TeamService.Teams.lockActiveForWrite(teamId)) throw NotFoundException(PERIOD_NOT_FOUND)
        val row = CapacityPeriods.selectAll().where { (CapacityPeriods.id eq id) and CapacityPeriods.active() }
            .toList().singleOrNull() ?: throw NotFoundException(PERIOD_NOT_FOUND)
        guard(teamId)
        val values = CapacityPeriodValues(row[CapacityPeriods.effectiveFrom], row[CapacityPeriods.mdPerWeek], row[CapacityPeriods.wipLimit])
        return LockedPeriod(teamId, values, CapacitySource.valueOf(row[CapacityPeriods.capacitySource]))
    }

    private fun ResultRow.toResponse() = CapacityPeriodResponse(
        id = this[CapacityPeriods.id].value,
        teamId = this[CapacityPeriods.teamId].value,
        effectiveFrom = this[CapacityPeriods.effectiveFrom].toString(),
        mdPerWeek = this[CapacityPeriods.mdPerWeek].toDouble(),
        wipLimit = this[CapacityPeriods.wipLimit],
        createdAt = this[CapacityPeriods.createdAt],
        updatedAt = this[CapacityPeriods.updatedAt],
        source = CapacitySource.valueOf(this[CapacityPeriods.capacitySource]),
        flowSprintName = this[CapacityPeriods.flowSprintName],
    )
}

/**
 * Soft-deletes every ACTIVE capacity period of [teamId] and returns how many — the team delete's cascade (`TeamService.delete`,
 * same transaction, under the team row lock, after the milestone 409): periods are the team's own data and leave with it.
 */
internal suspend fun deleteCapacityPeriodsOf(teamId: UInt): Int {
    val periods = TeamCapacityService.CapacityPeriods
    return periods.update({ (periods.teamId eq teamId) and periods.active() }) {
        it[markedAsDeleted] = true
        it[updatedAt] = nowMillis()
    }
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
