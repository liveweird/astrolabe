package ch.nokillswit.planning

import ch.nokillswit.infra.db.active
import ch.nokillswit.teams.TeamService
import io.ktor.util.AttributeKey
import io.r2dbc.spi.IsolationLevel
import kotlinx.coroutines.flow.toList
import org.jetbrains.exposed.v1.core.*
import org.jetbrains.exposed.v1.r2dbc.*
import org.jetbrains.exposed.v1.r2dbc.transactions.suspendTransaction

val ProjectViewServiceKey = AttributeKey<ProjectViewService>("ProjectViewService")

/** The view's isolation: one snapshot for every statement of the read (see [ProjectViewService]). */
internal val SNAPSHOT = IsolationLevel.REPEATABLE_READ

/**
 * One project, its milestones and its dependencies (`GET /views/project/{id}`): ONE read transaction that takes the revision FIRST and
 * the rows after (the plan view's protocol — a row newer than the revision only makes a later schedule PUT carrying it answer a
 * conservative 409), then the working calendar ([loadWorkingCalendar], the holiday dictionary, same snapshot), then the critical path
 * over the WHOLE active plan graph ([loadCriticalPath], `CriticalPathKernels`), then derives the span
 * and the drift with [SpanKernels], checks the links ([projectDependencies], the pure [DependencyKernels]) and computes the caller's
 * `can` flags with [PlanPermissions]. The project, its program and its work stream must all be active (null = the route's 404).
 * Milestones are split into the scheduled (by start, end, name, id) and the unscheduled (by name, id);
 * names sort case-insensitively. The transaction is READ ONLY at REPEATABLE READ so that the revision, the project's milestones,
 * the links, the external ends and the chains are ONE snapshot (the default READ COMMITTED would let each
 * statement see a different committed plan, e.g. a link whose end the milestone read predates).
 */
class ProjectViewService(private val database: R2dbcDatabase) {
    suspend fun view(
        projectId: UInt, actor: PlanActor,
        baselineId: UInt? = null,
    ): ProjectView? = suspendTransaction(database, SNAPSHOT, readOnly = true) {
        val revision = readPlanRevision()
        val calendar = loadWorkingCalendar()
        val projects = ProjectService.Projects
        val programs = ProgramService.Programs
        val streams = WorkStreamService.WorkStreams
        val found = projectChainRow(projectId, projects.columns + listOf(programs.name, programs.workStreamId, streams.name))
            ?: return@suspendTransaction null
        // The view's own rules first (a gone project is the route's 404 for every caller), then the baseline question.
        val baseline = baselineId?.let { requireActiveBaseline(it) }
        val row = found.row
        val chain = found.chain
        val ownerId = row[projects.ownerPersonId].value
        val manage = PlanPermissions.canManage(actor, chain)
        val targetStart = row[projects.targetStart]
        val targetEnd = row[projects.targetEnd]

        val critical = loadCriticalPath(projectId, calendar)
        val milestones = milestoneRows(projectId, actor, manage, critical.result)
        val dependencies = projectDependencies(projectId, milestones.map { it.view.id }, chain, actor, calendar)
            .map { it.copy(critical = it.id in critical.result.criticalDependencies) }
        val (scheduled, unscheduled) = milestones.partition { it.span != null }
        val span = SpanKernels.derivedSpan(scheduled.mapNotNull { it.span })
        val target = if (targetStart != null && targetEnd != null) DaySpan(targetStart, targetEnd) else null

        ProjectView(
            revision = revision,
            project = ProjectViewProject(
                id = projectId,
                programId = row[projects.programId].value,
                workStreamId = row[programs.workStreamId].value,
                programName = row[programs.name],
                workStreamName = row[streams.name],
                name = row[projects.name],
                description = row[projects.description],
                ownerPersonId = ownerId,
                ownerName = found.ownerName,
                targetStart = targetStart?.toString(),
                targetEnd = targetEnd?.toString(),
                createdAt = row[projects.createdAt],
                updatedAt = row[projects.updatedAt],
                can = ProjectViewCan(
                    edit = manage,
                    delete = manage,
                    editTargetWindow = PlanPermissions.canEditTargetWindow(actor, chain),
                    createMilestone = PlanPermissions.canCreateMilestone(actor, chain),
                    createDependency = PlanPermissions.canCreateDependency(actor, chain),
                ),
            ),
            span = span?.let { DateSpan(it.start.toString(), it.end.toString()) },
            drift = SpanKernels.drift(span, target),
            scheduled = scheduled.sortedWith(
                compareBy<MilestoneRow>({ it.span?.start }, { it.span?.end }, { it.view.name.lowercase() }, { it.view.id }),
            ).map { it.view },
            unscheduled = unscheduled.sortedWith(compareBy<MilestoneRow>({ it.view.name.lowercase() }, { it.view.id })).map { it.view },
            dependencies = dependencies,
            idleGaps = idleGapViewsOf(scheduled.mapNotNull { it.span }, calendar),
            criticalPath = critical.view,
            baseline = baseline?.let { projectBaseline(it, projectId, span, milestones.map { m -> m.live }, calendar) },
        )
    }

    /**
     * Every ACTIVE milestone of [projectId] with its team name, read WITHOUT an `active()` filter on the team: an active milestone's
     * team is always active (`TeamService.delete`'s 409), the `ownerNames` reasoning. [manage] is the project-level edit/delete verdict;
     * [critical] fills each scheduled milestone's slack and critical flag.
     */
    private suspend fun milestoneRows(
        projectId: UInt,
        actor: PlanActor,
        manage: Boolean,
        critical: CriticalPathResult,
    ): List<MilestoneRow> {
        val milestones = MilestoneService.Milestones
        val teams = TeamService.Teams
        return milestones.innerJoin(teams, { milestones.teamId }, { teams.id })
            .select(milestones.columns + teams.name)
            .where { (milestones.projectId eq projectId) and milestones.active() }
            .toList()
            .map { row ->
                val id = row[milestones.id].value
                val teamId = row[milestones.teamId].value
                val start = row[milestones.startDate]
                val end = row[milestones.endDate]
                val span = if (start != null && end != null) DaySpan(start, end) else null
                MilestoneRow(
                    span = span,
                    live = LiveMilestone(id, projectId, teamId, row[milestones.name], row[milestones.estimateMd], span),
                    view = ProjectMilestone(
                        id = id,
                        projectId = projectId,
                        name = row[milestones.name],
                        description = row[milestones.description],
                        teamId = teamId,
                        teamName = row[teams.name],
                        estimateMd = row[milestones.estimateMd].toDouble(),
                        startDate = start?.toString(),
                        endDate = end?.toString(),
                        createdAt = row[milestones.createdAt],
                        updatedAt = row[milestones.updatedAt],
                        slackDays = critical.slackByMilestone[id]?.let { Math.toIntExact(it) },
                        critical = id in critical.criticalMilestones,
                        can = ProjectMilestoneCan(edit = manage, delete = manage, schedule = PlanPermissions.canSchedule(actor, teamId)),
                    ),
                )
            }
    }

    /**
     * A milestone's wire form [view] with its stored [span] (null = unscheduled) kept for the partition and the derived span, and its
     * [live] figures (the estimate unrounded) for the baseline overlay.
     */
    private class MilestoneRow(val span: DaySpan?, val live: LiveMilestone, val view: ProjectMilestone)
}
