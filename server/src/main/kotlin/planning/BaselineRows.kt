package ch.nokillswit.planning

import ch.nokillswit.infra.db.active
import kotlinx.coroutines.flow.toList
import org.jetbrains.exposed.v1.core.ResultRow
import org.jetbrains.exposed.v1.core.and
import org.jetbrains.exposed.v1.core.eq
import org.jetbrains.exposed.v1.r2dbc.select
import org.jetbrains.exposed.v1.r2dbc.selectAll
import java.math.BigDecimal
import java.time.LocalDate

/*
 * The baseline row loaders: the capture side (`baselineMilestoneFacts`, read under the plan lock by `BaselineService.create`) and the
 * read side the views use (`activeBaseline`, `frozenProjects`, `frozenMilestonesOf…`). Every function runs INSIDE the caller's open
 * transaction - the views call them right after `readPlanRevision()`, one indexed select each - and nowhere else.
 */

/** An ACTIVE baseline's header row. [createdByUserId] is null when the login was never recorded. */
internal class BaselineHeader(
    val id: UInt,
    val name: String,
    val description: String?,
    val planRevision: Long,
    val createdByUserId: UInt?,
    val milestoneCount: Int,
    val projectCount: Int,
    val createdAt: Long,
)

/** A frozen `baseline_projects` row: the project as the baseline took it (names as they were; [target] and [span] null when none). */
internal class FrozenProjectRow(
    val id: UInt,
    val programId: UInt,
    val workStreamId: UInt,
    val name: String,
    val programName: String,
    val workStreamName: String,
    val rankPosition: Int?,
    val target: DaySpan?,
    val span: DaySpan?,
)

/** A frozen `baseline_milestones` row: [span] is null when the milestone was unscheduled at the time. */
internal class FrozenMilestoneRow(
    val id: UInt,
    val projectId: UInt,
    val teamId: UInt,
    val name: String,
    val estimateMd: BigDecimal,
    val span: DaySpan?,
)

/** An ACTIVE milestone as a baseline captures it: the roadmap's fact plus the name and the estimate. */
internal class MilestoneCapture(
    val id: UInt,
    val projectId: UInt,
    val teamId: UInt,
    val name: String,
    val estimateMd: BigDecimal,
    val span: DaySpan?,
)

internal fun ResultRow.toBaselineHeader(): BaselineHeader {
    val baselines = BaselineService.Baselines
    return BaselineHeader(
        id = this[baselines.id].value,
        name = this[baselines.name],
        description = this[baselines.description],
        planRevision = this[baselines.planRevision],
        createdByUserId = this[baselines.createdByUserId]?.value,
        milestoneCount = this[baselines.milestoneCount],
        projectCount = this[baselines.projectCount],
        createdAt = this[baselines.createdAt],
    )
}

/** The ACTIVE baseline [id], or null when it is unknown or soft-deleted (the views' and the registry's 404). */
internal suspend fun activeBaseline(id: UInt): BaselineHeader? {
    val baselines = BaselineService.Baselines
    return baselines.selectAll().where { (baselines.id eq id) and baselines.active() }.toList().singleOrNull()?.toBaselineHeader()
}

private fun span(start: LocalDate?, end: LocalDate?): DaySpan? = if (start != null && end != null) DaySpan(start, end) else null

/** Every frozen project of [baselineId] (about 100), by id. The rows outlive a soft delete; the caller checks the header. */
internal suspend fun frozenProjects(baselineId: UInt): List<FrozenProjectRow> {
    val rows = BaselineService.BaselineProjects
    return rows.selectAll().where { rows.baselineId eq baselineId }.orderBy(rows.projectId).toList().map { row ->
        FrozenProjectRow(
            id = row[rows.projectId],
            programId = row[rows.programId],
            workStreamId = row[rows.workStreamId],
            name = row[rows.name],
            programName = row[rows.programName],
            workStreamName = row[rows.workStreamName],
            rankPosition = row[rows.rankPosition],
            target = span(row[rows.targetStart], row[rows.targetEnd]),
            span = span(row[rows.spanStart], row[rows.spanEnd]),
        )
    }
}

private fun ResultRow.toFrozenMilestone(): FrozenMilestoneRow {
    val rows = BaselineService.BaselineMilestones
    return FrozenMilestoneRow(
        id = this[rows.milestoneId],
        projectId = this[rows.projectId],
        teamId = this[rows.teamId],
        name = this[rows.name],
        estimateMd = this[rows.estimateMd],
        span = span(this[rows.startDate], this[rows.endDate]),
    )
}

/** The frozen milestones of [baselineId] that belonged to [projectId] (`idx_baseline_milestones_project`), by id. */
internal suspend fun frozenMilestonesOfProject(baselineId: UInt, projectId: UInt): List<FrozenMilestoneRow> {
    val rows = BaselineService.BaselineMilestones
    return rows.selectAll().where { (rows.baselineId eq baselineId) and (rows.projectId eq projectId) }
        .orderBy(rows.milestoneId).toList().map { it.toFrozenMilestone() }
}

/** The frozen milestones of [baselineId] that belonged to [teamId] (`idx_baseline_milestones_team`), by id. */
internal suspend fun frozenMilestonesOfTeam(baselineId: UInt, teamId: UInt): List<FrozenMilestoneRow> {
    val rows = BaselineService.BaselineMilestones
    return rows.selectAll().where { (rows.baselineId eq baselineId) and (rows.teamId eq teamId) }
        .orderBy(rows.milestoneId).toList().map { it.toFrozenMilestone() }
}

/**
 * Every ACTIVE milestone as a baseline captures it (dates, estimate, team, project, name), by id. Read WITHOUT an `active()` filter on
 * the team or the project, like [milestoneFacts]: an active milestone's team is always active (`TeamService.delete`'s 409) and its
 * project too (the project delete cascades). About 1,000 narrow rows on the sample plan.
 */
internal suspend fun baselineMilestoneFacts(): List<MilestoneCapture> {
    val milestones = MilestoneService.Milestones
    return milestones
        .select(
            milestones.id, milestones.projectId, milestones.teamId, milestones.name, milestones.estimateMd,
            milestones.startDate, milestones.endDate,
        )
        .where { milestones.active() }
        .orderBy(milestones.id)
        .toList()
        .map { row ->
            MilestoneCapture(
                id = row[milestones.id].value,
                projectId = row[milestones.projectId].value,
                teamId = row[milestones.teamId].value,
                name = row[milestones.name],
                estimateMd = row[milestones.estimateMd],
                span = span(row[milestones.startDate], row[milestones.endDate]),
            )
        }
}
