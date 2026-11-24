package ch.nokillswit.planning

import ch.nokillswit.infra.db.insertRows
import ch.nokillswit.teams.TeamCapacityService.CapacityPeriods
import ch.nokillswit.teams.activeCapacityPeriodsOfActiveTeams
import kotlinx.coroutines.flow.toList
import org.jetbrains.exposed.v1.core.ResultRow
import org.jetbrains.exposed.v1.core.SortOrder
import org.jetbrains.exposed.v1.core.and
import org.jetbrains.exposed.v1.core.eq
import org.jetbrains.exposed.v1.core.inList
import org.jetbrains.exposed.v1.r2dbc.select
import org.jetbrains.exposed.v1.r2dbc.selectAll

/*
 * The two things a baseline freezes besides the dated structure (V33): every ACTIVE link and every ACTIVE capacity period of every ACTIVE
 * team. The capture side is read under the plan lock by `BaselineService.create`; the read side is what the comparison and the project
 * and team overlays use, inside their own snapshot, one indexed select each. Every function runs INSIDE the caller's open transaction.
 * A baseline whose header counts are null never captured them: its tables hold no rows, and the callers ask the header first.
 */

/** An ACTIVE capacity period with the id and team it is stored under ([period] is what the kernels read). */
internal class CapacityCapture(val periodId: UInt, val teamId: UInt, val period: CapacityPeriod)

/** Every ACTIVE period of every ACTIVE team, by team, start, id: about a handful a team. */
internal suspend fun liveCapacityCaptures(): List<CapacityCapture> =
    activeCapacityPeriodsOfActiveTeams().toList().map { row ->
        CapacityCapture(
            periodId = row[CapacityPeriods.id].value,
            teamId = row[CapacityPeriods.teamId].value,
            period = CapacityPeriod(row[CapacityPeriods.effectiveFrom], row[CapacityPeriods.mdPerWeek], row[CapacityPeriods.wipLimit]),
        )
    }

internal suspend fun insertLinks(baselineId: UInt, links: List<PlanLinkFact>) {
    val rows = BaselineService.BaselineDependencies
    rows.insertRows(links) { l ->
        this[rows.baselineId] = baselineId
        this[rows.dependencyId] = l.id
        this[rows.predMilestoneId] = l.predecessor.id.takeIf { l.predecessor.kind == EndpointKind.MILESTONE }
        this[rows.predProjectId] = l.predecessor.id.takeIf { l.predecessor.kind == EndpointKind.PROJECT }
        this[rows.succMilestoneId] = l.successor.id.takeIf { l.successor.kind == EndpointKind.MILESTONE }
        this[rows.succProjectId] = l.successor.id.takeIf { l.successor.kind == EndpointKind.PROJECT }
        this[rows.type] = l.type.name
        this[rows.lagDays] = l.lagDays
    }
}

internal suspend fun insertCapacity(baselineId: UInt, periods: List<CapacityCapture>) {
    val rows = BaselineService.BaselineCapacityPeriods
    rows.insertRows(periods) { c ->
        this[rows.baselineId] = baselineId
        this[rows.periodId] = c.periodId
        this[rows.teamId] = c.teamId
        this[rows.effectiveFrom] = c.period.effectiveFrom
        this[rows.mdPerWeek] = c.period.mdPerWeek
        this[rows.wipLimit] = c.period.wipLimit
    }
}

private fun ResultRow.toFrozenLink(): PlanLinkFact {
    val rows = BaselineService.BaselineDependencies
    return PlanLinkFact(
        id = this[rows.dependencyId],
        predecessor = endpointOf(this[rows.predMilestoneId], this[rows.predProjectId]),
        successor = endpointOf(this[rows.succMilestoneId], this[rows.succProjectId]),
        type = DependencyType.valueOf(this[rows.type]),
        lagDays = this[rows.lagDays],
    )
}

private fun endpointOf(milestone: UInt?, project: UInt?): EndpointRef =
    if (milestone != null) EndpointRef(EndpointKind.MILESTONE, milestone) else EndpointRef(EndpointKind.PROJECT, checkNotNull(project))

/** Every link [baselineId] froze (up to a few thousand narrow rows: the primary key's prefix), by dependency id. */
internal suspend fun frozenLinks(baselineId: UInt): List<PlanLinkFact> {
    val rows = BaselineService.BaselineDependencies
    return rows.selectAll().where { rows.baselineId eq baselineId }.orderBy(rows.dependencyId).toList().map { it.toFrozenLink() }
}

/** The ids among [ids] that [baselineId] froze (the primary key); the project view marks the others "new since the baseline". */
internal suspend fun frozenLinkIdsAmong(baselineId: UInt, ids: Collection<UInt>): Set<UInt> {
    if (ids.isEmpty()) return emptySet()
    val rows = BaselineService.BaselineDependencies
    return rows.select(rows.dependencyId).where { (rows.baselineId eq baselineId) and (rows.dependencyId inList ids) }.toList()
        .mapTo(HashSet()) { it[rows.dependencyId] }
}

private fun ResultRow.toFrozenPeriod(): CapacityCapture {
    val rows = BaselineService.BaselineCapacityPeriods
    return CapacityCapture(
        periodId = this[rows.periodId],
        teamId = this[rows.teamId],
        period = CapacityPeriod(this[rows.effectiveFrom], this[rows.mdPerWeek], this[rows.wipLimit]),
    )
}

/** Every capacity period [baselineId] froze, by team, start, id. */
internal suspend fun frozenCapacity(baselineId: UInt): List<CapacityCapture> {
    val rows = BaselineService.BaselineCapacityPeriods
    return rows.selectAll().where { rows.baselineId eq baselineId }
        .orderBy(rows.teamId to SortOrder.ASC, rows.effectiveFrom to SortOrder.ASC, rows.periodId to SortOrder.ASC)
        .toList().map { it.toFrozenPeriod() }
}

/** The periods [baselineId] froze for [teamId] (`idx_baseline_capacity_periods_team`), by start. */
internal suspend fun frozenCapacityOfTeam(baselineId: UInt, teamId: UInt): List<CapacityPeriod> {
    val rows = BaselineService.BaselineCapacityPeriods
    return rows.selectAll().where { (rows.baselineId eq baselineId) and (rows.teamId eq teamId) }
        .orderBy(rows.effectiveFrom to SortOrder.ASC, rows.periodId to SortOrder.ASC).toList().map { it.toFrozenPeriod().period }
}
