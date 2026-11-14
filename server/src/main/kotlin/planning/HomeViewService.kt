package ch.nokillswit.planning

import ch.nokillswit.infra.db.active
import ch.nokillswit.people.PersonService
import ch.nokillswit.teams.TeamCapacityService
import ch.nokillswit.teams.TeamService
import io.ktor.util.AttributeKey
import kotlinx.coroutines.flow.toList
import org.jetbrains.exposed.v1.core.*
import org.jetbrains.exposed.v1.r2dbc.*
import org.jetbrains.exposed.v1.r2dbc.transactions.suspendTransaction

val HomeViewServiceKey = AttributeKey<HomeViewService>("HomeViewService")

/**
 * Who asks Home: the login's [userId], the token's own (the view has no parameter, so no request value reaches the lookups). The
 * ACTIVE person linked to it and the ACTIVE teams that person manages are resolved INSIDE the view's snapshot, with NO branch on the
 * role: "yours" is the person's own, so an ADMINISTRATOR's person is looked up too (never "everything").
 */
class HomeCaller(val userId: UInt)

/**
 * The Home document (`GET /views/home`, 1.18.0): ONE read-only REPEATABLE READ transaction ([SNAPSHOT], the views' protocol) that takes
 * the PLAN's revision FIRST and the rows after, takes no lock and writes nothing. It runs the roadmap's own loader
 * ([loadRoadmapSnapshot], with the actor that may do nothing: the `can` flags are not read), two selects of its own (the ACTIVE work
 * streams and programs), the capacity load of EVERY team with scheduled milestones for EVERY caller (the plan block's two team figures
 * must not depend on who asks: the team view's own inputs - its scheduled milestones' spans and estimates, [teamCapacityRows],
 * [loadWindow], the snapshot's calendar - through [weeklyLoad]) and the caller's person: the ACTIVE `People` row linked to the login
 * (`user_id`; the login's own liveness is the per-request access check, as in `PersonService.activePersonIdOf`), the ACTIVE teams it
 * manages and per managed team the seam's team half (Jira reads nothing for a request naming no node; Flow at most six statements);
 * a person deleted or unlinked before the snapshot began reads `me: null`. Statements: the roadmap's, plus 2, plus 1 for the
 * scheduled milestones, plus 1 for ALL the capacity periods of the teams with scheduled work, plus 2 for a caller with a person
 * (the person, the managed teams) and the seam's per managed team. Reads `WorkStreams`, `Programs`, `Projects`, `People`,
 * `Milestones`, `Teams`, `CapacityPeriods`, `Dependencies`, `RoadmapEntries` and `PublicHolidays` and (through [external]) the Jira
 * and Flow tables the seam reads (`persistence.md` matrix); nothing is written. [maxRows] caps each list of `me` ([MAX_HOME_ROWS]).
 */
class HomeViewService(
    private val database: R2dbcDatabase,
    private val external: ExternalFlagSource = NoExternalFlags,
    private val maxRows: Int = MAX_HOME_ROWS,
) {
    suspend fun view(caller: HomeCaller): HomeView = suspendTransaction(database, SNAPSHOT, readOnly = true) {
        val revision = readPlanRevision()
        val snapshot = loadRoadmapSnapshot(NEUTRAL_ACTOR, external = external)
        val streams = activeStreams()
        val programs = activePrograms()
        val facts = HomeFacts(
            snapshot.projects, snapshot.facts, snapshot.checkedLinks, snapshot.milestoneFlags, teamWeeks(snapshot),
        )
        val me = linkedPerson(caller.userId)?.let { (personId, name) ->
            HomeKernels.mine(personId, name, streams, programs, facts, managedTeams(personId, snapshot), maxRows)
        }
        HomeView(revision, HomeKernels.plan(streams, programs, facts), me, snapshot.jiraSites)
    }

    private suspend fun activeStreams(): List<HomeStreamFact> {
        val streams = WorkStreamService.WorkStreams
        return streams.select(streams.id, streams.name, streams.ownerPersonId, streams.endDate).where { streams.active() }.toList()
            .map { HomeStreamFact(it[streams.id].value, it[streams.name], it[streams.ownerPersonId].value, it[streams.endDate]) }
    }

    private suspend fun activePrograms(): List<HomeProgramFact> {
        val programs = ProgramService.Programs
        return programs.select(programs.id, programs.workStreamId, programs.name, programs.ownerPersonId).where { programs.active() }
            .toList()
            .map {
                HomeProgramFact(it[programs.id].value, it[programs.workStreamId].value, it[programs.name], it[programs.ownerPersonId].value)
            }
    }

    /**
     * The weeks of EVERY active team with scheduled work, the team page's rule: ONE select of the scheduled milestones' spans and
     * estimates grouped by team, ONE select of those teams' ACTIVE capacity periods (the team view's ordering, [teamCapacityRows]'s
     * values), then one [weeklyLoad] run per team with work.
     */
    private suspend fun teamWeeks(snapshot: RoadmapSnapshot): Map<UInt, List<WeekLoad>> {
        val milestones = MilestoneService.Milestones
        val scheduled = milestones.select(milestones.teamId, milestones.startDate, milestones.endDate, milestones.estimateMd)
            .where { milestones.active() and milestones.startDate.isNotNull() and milestones.endDate.isNotNull() }
            .toList()
            .groupBy({ it[milestones.teamId].value }) { row ->
                val start = checkNotNull(row[milestones.startDate])
                val end = checkNotNull(row[milestones.endDate])
                LoadItem(DaySpan(start, end), row[milestones.estimateMd])
            }
        if (scheduled.isEmpty()) return emptyMap()
        val periods = TeamCapacityService.CapacityPeriods
        val byTeam = periods.selectAll().where { (periods.teamId inList scheduled.keys) and periods.active() }
            .orderBy(periods.effectiveFrom to SortOrder.ASC, periods.id to SortOrder.ASC)
            .toList()
            .groupBy({ it[periods.teamId].value }) {
                CapacityPeriod(it[periods.effectiveFrom], it[periods.mdPerWeek], it[periods.wipLimit])
            }
        return scheduled.mapValues { (teamId, items) ->
            weeklyLoad(items, byTeam[teamId].orEmpty(), loadWindow(items.map { it.span })?.span, snapshot.calendar)
        }
    }

    /** The ACTIVE person linked to [userId] (id and name) or null: at most one by the partial unique index `uq_people_user_id_active`. */
    private suspend fun linkedPerson(userId: UInt): Pair<UInt, String>? {
        val people = PersonService.People
        return people.select(people.id, people.name).where { (people.userId eq userId) and people.active() }.toList().singleOrNull()
            ?.let { it[people.id].value to it[people.name] }
    }

    /** The ACTIVE teams [personId] manages with their names and, per team, the seam's team half (the team view's `team.flags`). */
    private suspend fun managedTeams(personId: UInt, snapshot: RoadmapSnapshot): List<HomeTeamFact> {
        val teams = TeamService.Teams
        return teams.select(teams.id, teams.name).where { (teams.managerPersonId eq personId) and teams.active() }.toList().map { row ->
            val id = row[teams.id].value
            val outside = external.flagsInTransaction(
                ExternalFlagRequest(projectIds = emptyList(), milestoneIds = emptyList(), calendar = snapshot.calendar, teamId = id),
            )
            HomeTeamFact(id, row[teams.name], outside.team(id).flags)
        }
    }

    private companion object {
        /** The actor that may do nothing: the roadmap loader's `can` flags are not part of Home. */
        val NEUTRAL_ACTOR = PlanActor(isAdmin = false, personId = null, roadmapEditor = false, managedTeamIds = emptySet())
    }
}
