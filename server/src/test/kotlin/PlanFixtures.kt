package ch.nokillswit

import ch.nokillswit.planning.DependencyCreateRequest
import ch.nokillswit.planning.DependencyService
import ch.nokillswit.planning.DependencyType
import ch.nokillswit.planning.EndpointKind
import ch.nokillswit.planning.EndpointRef
import ch.nokillswit.planning.MilestoneCreateRequest
import ch.nokillswit.planning.MilestoneScheduleRequest
import ch.nokillswit.planning.MilestoneService
import ch.nokillswit.planning.ProgramCreateRequest
import ch.nokillswit.planning.ProgramService
import ch.nokillswit.planning.ProjectCreateRequest
import ch.nokillswit.planning.ProjectService
import ch.nokillswit.planning.WorkStreamCreateRequest
import ch.nokillswit.planning.WorkStreamService
import ch.nokillswit.teams.CapacityPeriodValues
import ch.nokillswit.teams.TeamCapacityService
import ch.nokillswit.users.Permission
import ch.nokillswit.users.UserRole
import io.ktor.client.HttpClient
import io.ktor.client.statement.HttpResponse
import io.ktor.server.testing.ApplicationTestBuilder
import kotlinx.coroutines.async
import kotlinx.coroutines.coroutineScope
import java.sql.Connection
import java.util.UUID

/** A name unique across the suite: stream and program names are GLOBALLY unique among active rows and the plan tables are shared state. */
fun planName(prefix: String): String = "$prefix-${UUID.randomUUID().toString().substring(0, 8)}"

/** A signed-in plan caller: a seeded user, its client, and the ACTIVE person linked to it (null for a person-less login). */
class PlanCaller(val client: HttpClient, val userId: UInt, val personId: UInt?)

/** Seeds a unique throwaway user (and, unless [withPerson] is false, a person linked to it) and logs it in. */
suspend fun ApplicationTestBuilder.planCaller(prefix: String, role: UserRole = UserRole.USER, withPerson: Boolean = true): PlanCaller {
    val email = uniqueEmail(prefix)
    val userId = TestUsers.seed(email = email, password = "pw", role = role)
    val personId = if (withPerson) TestPeople.seed(planName(prefix), userId) else null
    return PlanCaller(authedClient(email, "pw"), userId, personId)
}

/** The teams of a [PlanWorld] built with `teams = true`: two teams, each managed by its own login (a person linked to a user). */
class PlanTeams(val manager: PlanCaller, val otherManager: PlanCaller, val teamId: UInt, val otherTeamId: UInt)

/**
 * The standard plan world for the authorization matrix: one work stream -> program -> project chain, each owned by its own person,
 * and every kind of caller — ADMIN, the three owners, a stranger with a person, a person-less login and a `ROADMAP_EDITOR` holder
 * (who owns nothing).
 */
class PlanWorld(
    val admin: PlanCaller,
    val streamOwner: PlanCaller,
    val programOwner: PlanCaller,
    val projectOwner: PlanCaller,
    val stranger: PlanCaller,
    val personless: PlanCaller,
    val editor: PlanCaller,
    val streamId: UInt,
    val programId: UInt,
    val projectId: UInt,
    val teams: PlanTeams? = null,
) {
    /** The teams and their managers; only a world built with `planWorld(prefix, teams = true)` has them. */
    fun requireTeams(): PlanTeams = checkNotNull(teams) { "build the world with planWorld(prefix, teams = true)" }

    /** Everyone who owns nothing on the chain. */
    val outsiders: List<Pair<String, PlanCaller>> get() = listOf("stranger" to stranger, "personless" to personless, "editor" to editor)
}

suspend fun ApplicationTestBuilder.planWorld(prefix: String, teams: Boolean = false): PlanWorld {
    val streamOwner = planCaller("$prefix-so")
    val programOwner = planCaller("$prefix-po")
    val projectOwner = planCaller("$prefix-jo")
    val editor = planCaller("$prefix-ed")
    TestUsers.service.replacePermissions(editor.userId, setOf(Permission.ROADMAP_EDITOR))
    val streamId = TestPlan.workStream(streamOwner.personId!!)
    val programId = TestPlan.program(streamId, programOwner.personId!!)
    val projectId = TestPlan.project(programId, projectOwner.personId!!)
    val planTeams = if (teams) {
        val manager = planCaller("$prefix-mg")
        val otherManager = planCaller("$prefix-om")
        PlanTeams(
            manager = manager,
            otherManager = otherManager,
            teamId = TestTeams.seed(planName("$prefix-team"), manager.personId),
            otherTeamId = TestTeams.seed(planName("$prefix-other"), otherManager.personId),
        )
    } else {
        null
    }
    return PlanWorld(
        admin = planCaller("$prefix-ad", UserRole.ADMIN, withPerson = false),
        streamOwner = streamOwner,
        programOwner = programOwner,
        projectOwner = projectOwner,
        stranger = planCaller("$prefix-st"),
        personless = planCaller("$prefix-pl", withPerson = false),
        editor = editor,
        streamId = streamId,
        programId = programId,
        projectId = projectId,
        teams = planTeams,
    )
}

fun milestoneRef(id: UInt) = EndpointRef(EndpointKind.MILESTONE, id)

fun projectRef(id: UInt) = EndpointRef(EndpointKind.PROJECT, id)

/** `POST /projects/{projectId}/dependencies` with a typed body — the link's SUCCESSOR must be that project or one of its milestones. */
suspend fun HttpClient.postDependency(
    projectId: UInt,
    predecessor: EndpointRef,
    successor: EndpointRef,
    type: DependencyType = DependencyType.FS,
    lagDays: Int = 0,
): HttpResponse = postJson("/api/v1/projects/$projectId/dependencies", DependencyCreateRequest(predecessor, successor, type, lagDays))

/** A second project under the world's program, owned by a NEW caller (a person-linked login) who owns nothing else: cross-owner cases. */
class SecondProject(val projectId: UInt, val owner: PlanCaller)

/** Seeds [SecondProject] under [w]'s program: its owner is a fresh stranger to the world's own project and the cast above it. */
suspend fun ApplicationTestBuilder.secondProject(w: PlanWorld, prefix: String = "sp"): SecondProject {
    val owner = planCaller("$prefix-jo2")
    return SecondProject(TestPlan.project(w.programId, owner.personId!!), owner)
}

/** Direct plan fixtures: quick seeding past the routes (the services, so the plan lock and the revision bump still apply) and raw reads. */
object TestPlan {
    private val streams by lazy { WorkStreamService(sharedDatabaseForTests()) }
    private val programs by lazy { ProgramService(sharedDatabaseForTests()) }
    private val projects by lazy { ProjectService(sharedDatabaseForTests()) }
    private val milestones by lazy { MilestoneService(sharedDatabaseForTests()) }
    private val dependencies by lazy { DependencyService(sharedDatabaseForTests()) }
    private val capacity by lazy { TeamCapacityService(sharedDatabaseForTests()) }

    suspend fun workStream(owner: UInt, name: String = planName("ws"), startDate: String = "2026-01-01", endDate: String? = null): UInt =
        streams.create(WorkStreamCreateRequest(name = name, ownerPersonId = owner, startDate = startDate, endDate = endDate))

    suspend fun program(workStreamId: UInt, owner: UInt, name: String = planName("pg")): UInt =
        programs.create(workStreamId, ProgramCreateRequest(name = name, ownerPersonId = owner)) { }

    suspend fun project(
        programId: UInt,
        owner: UInt,
        name: String = planName("pj"),
        targetStart: String? = null,
        targetEnd: String? = null,
    ): UInt = projects.create(
        programId,
        ProjectCreateRequest(name = name, ownerPersonId = owner, targetStart = targetStart, targetEnd = targetEnd),
    ) { } // fixtures seed past the guard

    /** An UNSCHEDULED milestone under [projectId] for [teamId], through the service (the plan lock and the revision bump apply). */
    suspend fun milestone(projectId: UInt, teamId: UInt, name: String = planName("ms"), estimate: Double = 2.0): UInt =
        milestones.create(projectId, MilestoneCreateRequest(name = name, teamId = teamId, estimateMd = estimate)) { } // past the guard

    /** Schedules (or, with null dates, unschedules) a milestone past the guard; the answer is the plan revision it left behind. */
    suspend fun schedule(milestoneId: UInt, start: String?, end: String?): Long =
        milestones.schedule(milestoneId, MilestoneScheduleRequest(revision(), start, end)) { }.revision

    /**
     * A dependency [predecessor] -> [successor] past the guard (the service: the plan lock, the cycle check and the revision bump apply).
     * The path project is derived from the successor, as the route's authorization does.
     */
    suspend fun dependency(
        predecessor: EndpointRef,
        successor: EndpointRef,
        type: DependencyType = DependencyType.FS,
        lag: Int = 0,
    ): UInt {
        val projectId = when (successor.kind) {
            EndpointKind.PROJECT -> successor.id
            EndpointKind.MILESTONE -> scalar("SELECT project_id FROM milestones WHERE id = ${successor.id}") { it.getInt(1) }.toUInt()
        }
        return dependencies.create(projectId, DependencyCreateRequest(predecessor, successor, type, lag)) { } // past the guard
    }

    /**
     * A capacity period of [teamId] from [effectiveFrom] (ISO, any date) past the guard — through the service, so the team row lock and the
     * partial index apply. Capacity is team data: no plan revision moves.
     */
    suspend fun capacityPeriod(teamId: UInt, effectiveFrom: String, mdPerWeek: Double, wipLimit: Int? = null): UInt =
        capacity.create(
            teamId,
            CapacityPeriodValues(java.time.LocalDate.parse(effectiveFrom), java.math.BigDecimal.valueOf(mdPerWeek).setScale(2), wipLimit),
        ) { } // fixtures seed past the guard

    /** The current `plan_state.revision`, read over raw JDBC. */
    fun revision(): Long = PostgresTestSupport.connect().use { c ->
        c.createStatement().use { st ->
            st.executeQuery("SELECT revision FROM plan_state WHERE id = 1").use { rs ->
                rs.next()
                rs.getLong(1)
            }
        }
    }

    /** One raw scalar query (the soft-delete and stored-value assertions). */
    fun <T> scalar(sql: String, read: (java.sql.ResultSet) -> T): T = PostgresTestSupport.connect().use { c ->
        c.createStatement().use { st ->
            st.executeQuery(sql).use { rs ->
                rs.next()
                read(rs)
            }
        }
    }
}

/**
 * Holds `plan_state FOR UPDATE` on a raw session, starts [request] (it passes the route's outer guard, then waits at the lock),
 * runs [mutate] on the raw session and commits — the committed change is what the request's re-guard under the lock must see.
 */
suspend fun requestHeldAtPlanLock(request: suspend () -> HttpResponse, mutate: (Connection) -> Unit): HttpResponse {
    PostgresTestSupport.connect().use { raw ->
        raw.autoCommit = false
        raw.createStatement().use { it.executeQuery("SELECT revision FROM plan_state WHERE id = 1 FOR UPDATE").close() }
        try {
            return coroutineScope {
                val pending = async { request() }
                awaitLockWait("plan_state")
                mutate(raw)
                raw.commit()
                pending.await()
            }
        } finally {
            raw.rollback()
        }
    }
}

/** One raw prepared statement with int parameters (the mid-request mutations of [requestHeldAtPlanLock]). */
fun Connection.exec(sql: String, vararg ints: Int) {
    prepareStatement(sql).use { st ->
        ints.forEachIndexed { index, value -> st.setInt(index + 1, value) }
        st.executeUpdate()
    }
}
