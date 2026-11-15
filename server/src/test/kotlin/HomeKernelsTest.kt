package ch.nokillswit

import ch.nokillswit.planning.CheckedLink
import ch.nokillswit.planning.DaySpan
import ch.nokillswit.planning.DependencyCheck
import ch.nokillswit.planning.DependencyStatus
import ch.nokillswit.planning.DependencyType
import ch.nokillswit.planning.EndpointKind
import ch.nokillswit.planning.EndpointRef
import ch.nokillswit.planning.FlagCounts
import ch.nokillswit.planning.FlagKind
import ch.nokillswit.planning.FlagSeverity
import ch.nokillswit.planning.HomeFacts
import ch.nokillswit.planning.HomeKernels
import ch.nokillswit.planning.HomeProgramFact
import ch.nokillswit.planning.HomeStreamFact
import ch.nokillswit.planning.HomeTeamFact
import ch.nokillswit.planning.PlanFlag
import ch.nokillswit.planning.PlanLinkFact
import ch.nokillswit.planning.PlanMilestoneFact
import ch.nokillswit.planning.RoadmapKernels
import ch.nokillswit.planning.RoadmapProject
import ch.nokillswit.planning.RoadmapProjectCan
import ch.nokillswit.planning.WeekLoad
import java.math.BigDecimal
import java.time.LocalDate
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

/**
 * Home's pure figures (no server, no database): hand-built facts of a small world. Streams 1 (open, "Beta") and 2 (closed,
 * "alpha-closed"), both owned by person 7; programs 11 ("Zeta", person 7), 12 ("Alpha", person 8) in stream 1 and 13 ("Empty",
 * person 7, no project) in stream 2; projects 21 (rank 2, person 7), 22 (rank 1, person 8), 23 (rank 3, person 7), 24 (unranked,
 * person 7); six milestones, two unscheduled; four checked links (two violated: one across projects, one inside project 21).
 */
class HomeKernelsTest {
    private val me = 7u
    private val other = 8u

    private fun day(date: String) = LocalDate.parse(date)

    private val span = DaySpan(day("2027-03-08"), day("2027-03-12"))

    private fun flag(severity: FlagSeverity, kind: FlagKind = FlagKind.DRIFT_END_LATE) = PlanFlag(kind, severity)

    private fun project(
        id: UInt,
        programId: UInt,
        owner: UInt,
        rank: Int?,
        flags: List<PlanFlag> = emptyList(),
        name: String = "p$id",
    ) =
        RoadmapProject(
            id = id, name = name, programId = programId, programName = "program$programId", workStreamId = 1u, workStreamName = "stream",
            ownerPersonId = owner, ownerName = "owner$owner", targetStart = null, targetEnd = null, rankPosition = rank,
            teamIds = emptyList(),
            span = null, drift = null, flags = flags, can = RoadmapProjectCan(editTargetWindow = false),
        )

    private fun milestone(id: UInt, projectId: UInt, teamId: UInt, scheduled: Boolean) =
        PlanMilestoneFact(id, projectId, teamId, span.takeIf { scheduled })

    private fun check(status: DependencyStatus) = DependencyCheck(status, null, null, null, null)

    private fun link(id: UInt, pred: EndpointRef, succ: EndpointRef, predProject: UInt, succProject: UInt, status: DependencyStatus) =
        CheckedLink(PlanLinkFact(id, pred, succ, DependencyType.FS, 0), predProject, succProject, check(status))

    private fun ms(id: UInt) = EndpointRef(EndpointKind.MILESTONE, id)

    private fun week(overloaded: Boolean = false, wipExceeded: Boolean = false) =
        WeekLoad(day("2027-03-08"), BigDecimal.ZERO, null, overloaded, null, 0, wipExceeded)

    private val streams = listOf(HomeStreamFact(1u, "Beta", me, null), HomeStreamFact(2u, "alpha-closed", me, day("2026-06-30")))
    private val programs = listOf(
        HomeProgramFact(11u, 1u, "Zeta", me, "owner$me"), HomeProgramFact(12u, 1u, "Alpha", other, "owner$other"),
        HomeProgramFact(13u, 2u, "Empty", me, "owner$me"),
    )
    private val projects = listOf(
        project(21u, 11u, me, 2, listOf(flag(FlagSeverity.WARNING), flag(FlagSeverity.INFO))),
        project(22u, 11u, other, 1, listOf(flag(FlagSeverity.WARNING))),
        project(23u, 12u, me, 3),
        project(24u, 12u, me, null, listOf(flag(FlagSeverity.INFO))),
    )
    private val milestones = listOf(
        milestone(101u, 21u, 5u, true), milestone(102u, 21u, 5u, false), milestone(103u, 22u, 6u, true),
        milestone(104u, 23u, 5u, true), milestone(105u, 24u, 6u, false), milestone(106u, 22u, 5u, true),
    )
    private val links = listOf(
        link(1u, ms(101u), ms(103u), 21u, 22u, DependencyStatus.VIOLATED),
        link(2u, ms(101u), ms(102u), 21u, 21u, DependencyStatus.VIOLATED),
        link(3u, EndpointRef(EndpointKind.PROJECT, 23u), ms(105u), 23u, 24u, DependencyStatus.UNSCHEDULED),
        link(4u, ms(104u), ms(106u), 23u, 22u, DependencyStatus.OK),
    )

    /** A violated link from a PROJECT end (project 24) to milestone 104 (team 5, project 23): only the milestone end can credit a team. */
    private val projectEndedViolation = link(5u, EndpointRef(EndpointKind.PROJECT, 24u), ms(104u), 24u, 23u, DependencyStatus.VIOLATED)

    /** A violated link between milestone 106 (team 5) and milestone 105 (team 6): one milestone end in each of two teams. */
    private val mixedTeamViolation = link(6u, ms(106u), ms(105u), 22u, 24u, DependencyStatus.VIOLATED)
    private val milestoneFlags = mapOf(
        101u to listOf(flag(FlagSeverity.WARNING, FlagKind.JIRA_DEVIATION), flag(FlagSeverity.INFO, FlagKind.JIRA_DEVIATION)),
        102u to emptyList(),
        103u to listOf(flag(FlagSeverity.WARNING, FlagKind.NO_WORKING_DAY)),
        104u to listOf(flag(FlagSeverity.WARNING, FlagKind.JIRA_DEVIATION)),
    )
    private val teamWeeks = mapOf(
        5u to listOf(week(overloaded = true), week(wipExceeded = true), week(overloaded = true, wipExceeded = true)),
        6u to listOf(week()),
        9u to listOf(week(overloaded = true)),
    )
    private val facts = HomeFacts(projects, milestones, links, milestoneFlags, teamWeeks)
    private val flowFlag = PlanFlag(FlagKind.FLOW_CAPACITY, FlagSeverity.WARNING, count = 2)

    private fun mine(personId: UInt = me, teams: List<HomeTeamFact> = emptyList(), maxRows: Int = 100, of: HomeFacts = facts) =
        HomeKernels.mine(personId, "Alex Example", streams, programs, of, teams, maxRows)

    @Test
    fun `plan counts what there is, what is unscheduled, the roll-up and the violated links once each`() {
        val plan = HomeKernels.plan(streams, programs, facts)
        assertEquals(2, plan.workStreams)
        assertEquals(3, plan.programs)
        assertEquals(4, plan.projects)
        assertEquals(3, plan.rankedProjects)
        assertEquals(1, plan.unrankedProjects)
        assertEquals(6, plan.milestones)
        assertEquals(2, plan.unscheduledMilestones)
        assertEquals(RoadmapKernels.flagCounts(projects.flatMap { it.flags }), plan.flags)
        assertEquals(FlagCounts(2, 2), plan.flags)
        assertEquals(2, plan.conflicts, "one violated link across projects and one inside a project; unscheduled and OK are none")
    }

    @Test
    fun `plan counts the teams with an overloaded week and the teams over the WIP limit, whatever their weeks`() {
        val plan = HomeKernels.plan(streams, programs, facts)
        assertEquals(2, plan.overloadedTeams, "teams 5 and 9; team 6 has a week but no flagged one")
        assertEquals(1, plan.wipExceededTeams)
        val none = HomeKernels.plan(streams, programs, facts.copy(teamWeeks = emptyMap()))
        assertEquals(0, none.overloadedTeams)
        assertEquals(0, none.wipExceededTeams)
    }

    @Test
    fun `plan drops a program whose work stream is not listed from its count`() {
        val plan = HomeKernels.plan(streams, programs + HomeProgramFact(14u, 99u, "Orphan", me, "owner$me"), facts)
        assertEquals(3, plan.programs)
    }

    @Test
    fun `an empty plan reads zero everywhere`() {
        val plan = HomeKernels.plan(emptyList(), emptyList(), HomeFacts(emptyList(), emptyList(), emptyList(), emptyMap(), emptyMap()))
        assertEquals(0, plan.projects + plan.milestones + plan.conflicts + plan.overloadedTeams + plan.wipExceededTeams)
        assertEquals(FlagCounts(0, 0), plan.flags)
    }

    @Test
    fun `a work stream's owner gets the stream, every program under it and every project under them, direct only where it is theirs`() {
        val rows = mine()
        assertEquals(listOf(1u, 2u), rows.workStreams.map { it.id }, "open before closed although 'alpha-closed' sorts first by name")
        assertEquals(listOf(12u, 13u, 11u), rows.programs.map { it.id }, "program 12 is person 8's, in person 7's stream; by name")
        assertEquals(listOf(22u, 21u, 23u, 24u), rows.projects.map { it.id }, "ranked 1, 2, 3, then the unranked; project 22 is person 8's")
        assertEquals(listOf(false, true, true), rows.programs.map { it.direct })
        assertEquals(listOf("owner$other", "owner$me", "owner$me"), rows.programs.map { it.ownerName })
        assertEquals(listOf(false, true, true, true), rows.projects.map { it.direct })
        assertEquals(listOf("owner$other", "owner$me", "owner$me", "owner$me"), rows.projects.map { it.ownerName })
        val streamOne = rows.workStreams.first()
        assertEquals(2, streamOne.programs)
        assertEquals(4, streamOne.projects, "the stream's roll-up counts every project below it, owned or not (unchanged)")
        assertEquals(FlagCounts(2, 2), streamOne.flags)
        assertEquals("2026-06-30", rows.workStreams.last().endDate)
        assertEquals(null, streamOne.endDate)
    }

    @Test
    fun `a program's owner gets the program and its projects, not the work stream or its other programs`() {
        val rows = mine(personId = other)
        assertEquals(emptyList(), rows.workStreams)
        assertEquals(listOf(12u), rows.programs.map { it.id }, "program 11 is in the same stream but not theirs")
        assertEquals(listOf(22u, 23u, 24u), rows.projects.map { it.id }, "project 22 is theirs; 23 and 24 sit under their program")
        assertEquals(listOf(true, false, false), rows.projects.map { it.direct })
        val program = rows.programs.single()
        assertTrue(program.direct)
        assertEquals("owner$other", program.ownerName)
        assertEquals(RoadmapKernels.flagCounts(projects.filter { it.programId == 12u }.flatMap { it.flags }), program.flags)
        assertEquals(2, program.projects)
        assertEquals("Beta", program.workStreamName)
        val empty = mine().programs.single { it.id == 13u }
        assertEquals(Triple("Empty", 0, FlagCounts(0, 0)), Triple(empty.name, empty.projects, empty.flags))
    }

    @Test
    fun `a project's owner gets that project and nothing above or beside it`() {
        val third = 9u
        val withThird = facts.copy(projects = projects + project(25u, 13u, third, null))
        val rows = mine(personId = third, of = withThird)
        assertEquals(emptyList(), rows.workStreams + rows.programs, "program 13 is person 7's; its project is person 9's alone")
        assertEquals(listOf(25u), rows.projects.map { it.id })
        assertTrue(rows.projects.single().direct)
        assertEquals("owner$third", rows.projects.single().ownerName)
    }

    @Test
    fun `a person on two levels of one chain gets each row once, direct where it is theirs`() {
        val rows = mine(personId = me)
        assertEquals(rows.projects.map { it.id }.distinct(), rows.projects.map { it.id })
        assertEquals(rows.programs.map { it.id }.distinct(), rows.programs.map { it.id })
        val twoLevels = facts.copy(projects = projects + project(26u, 12u, me, null))
        val also = mine(personId = me, of = twoLevels).projects
        assertEquals(1, also.count { it.id == 26u }, "owned directly AND under their stream")
        assertTrue(also.single { it.id == 26u }.direct)
        assertFalse(also.single { it.id == 22u }.direct, "inherited only")
    }

    @Test
    fun `a program whose work stream is not listed is dropped with the projects it would pass down`() {
        val underOtherStream = facts.copy(projects = projects + project(27u, 13u, 9u, null))
        assertTrue(27u in mine(of = underOtherStream).projects.map { it.id }, "listed: program 13 is in stream 2, which person 7 owns")
        val rows = HomeKernels.mine(me, "Alex", streams.take(1), programs, underOtherStream, emptyList(), 100)
        assertEquals(listOf(12u, 11u), rows.programs.map { it.id }, "program 13 sits in the unlisted stream 2")
        assertFalse(27u in rows.projects.map { it.id }, "nor does its project reach the person through it")
    }

    @Test
    fun `a project row carries the roadmap row's flags, its rank, its milestones and the links with an end in it`() {
        val rows = mine().projects
        val first = rows.single { it.id == 21u }
        assertEquals(2, first.rankPosition)
        assertEquals("program11", first.programName)
        assertEquals(2, first.milestones)
        assertEquals(1, first.unscheduledMilestones)
        assertEquals(FlagCounts(1, 1), first.flags)
        assertEquals(2, first.conflicts, "the link across projects AND the one inside it (once)")
        val unranked = rows.last()
        assertEquals(24u, unranked.id)
        assertEquals(null, unranked.rankPosition)
        assertEquals(1, unranked.unscheduledMilestones)
        assertEquals(0, unranked.conflicts, "an unscheduled link is no conflict")
        assertEquals(FlagCounts(0, 1), unranked.flags)
        val ofOther = mine(personId = other).projects.first { it.id == 22u }
        assertEquals(1, ofOther.conflicts, "project 22 is the successor end of the one cross link")
    }

    @Test
    fun `projects come ranked first in rank order, then unranked by lowercase name then id`() {
        val unordered = listOf(
            project(31u, 11u, me, null, name = "b"), project(32u, 11u, me, 5), project(33u, 11u, me, null, name = "A"),
            project(34u, 11u, me, 2), project(35u, 11u, me, null, name = "a"),
        )
        val rows = mine(of = HomeFacts(unordered, emptyList(), emptyList(), emptyMap(), emptyMap())).projects
        assertEquals(listOf(34u, 32u, 33u, 35u, 31u), rows.map { it.id })
    }

    @Test
    fun `streams and programs ties break by id after the lowercase name`() {
        val tied = listOf(
            HomeStreamFact(4u, "ALPHA", me, null), HomeStreamFact(3u, "alpha", me, null), HomeStreamFact(2u, "Bravo", me, null),
        )
        val tiedPrograms = listOf(
            HomeProgramFact(15u, 4u, "x", me, "m"), HomeProgramFact(14u, 4u, "X", me, "m"), HomeProgramFact(16u, 4u, "a", me, "m"),
        )
        val rows = HomeKernels.mine(me, "Alex", tied, tiedPrograms, facts, emptyList(), 100)
        assertEquals(listOf(3u, 4u, 2u), rows.workStreams.map { it.id })
        assertEquals(listOf(16u, 14u, 15u), rows.programs.map { it.id })
    }

    @Test
    fun `a team counts a link with a milestone end in it, once, and the project-ended link no team`() {
        val teams = listOf(HomeTeamFact(5u, "Delta", emptyList()), HomeTeamFact(6u, "alpha", emptyList()))
        val rows = mine(teams = teams).teams
        assertEquals(listOf(6u, 5u), rows.map { it.id }, "by lowercase name")
        val five = rows.single { it.id == 5u }
        assertEquals(4, five.milestones)
        assertEquals(1, five.unscheduledMilestones)
        assertEquals(2, five.conflicts, "the cross link (101 is on team 5) and the inside link (both ends on team 5, once)")
        val six = rows.single { it.id == 6u }
        assertEquals(2, six.milestones)
        assertEquals(1, six.unscheduledMilestones)
        assertEquals(1, six.conflicts, "milestone 103 ends the cross link")
    }

    @Test
    fun `a team's jira counts JIRA_DEVIATION flags by severity and nothing else, an empty entry is tolerated`() {
        val rows = mine(teams = listOf(HomeTeamFact(5u, "Delta", emptyList()), HomeTeamFact(6u, "Echo", emptyList()))).teams
        assertEquals(FlagCounts(2, 1), rows.single { it.id == 5u }.jira, "101 (W+I) and 104 (W); 102 holds an empty list")
        assertEquals(FlagCounts(0, 0), rows.single { it.id == 6u }.jira, "103's only flag is NO_WORKING_DAY")
    }

    @Test
    fun `a team passes its flags through and counts its flagged weeks`() {
        val rows = mine(teams = listOf(HomeTeamFact(5u, "Delta", listOf(flowFlag)), HomeTeamFact(77u, "Quiet", emptyList()))).teams
        val five = rows.single { it.id == 5u }
        assertEquals(listOf(flowFlag), five.flags)
        assertEquals(2, five.overloadedWeeks)
        assertEquals(2, five.wipExceededWeeks)
        val quiet = rows.single { it.id == 77u }
        assertEquals(listOf(0, 0, 0, 0), listOf(quiet.milestones, quiet.conflicts, quiet.overloadedWeeks, quiet.wipExceededWeeks))
        assertEquals(emptyList(), quiet.flags)
    }

    @Test
    fun `a person with nothing answers four empty lists`() {
        val rows = mine(personId = 99u)
        assertEquals(
            listOf(emptyList(), emptyList(), emptyList(), emptyList()),
            listOf(rows.workStreams, rows.programs, rows.projects, rows.teams),
        )
        assertFalse(rows.truncated)
        assertEquals(99u, rows.personId)
        assertEquals("Alex Example", rows.name)
    }

    @Test
    fun `maxRows cuts each list in its order and truncated says one was cut`() {
        val teams = listOf(HomeTeamFact(5u, "Delta", emptyList()), HomeTeamFact(6u, "alpha", emptyList()))
        val cut = mine(teams = teams, maxRows = 1)
        assertTrue(cut.truncated)
        assertEquals(listOf(1u), cut.workStreams.map { it.id })
        assertEquals(listOf(12u), cut.programs.map { it.id })
        assertEquals(listOf(22u), cut.projects.map { it.id })
        assertEquals(listOf(6u), cut.teams.map { it.id })
        assertTrue(mine(teams = teams, maxRows = 3).truncated, "four projects exceed three")
        assertFalse(mine(teams = teams, maxRows = 4).truncated, "no list exceeds four")
    }

    @Test
    fun `a violated link from a project end credits a team only through its milestone end`() {
        val teams = listOf(HomeTeamFact(5u, "Delta", emptyList()), HomeTeamFact(6u, "alpha", emptyList()))
        val before = mine(teams = teams).teams.associate { it.id to it.conflicts }
        val withProjectEnd = facts.copy(checkedLinks = links + projectEndedViolation)
        val after = mine(teams = teams, of = withProjectEnd).teams.associate { it.id to it.conflicts }
        assertEquals(before.getValue(5u) + 1, after.getValue(5u), "milestone 104 is on team 5")
        assertEquals(before.getValue(6u), after.getValue(6u), "the project end is never credited to a team (project 24 has team 6's 105)")
        assertEquals(3, HomeKernels.plan(streams, programs, withProjectEnd).conflicts, "the plan counts the link once")
        assertEquals(1, mine(of = withProjectEnd).projects.first { it.id == 24u }.conflicts, "the project count credits a project end")
    }

    @Test
    fun `a violated link with a milestone end in each of two teams counts once for each team and once in the plan`() {
        val teams = listOf(HomeTeamFact(5u, "Delta", emptyList()), HomeTeamFact(6u, "alpha", emptyList()))
        val before = mine(teams = teams).teams.associate { it.id to it.conflicts }
        val mixed = facts.copy(checkedLinks = links + mixedTeamViolation)
        val after = mine(teams = teams, of = mixed).teams.associate { it.id to it.conflicts }
        assertEquals(before.getValue(5u) + 1, after.getValue(5u))
        assertEquals(before.getValue(6u) + 1, after.getValue(6u))
        assertEquals(3, HomeKernels.plan(streams, programs, mixed).conflicts)
    }
}
