package ch.nokillswit.planning

import ch.nokillswit.infra.db.active
import ch.nokillswit.teams.CapacityPeriodResponse
import ch.nokillswit.teams.CapacitySource
import ch.nokillswit.teams.TeamCapacityService
import kotlinx.coroutines.flow.toList
import org.jetbrains.exposed.v1.core.*
import org.jetbrains.exposed.v1.r2dbc.*
import java.math.BigDecimal

/*
 * The row loading of the team view (`GET /views/team/{id}`), split out of `TeamViewService` to keep both small. Every function runs
 * INSIDE the view's read transaction (the service opens it) and nowhere else.
 */

/** A milestone of the team: its wire form [view], the stored [span] (null = unscheduled), its [estimate] and the ordering [key]. */
internal class TeamMilestoneRow(val view: TeamMilestone, val span: DaySpan?, val estimate: BigDecimal, val key: OrderKey) {
    /** The row as the baseline comparison sees it (the unrounded estimate). */
    fun live() = LiveMilestone(view.id, view.projectId, view.teamId, view.name, estimate, span)

    /** The row with its slack and critical flag from its OWN project's [path] (null = the project has nothing scheduled). */
    fun withCriticalPath(path: CriticalPathResult?) = TeamMilestoneRow(
        view = view.copy(
            slackDays = path?.slackByMilestone?.get(view.id)?.let { Math.toIntExact(it) },
            critical = path != null && view.id in path.criticalMilestones,
        ),
        span = span, estimate = estimate, key = key,
    )
}

/**
 * Every ACTIVE milestone of [teamId] with its project, program and work stream names and its project's rank position (`roadmap_entries`,
 * left-joined: unranked = null), read WITHOUT an `active()` filter on the ancestors - an active milestone's project, program and work
 * stream are always active (the deletes cascade or refuse), the `ownerNames` reasoning. [positions] are the team's own order positions
 * ([positionsOf]), looked up FROM these active milestones, never the other way round.
 */
internal suspend fun teamMilestoneRows(teamId: UInt, teamName: String, positions: Map<UInt, Int>): List<TeamMilestoneRow> {
    val milestones = MilestoneService.Milestones
    val projects = ProjectService.Projects
    val programs = ProgramService.Programs
    val streams = WorkStreamService.WorkStreams
    val ranks = RoadmapService.RoadmapEntries
    return milestones.innerJoin(projects, { milestones.projectId }, { projects.id })
        .innerJoin(programs, { projects.programId }, { programs.id })
        .innerJoin(streams, { programs.workStreamId }, { streams.id })
        .join(ranks, JoinType.LEFT, onColumn = milestones.projectId, otherColumn = ranks.projectId)
        .select(milestones.columns + listOf(projects.name, programs.name, streams.name, ranks.position))
        .where { (milestones.teamId eq teamId) and milestones.active() }
        .toList()
        .map { row ->
            val id = row[milestones.id].value
            val start = row[milestones.startDate]
            val end = row[milestones.endDate]
            val rank = row.getOrNull(ranks.position) // null: the LEFT JOIN found no entry (unranked)
            TeamMilestoneRow(
                span = if (start != null && end != null) DaySpan(start, end) else null,
                estimate = row[milestones.estimateMd],
                key = OrderKey(
                    customPosition = positions[id],
                    projectRank = rank,
                    projectName = row[projects.name],
                    projectId = row[milestones.projectId].value,
                    start = start,
                    end = end,
                    name = row[milestones.name],
                    id = id,
                ),
                view = TeamMilestone(
                    id = id,
                    projectId = row[milestones.projectId].value,
                    name = row[milestones.name],
                    description = row[milestones.description],
                    teamId = teamId,
                    teamName = teamName,
                    estimateMd = row[milestones.estimateMd].toDouble(),
                    startDate = start?.toString(),
                    endDate = end?.toString(),
                    createdAt = row[milestones.createdAt],
                    updatedAt = row[milestones.updatedAt],
                    projectName = row[projects.name],
                    programName = row[programs.name],
                    workStreamName = row[streams.name],
                    rankPosition = rank,
                    slackDays = null,
                    critical = false,
                ),
            )
        }
}

/** The team's ACTIVE capacity periods by `effectiveFrom`: the wire form and the kernel's input, from the same rows. */
internal suspend fun teamCapacityRows(teamId: UInt): Pair<List<CapacityPeriodResponse>, List<CapacityPeriod>> {
    val periods = TeamCapacityService.CapacityPeriods
    val rows = periods.selectAll().where { (periods.teamId eq teamId) and periods.active() }
        .orderBy(periods.effectiveFrom to SortOrder.ASC, periods.id to SortOrder.ASC)
        .toList()
    val wire = rows.map {
        CapacityPeriodResponse(
            id = it[periods.id].value,
            teamId = teamId,
            effectiveFrom = it[periods.effectiveFrom].toString(),
            mdPerWeek = it[periods.mdPerWeek].toDouble(),
            wipLimit = it[periods.wipLimit],
            createdAt = it[periods.createdAt],
            updatedAt = it[periods.updatedAt],
            source = CapacitySource.valueOf(it[periods.capacitySource]),
            flowSprintName = it[periods.flowSprintName],
        )
    }
    val kernel = rows.map { CapacityPeriod(it[periods.effectiveFrom], it[periods.mdPerWeek], it[periods.wipLimit]) }
    return wire to kernel
}
