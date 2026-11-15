package ch.nokillswit.planning

import java.time.LocalDate

/** An ACTIVE work stream as Home sees it. */
data class HomeStreamFact(val id: UInt, val name: String, val ownerPersonId: UInt, val endDate: LocalDate?)

/** An ACTIVE program as Home sees it. */
data class HomeProgramFact(val id: UInt, val workStreamId: UInt, val name: String, val ownerPersonId: UInt)

/** An ACTIVE team the caller manages, with the team view's `team.flags` (the Flow capacity roll-up; empty without a Flow source). */
data class HomeTeamFact(val id: UInt, val name: String, val flags: List<PlanFlag>)

/**
 * What the roadmap snapshot holds, plain: every project row with its flags folded in, the ACTIVE milestones of those projects, every
 * checked link ([RoadmapSnapshot.checkedLinks], a link inside one project included), the milestones' external flags
 * ([RoadmapSnapshot.milestoneFlags]; an entry may hold an empty list) and, for every team with scheduled work, its weeks
 * ([weeklyLoad] over the team's own capacity periods: the team page's rule). A team without an entry has no weeks.
 * **[teamWeeks] must hold EVERY active team with scheduled work, for every caller (a login without a person included), never only
 * the managed teams:** [HomeKernels.plan]'s `overloadedTeams` and `wipExceededTeams` count the entries, so they are right only then.
 */
data class HomeFacts(
    val projects: List<RoadmapProject>,
    val milestones: List<PlanMilestoneFact>,
    val checkedLinks: List<CheckedLink>,
    val milestoneFlags: Map<UInt, List<PlanFlag>>,
    val teamWeeks: Map<UInt, List<WeekLoad>>,
)

/**
 * Home's figures as pure functions (no I/O, no clock; the [RoadmapKernels] idiom). Nothing is invented here: every count is an
 * existing page's own function applied to a subset - [RoadmapKernels.flagCounts] for flags, the stored [CheckedLink.check]s for
 * conflicts, [weeklyLoad]'s `overloaded` and `wipExceeded` for capacity - so Home equals the page it links to.
 * The plan block's capacity figures are only correct when [HomeFacts.teamWeeks] holds every active team with scheduled work. The
 * plan's `conflicts` is every violated link once, a link inside one project included (the project and team badges count those; the
 * Roadmap draws links between projects only).
 */
object HomeKernels {
    /**
     * The plan block over [streams], [programs] and [facts]. [HomePlan.programs] counts the programs whose work stream is listed (the
     * Programs tree drops the others); the other counts are over every row given. `flags` is the roll-up over every project's flags,
     * `conflicts` the violated checked links (each once: [DependencyListKernels.totals], the dependency list's own function), the two
     * team figures the teams with at least one flagged week in [HomeFacts.teamWeeks].
     */
    fun plan(streams: Collection<HomeStreamFact>, programs: Collection<HomeProgramFact>, facts: HomeFacts): HomePlan {
        val streamIds = streams.map { it.id }.toSet()
        val warnings = TeamLoadKernels.totals(facts.teamWeeks)
        return HomePlan(
            workStreams = streams.size,
            programs = programs.count { it.workStreamId in streamIds },
            projects = facts.projects.size,
            rankedProjects = facts.projects.count { it.rankPosition != null },
            unrankedProjects = facts.projects.count { it.rankPosition == null },
            milestones = facts.milestones.size,
            unscheduledMilestones = facts.milestones.count { it.span == null },
            flags = RoadmapKernels.flagCounts(facts.projects.flatMap { it.flags }),
            conflicts = DependencyListKernels.totals(facts.checkedLinks).violated,
            overloadedTeams = warnings.overloadedTeams,
            wipExceededTeams = warnings.wipExceededTeams,
        )
    }

    /**
     * The caller's own items: [personId]'s DIRECT ownership (a row is theirs when its `ownerPersonId` is [personId]; no inheritance
     * from the work stream or program above) plus the [teams] they manage. Orders: work streams open before closed then by lowercase
     * name then id; programs and teams by lowercase name then id; projects ranked first in rank order, then by lowercase name then id.
     * Each list is cut at [maxRows] and [HomeMe.truncated] says one was. A program whose work stream is not listed is dropped (as the
     * Programs tree does).
     */
    fun mine(
        personId: UInt,
        name: String,
        streams: Collection<HomeStreamFact>,
        programs: Collection<HomeProgramFact>,
        facts: HomeFacts,
        teams: Collection<HomeTeamFact>,
        maxRows: Int,
    ): HomeMe {
        val projectsOfProgram = facts.projects.groupBy { it.programId }
        val programsOfStream = programs.groupBy { it.workStreamId }
        val streamName = streams.associate { it.id to it.name }
        val streamRows = streams.filter { it.ownerPersonId == personId }
            .sortedWith(compareBy({ it.endDate != null }, { it.name.lowercase() }, { it.id }))
            .map { stream ->
                val owned = programsOfStream[stream.id].orEmpty()
                val projects = owned.flatMap { projectsOfProgram[it.id].orEmpty() }
                HomeWorkStream(
                    stream.id, stream.name, stream.endDate?.toString(), owned.size, projects.size,
                    RoadmapKernels.flagCounts(projects.flatMap { it.flags }),
                )
            }
        val programRows = programs.filter { it.ownerPersonId == personId && it.workStreamId in streamName }
            .sortedWith(compareBy({ it.name.lowercase() }, { it.id }))
            .map { program ->
                val projects = projectsOfProgram[program.id].orEmpty()
                HomeProgram(
                    program.id, program.name, streamName.getValue(program.workStreamId), projects.size,
                    RoadmapKernels.flagCounts(projects.flatMap { it.flags }),
                )
            }
        val projectConflicts = projectConflicts(facts.checkedLinks)
        val projectRows = facts.projects.filter { it.ownerPersonId == personId }
            .sortedWith(compareBy({ it.rankPosition == null }, { it.rankPosition ?: 0 }, { it.name.lowercase() }, { it.id }))
            .map { project ->
                val own = facts.milestones.filter { it.projectId == project.id }
                HomeProject(
                    project.id, project.name, project.programName, project.rankPosition, own.size, own.count { it.span == null },
                    RoadmapKernels.flagCounts(project.flags), projectConflicts[project.id] ?: 0,
                )
            }
        val teamConflicts = teamConflicts(facts)
        val teamRows = teams.sortedWith(compareBy({ it.name.lowercase() }, { it.id })).map { teamRow(it, facts, teamConflicts) }
        return HomeMe(
            personId, name, streamRows.take(maxRows), programRows.take(maxRows), projectRows.take(maxRows), teamRows.take(maxRows),
            truncated = listOf(streamRows.size, programRows.size, projectRows.size, teamRows.size).any { it > maxRows },
        )
    }

    private fun teamRow(team: HomeTeamFact, facts: HomeFacts, conflicts: Map<UInt, Int>): HomeTeam {
        val own = facts.milestones.filter { it.teamId == team.id }
        val weeks = facts.teamWeeks[team.id].orEmpty()
        // The team chip's rule: the open Jira deviations of the team's milestones, JIRA_DEVIATION flags only.
        val jira = own.flatMap { facts.milestoneFlags[it.id].orEmpty() }.filter { it.kind == FlagKind.JIRA_DEVIATION }
        return HomeTeam(
            team.id, team.name, own.size, own.count { it.span == null }, conflicts[team.id] ?: 0,
            weeks.count { it.overloaded }, weeks.count { it.wipExceeded }, RoadmapKernels.flagCounts(jira), team.flags,
        )
    }

    /** Per project, the violated checked links with an end in it (a link inside one project counts once for it). */
    private fun projectConflicts(checked: Collection<CheckedLink>): Map<UInt, Int> =
        checked.filter { it.check.status == DependencyStatus.VIOLATED }
            .flatMap { setOf(it.predecessorProjectId, it.successorProjectId) }
            .groupingBy { it }.eachCount()

    /** Per team, the violated checked links with a MILESTONE end in it (a link with both ends in one team counts once for it). */
    private fun teamConflicts(facts: HomeFacts): Map<UInt, Int> {
        val teamOf = facts.milestones.associate { it.id to it.teamId }
        return facts.checkedLinks.filter { it.check.status == DependencyStatus.VIOLATED }
            .flatMap { c ->
                val ends = listOf(c.link.predecessor, c.link.successor)
                ends.filter { it.kind == EndpointKind.MILESTONE }.mapNotNull { teamOf[it.id] }.toSet()
            }
            .groupingBy { it }.eachCount()
    }
}
