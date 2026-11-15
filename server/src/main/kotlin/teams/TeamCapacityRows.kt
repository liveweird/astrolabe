package ch.nokillswit.teams

import ch.nokillswit.infra.db.active
import ch.nokillswit.teams.TeamCapacityService.CapacityPeriods
import org.jetbrains.exposed.v1.core.Op
import org.jetbrains.exposed.v1.core.ResultRow
import org.jetbrains.exposed.v1.core.SortOrder
import org.jetbrains.exposed.v1.core.and
import org.jetbrains.exposed.v1.core.eq
import org.jetbrains.exposed.v1.core.inList
import org.jetbrains.exposed.v1.r2dbc.Query
import org.jetbrains.exposed.v1.r2dbc.selectAll

/*
 * The one read of a team's capacity periods and the one mapping of a row to the wire form: the capacity routes, the team view and the
 * load views (`planning/` reads them here, `persistence.md` "Teams") share them, so the predicate and the order cannot drift apart.
 */

/** The ACTIVE periods of [teamId] by `effectiveFrom`, then id: the query only; the caller opens the read transaction. */
internal fun activeCapacityPeriods(teamId: UInt): Query = orderedActivePeriods(CapacityPeriods.teamId eq teamId)

/** [activeCapacityPeriods] for many teams in one statement, in the same order (the rows carry their `teamId`). */
internal fun activeCapacityPeriods(teamIds: Collection<UInt>): Query = orderedActivePeriods(CapacityPeriods.teamId inList teamIds)

private fun orderedActivePeriods(inTeams: Op<Boolean>): Query = CapacityPeriods.selectAll()
    .where { inTeams and CapacityPeriods.active() }
    .orderBy(CapacityPeriods.effectiveFrom to SortOrder.ASC, CapacityPeriods.id to SortOrder.ASC)

/** The wire form of one `team_capacity_periods` row (a row of [CapacityPeriods] selected with all its columns). */
internal fun ResultRow.toCapacityPeriodResponse() = CapacityPeriodResponse(
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
