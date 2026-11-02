package ch.nokillswit.planning

import ch.nokillswit.authz.OwnerChain
import ch.nokillswit.infra.db.active
import ch.nokillswit.infra.time.WorkingCalendar
import ch.nokillswit.teams.TeamService
import kotlinx.coroutines.flow.toList
import org.jetbrains.exposed.v1.core.*
import org.jetbrains.exposed.v1.r2dbc.*

/*
 * The row loading and assembly of the roadmap view (`GET /views/roadmap`), split out of `RoadmapViewService` to keep both small and
 * shared with the programs view (one project row, one kernel run). Every function runs INSIDE the view's read transaction and
 * nowhere else.
 */

/** What the roadmap and programs views derive from one snapshot: every project row, the team filter's options and the rolled-up links. */
internal class RoadmapSnapshot(
    val projects: List<RoadmapProject>,
    val teams: List<RoadmapTeam>,
    val links: List<RoadmapLink>,
    /** The projects' derived spans by id (absent = none scheduled): the programs view rolls them up without parsing the wire dates. */
    val spans: Map<UInt, DaySpan>,
    /** The working calendar the snapshot read (the baseline overlay measures movement on it). */
    val calendar: WorkingCalendar,
)

/** A project row with the owner chain `can.editTargetWindow` needs; [loadRoadmapSnapshot] completes it into a [RoadmapProject]. */
private class ProjectRow(val project: RoadmapProject, val chain: OwnerChain, val target: DaySpan?)

/**
 * An ACTIVE milestone with its team's name and its own [name], read for the facts, the team filter and the project's `teamIds`
 * (the roadmap) and for the critical path's upstream entries (the project view).
 */
internal class MilestoneFactRow(val fact: PlanMilestoneFact, val teamName: String, val name: String)

/**
 * Loads the four row sets (projects with their rank and owner chains, milestones, links) and runs [RoadmapKernels] ONCE: the derived
 * spans, the drift and inversion flags, the rolled-up links. [actor] decides each project's `can.editTargetWindow`
 * ([PlanPermissions.canEditTargetWindow] on the chain read in the same statement as the row). Statements: the projects, the owner
 * names, the rank entries, the milestones, the links - bounded by the plan's scale (about 100 projects, 1,000 milestones). The
 * comparison view needs no links ([withLinks] false: `links` is then empty and the link statement is skipped).
 */
internal suspend fun loadRoadmapSnapshot(actor: PlanActor, withLinks: Boolean = true): RoadmapSnapshot {
    // Right after the caller's readPlanRevision(): the revision, the rows and the calendar are one snapshot.
    val calendar = loadWorkingCalendar()
    val rows = projectRows()
    val ranks = rankPositions()
    val milestones = milestoneFacts()
    val known = rows.keys
    val facts = milestones.map { it.fact }.filter { it.projectId in known }
    val projectFacts = rows.values.map { row ->
        PlanProjectFact(row.project.id, ranks[row.project.id], row.target)
    }
    val spans = RoadmapKernels.projectSpans(facts)
    val inversions = RoadmapKernels.inversionFlags(projectFacts, facts)
    val teamIds = facts.groupBy({ it.projectId }) { it.teamId }.mapValues { (_, ids) -> ids.distinct().sorted() }
    val projects = rows.values.map { row ->
        val p = row.project
        val span = spans[p.id]
        p.copy(
            rankPosition = ranks[p.id],
            teamIds = teamIds[p.id].orEmpty(),
            span = span?.let { DateSpan(it.start.toString(), it.end.toString()) },
            drift = SpanKernels.drift(span, row.target),
            flags = (RoadmapKernels.driftFlags(span, row.target) + inversions[p.id].orEmpty()).sortedWith(FLAG_ORDER),
            can = RoadmapProjectCan(PlanPermissions.canEditTargetWindow(actor, row.chain)),
        )
    }
    val teams = milestones.filter { it.fact.projectId in known }.associate { it.fact.teamId to it.teamName }
        .map { (id, name) -> RoadmapTeam(id, name) }
        .sortedWith(compareBy({ it.name.lowercase() }, { it.id }))
    val links = if (withLinks) RoadmapKernels.linkAggregates(linkFacts(), projectFacts, facts, spans, calendar) else emptyList()
    return RoadmapSnapshot(projects, teams, links, spans, calendar)
}

/**
 * Every ACTIVE project whose program and work stream are active, by id, with the three owner ids of its chain and the owners' names
 * (one batched lookup). The wire fields the kernels fill ([RoadmapProject.rankPosition] and after) hold neutral placeholders here.
 */
private suspend fun projectRows(): Map<UInt, ProjectRow> {
    val projects = ProjectService.Projects
    val programs = ProgramService.Programs
    val streams = WorkStreamService.WorkStreams
    val rows = projects.innerJoin(programs, { projects.programId }, { programs.id })
        .innerJoin(streams, { programs.workStreamId }, { streams.id })
        .select(
            projects.id, projects.name, projects.programId, projects.ownerPersonId, projects.targetStart, projects.targetEnd,
            programs.name, programs.workStreamId, programs.ownerPersonId, streams.name, streams.ownerPersonId,
        )
        .where { projects.active() and programs.active() and streams.active() }
        .toList()
    val owners = ownerNames(rows.map { it[projects.ownerPersonId].value })
    return rows.associate { row ->
        val id = row[projects.id].value
        val targetStart = row[projects.targetStart]
        val targetEnd = row[projects.targetEnd]
        id to ProjectRow(
            project = RoadmapProject(
                id = id,
                name = row[projects.name],
                programId = row[projects.programId].value,
                programName = row[programs.name],
                workStreamId = row[programs.workStreamId].value,
                workStreamName = row[streams.name],
                ownerPersonId = row[projects.ownerPersonId].value,
                ownerName = owners.getValue(row[projects.ownerPersonId].value),
                targetStart = targetStart?.toString(),
                targetEnd = targetEnd?.toString(),
                rankPosition = null,
                teamIds = emptyList(),
                span = null,
                drift = null,
                flags = emptyList(),
                can = RoadmapProjectCan(editTargetWindow = false),
            ),
            chain = OwnerChain(
                listOf(row[streams.ownerPersonId].value, row[programs.ownerPersonId].value, row[projects.ownerPersonId].value),
            ),
            target = targetStart?.let { start -> targetEnd?.let { DaySpan(start, it) } },
        )
    }
}

/** The rank entries as project id -> position (an entry of a project that is no longer active is simply never looked up). */
private suspend fun rankPositions(): Map<UInt, Int> {
    val entries = RoadmapService.RoadmapEntries
    return entries.selectAll().toList().associate { it[entries.projectId].value to it[entries.position] }
}

/**
 * Every ACTIVE milestone with its team's name, read WITHOUT an `active()` filter on the team or the project: an active milestone's
 * team is always active (`TeamService.delete`'s 409) and its project too (the project delete cascades), the `ownerNames` reasoning.
 * Shared by the roadmap and programs views and the project view's critical path (one statement shape, one snapshot each).
 */
internal suspend fun milestoneFacts(): List<MilestoneFactRow> {
    val milestones = MilestoneService.Milestones
    val teams = TeamService.Teams
    return milestones.innerJoin(teams, { milestones.teamId }, { teams.id })
        .select(
            milestones.id, milestones.projectId, milestones.teamId, milestones.startDate, milestones.endDate, milestones.name, teams.name,
        )
        .where { milestones.active() }
        .toList()
        .map { row ->
            val start = row[milestones.startDate]
            val end = row[milestones.endDate]
            MilestoneFactRow(
                fact = PlanMilestoneFact(
                    id = row[milestones.id].value,
                    projectId = row[milestones.projectId].value,
                    teamId = row[milestones.teamId].value,
                    span = if (start != null && end != null) DaySpan(start, end) else null,
                ),
                teamName = row[teams.name],
                name = row[milestones.name],
            )
        }
}

/** Every ACTIVE link as the kernels' input. */
internal suspend fun linkFacts(): List<PlanLinkFact> {
    val links = DependencyService.Dependencies
    return links.selectAll().where { links.active() }.orderBy(links.id).toList().map { row ->
        PlanLinkFact(
            id = row[links.id].value,
            predecessor = row.predecessorRef(),
            successor = row.successorRef(),
            type = DependencyType.valueOf(row[links.type]),
            lagDays = row[links.lagDays],
        )
    }
}

/** Every ACTIVE project's name by id (about 100 rows): the critical path's upstream entries name their project. */
internal suspend fun activeProjectNames(): Map<UInt, String> {
    val projects = ProjectService.Projects
    val rows = projects.select(projects.id, projects.name).where { projects.active() }.toList()
    return rows.associate { it[projects.id].value to it[projects.name] }
}
