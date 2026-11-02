package ch.nokillswit.planning

import ch.nokillswit.infra.db.active
import ch.nokillswit.people.PersonService
import ch.nokillswit.teams.TeamService
import ch.nokillswit.users.UserService
import kotlinx.coroutines.flow.toList
import org.jetbrains.exposed.v1.core.ResultRow
import org.jetbrains.exposed.v1.core.and
import org.jetbrains.exposed.v1.core.eq
import org.jetbrains.exposed.v1.core.inList
import org.jetbrains.exposed.v1.core.innerJoin
import org.jetbrains.exposed.v1.r2dbc.select
import org.jetbrains.exposed.v1.r2dbc.selectAll
import java.math.BigDecimal
import java.time.LocalDate

/*
 * The baseline row loaders: the capture side (`baselineMilestoneFacts`, read under the plan lock by `BaselineService.create`) and the
 * read side the views use (`activeBaseline`, `frozenProjects`, `frozenMilestonesOf…`). Every function runs INSIDE the caller's open
 * transaction - the views call them right after `readPlanRevision()`, one indexed select each - and nowhere else.
 */

/** The caller is asked nothing while the plan is read for a baseline (the capture, the comparison): no `can` flag is kept. */
internal val CAPTURE_ACTOR = PlanActor(isAdmin = false, personId = null, roadmapEditor = false, managedTeamIds = emptySet())

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

private fun ResultRow.toFrozenProject(): FrozenProjectRow {
    val rows = BaselineService.BaselineProjects
    return FrozenProjectRow(
        id = this[rows.projectId],
        programId = this[rows.programId],
        workStreamId = this[rows.workStreamId],
        name = this[rows.name],
        programName = this[rows.programName],
        workStreamName = this[rows.workStreamName],
        rankPosition = this[rows.rankPosition],
        target = span(this[rows.targetStart], this[rows.targetEnd]),
        span = span(this[rows.spanStart], this[rows.spanEnd]),
    )
}

/** Every frozen project of [baselineId] (about 100), by id. The rows outlive a soft delete; the caller checks the header. */
internal suspend fun frozenProjects(baselineId: UInt): List<FrozenProjectRow> {
    val rows = BaselineService.BaselineProjects
    return rows.selectAll().where { rows.baselineId eq baselineId }.orderBy(rows.projectId).toList().map { it.toFrozenProject() }
}

/** The frozen project [projectId] of [baselineId] (the primary key), or null when the project is newer than the baseline. */
internal suspend fun frozenProject(baselineId: UInt, projectId: UInt): FrozenProjectRow? {
    val rows = BaselineService.BaselineProjects
    return rows.selectAll().where { (rows.baselineId eq baselineId) and (rows.projectId eq projectId) }.toList()
        .singleOrNull()?.toFrozenProject()
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

/** Every frozen milestone of [baselineId] (up to about 1,000), by id: the comparison view's one read. */
internal suspend fun frozenMilestones(baselineId: UInt): List<FrozenMilestoneRow> {
    val rows = BaselineService.BaselineMilestones
    return rows.selectAll().where { rows.baselineId eq baselineId }.orderBy(rows.milestoneId).toList().map { it.toFrozenMilestone() }
}

/** The frozen milestones [ids] of [baselineId] (the primary key; an id without a frozen row is simply absent), by id. */
internal suspend fun frozenMilestonesById(baselineId: UInt, ids: Collection<UInt>): List<FrozenMilestoneRow> {
    if (ids.isEmpty()) return emptyList()
    val rows = BaselineService.BaselineMilestones
    return rows.selectAll().where { (rows.baselineId eq baselineId) and (rows.milestoneId inList ids) }
        .orderBy(rows.milestoneId).toList().map { it.toFrozenMilestone() }
}

/** The names of the teams [ids], ACTIVE or not (a frozen row may name a team deleted since), by id. */
internal suspend fun teamNames(ids: Collection<UInt>): Map<UInt, String> {
    if (ids.isEmpty()) return emptyMap()
    val teams = TeamService.Teams
    return teams.select(teams.id, teams.name).where { teams.id inList ids.distinct() }.toList()
        .associate { it[teams.id].value to it[teams.name] }
}

/** The team an ACTIVE milestone sits on now, with its name. */
internal class LiveTeam(val id: UInt, val name: String)

/** The teams of the ACTIVE milestones [ids] right now (an id that is soft-deleted or unknown is absent), by milestone id. */
internal suspend fun liveTeamsOfMilestones(ids: Collection<UInt>): Map<UInt, LiveTeam> {
    if (ids.isEmpty()) return emptyMap()
    val milestones = MilestoneService.Milestones
    val teams = TeamService.Teams
    return milestones.innerJoin(teams, { milestones.teamId }, { teams.id })
        .select(milestones.id, milestones.teamId, teams.name)
        .where { (milestones.id inList ids.distinct()) and milestones.active() }
        .toList()
        .associate { it[milestones.id].value to LiveTeam(it[milestones.teamId].value, it[teams.name]) }
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

/**
 * The creators by login id: an ACTIVE login is named by its ACTIVE linked person (`people.user_id`, one active person per login),
 * else by the login's display name (`users.name`, never its email: an email would reach every reader); a soft-deleted login is absent
 * (the response reads `createdBy` as null).
 */
internal suspend fun creatorsOf(userIds: Collection<UInt>): Map<UInt, BaselineCreator> {
    if (userIds.isEmpty()) return emptyMap()
    val ids = userIds.distinct()
    val users = UserService.Users
    val people = PersonService.People
    val displayNames = users.select(users.id, users.name).where { (users.id inList ids) and users.active() }.toList()
        .associate { it[users.id].value to it[users.name] }
    val names = people.select(people.userId, people.name).where { (people.userId inList ids) and people.active() }.toList()
        .mapNotNull { row -> row[people.userId]?.value?.let { it to row[people.name] } }.toMap()
    return displayNames.mapValues { (userId, displayName) -> BaselineCreator(userId, names[userId] ?: displayName) }
}

internal fun BaselineHeader.toResponse(creators: Map<UInt, BaselineCreator>) = BaselineResponse(
    id = id,
    name = name,
    description = description,
    planRevision = planRevision,
    createdAt = createdAt,
    createdBy = createdByUserId?.let(creators::get),
    milestoneCount = milestoneCount,
    projectCount = projectCount,
)
