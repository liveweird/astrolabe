package ch.nokillswit.teams

import ch.nokillswit.authz.NotFoundException
import ch.nokillswit.infra.db.SoftDeletable
import ch.nokillswit.infra.db.active
import ch.nokillswit.infra.db.existsActive
import ch.nokillswit.infra.db.localDate
import ch.nokillswit.infra.db.lockActiveForWrite
import ch.nokillswit.infra.db.nowMillis
import io.ktor.util.AttributeKey
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.flow.toList
import org.jetbrains.exposed.v1.core.ResultRow
import org.jetbrains.exposed.v1.core.SortOrder
import org.jetbrains.exposed.v1.core.and
import org.jetbrains.exposed.v1.core.dao.id.UIntIdTable
import org.jetbrains.exposed.v1.core.eq
import org.jetbrains.exposed.v1.r2dbc.R2dbcDatabase
import org.jetbrains.exposed.v1.r2dbc.insert
import org.jetbrains.exposed.v1.r2dbc.select
import org.jetbrains.exposed.v1.r2dbc.selectAll
import org.jetbrains.exposed.v1.r2dbc.transactions.suspendTransaction
import org.jetbrains.exposed.v1.r2dbc.update

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
