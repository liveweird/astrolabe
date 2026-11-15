package ch.nokillswit.planning

import ch.nokillswit.infra.db.active
import ch.nokillswit.people.PersonService
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
 * role: "yours" is what the person may manage through the owner chain (1.23), so an ADMINISTRATOR's person is looked up too (never
 * "everything").
 */
class HomeCaller(val userId: UInt)

/**
 * The Home document (`GET /views/home`, 1.18.0): ONE read-only REPEATABLE READ transaction ([SNAPSHOT], the views' protocol) that takes
 * the PLAN's revision FIRST and the rows after, takes no lock and writes nothing. It runs the roadmap's own loader
 * ([loadRoadmapSnapshot], with the actor that may do nothing: the `can` flags are not read), two selects of its own (the ACTIVE work
 * streams, and the programs with their owners' names joined in), the capacity load of EVERY team with scheduled milestones for EVERY
 * caller (the plan block's two team figures must not depend on who asks: [teamWeeks] in `TeamLoadRows.kt`, the loader the team-load
 * view runs too - the team view's own inputs, its scheduled milestones' spans and estimates, [teamCapacityRows], [loadWindow], the
 * snapshot's calendar, through [weeklyLoad]) and the caller's person: the ACTIVE `People` row linked to the login (`user_id`; the
 * login's own liveness is the per-request access check, as in `PersonService.activePersonIdOf`) and the ACTIVE teams it manages,
 * whose flags come from the roadmap loader's own answer for every team (1.23: the seam's team half is asked once, for all teams, by
 * the loader; a managed team adds no statement); a person deleted or unlinked before the snapshot began reads `me: null`. Statements:
 * the roadmap's (which includes the Flow side's one statement without an enabled connection and at most five with one), plus 2, plus 1
 * for the scheduled milestones, plus 1 for ALL the capacity periods of the teams with scheduled work, plus 1 for the person lookup
 * (every caller) and plus 1 for a caller with a person (the managed teams); `HomeViewSizeTest` pins them. Reads `WorkStreams`,
 * `Programs`, `Projects`, `People`, `Milestones`, `Teams`, `CapacityPeriods`, `Dependencies`, `RoadmapEntries` and `PublicHolidays`
 * and (through [external]) the Jira and Flow tables the seam reads (`persistence.md` matrix); nothing is written. [maxRows] caps
 * each list of `me` ([MAX_HOME_ROWS]).
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
            snapshot.projects, snapshot.facts, snapshot.checkedLinks, snapshot.milestoneFlags, teamWeeks(snapshot.calendar),
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
        val people = PersonService.People
        // The owner's name rides the same select (no `active()` filter on the person: an owner of an active program cannot be deleted).
        return programs.innerJoin(people, { programs.ownerPersonId }, { people.id })
            .select(programs.id, programs.workStreamId, programs.name, programs.ownerPersonId, people.name)
            .where { programs.active() }
            .toList()
            .map {
                HomeProgramFact(
                    it[programs.id].value, it[programs.workStreamId].value, it[programs.name], it[programs.ownerPersonId].value,
                    it[people.name],
                )
            }
    }

    /** The ACTIVE person linked to [userId] (id and name) or null: at most one by the partial unique index `uq_people_user_id_active`. */
    private suspend fun linkedPerson(userId: UInt): Pair<UInt, String>? {
        val people = PersonService.People
        return people.select(people.id, people.name).where { (people.userId eq userId) and people.active() }.toList().singleOrNull()
            ?.let { it[people.id].value to it[people.name] }
    }

    /**
     * The ACTIVE teams [personId] manages with their names and, per team, the seam's team half (the team view's `team.flags`), read from
     * the roadmap loader's answer for every team ([RoadmapSnapshot.teamFlags]): no statement per team (1.23).
     */
    private suspend fun managedTeams(personId: UInt, snapshot: RoadmapSnapshot): List<HomeTeamFact> {
        val teams = TeamService.Teams
        return teams.select(teams.id, teams.name).where { (teams.managerPersonId eq personId) and teams.active() }.toList().map { row ->
            val id = row[teams.id].value
            HomeTeamFact(id, row[teams.name], snapshot.teamFlags[id].orEmpty())
        }
    }

    private companion object {
        /** The actor that may do nothing: the roadmap loader's `can` flags are not part of Home. */
        val NEUTRAL_ACTOR = PlanActor(isAdmin = false, personId = null, roadmapEditor = false, managedTeamIds = emptySet())
    }
}
