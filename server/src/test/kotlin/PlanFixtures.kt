package ch.nokillswit

import ch.nokillswit.planning.ProgramCreateRequest
import ch.nokillswit.planning.ProgramService
import ch.nokillswit.planning.ProjectCreateRequest
import ch.nokillswit.planning.ProjectService
import ch.nokillswit.planning.WorkStreamCreateRequest
import ch.nokillswit.planning.WorkStreamService
import ch.nokillswit.users.Permission
import ch.nokillswit.users.UserRole
import io.ktor.client.HttpClient
import io.ktor.server.testing.ApplicationTestBuilder
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
) {
    /** Everyone who owns nothing on the chain. */
    val outsiders: List<Pair<String, PlanCaller>> get() = listOf("stranger" to stranger, "personless" to personless, "editor" to editor)
}

suspend fun ApplicationTestBuilder.planWorld(prefix: String): PlanWorld {
    val streamOwner = planCaller("$prefix-so")
    val programOwner = planCaller("$prefix-po")
    val projectOwner = planCaller("$prefix-jo")
    val editor = planCaller("$prefix-ed")
    TestUsers.service.replacePermissions(editor.userId, setOf(Permission.ROADMAP_EDITOR))
    val streamId = TestPlan.workStream(streamOwner.personId!!)
    val programId = TestPlan.program(streamId, programOwner.personId!!)
    val projectId = TestPlan.project(programId, projectOwner.personId!!)
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
    )
}

/** Direct plan fixtures: quick seeding past the routes (the services, so the plan lock and the revision bump still apply) and raw reads. */
object TestPlan {
    private val streams by lazy { WorkStreamService(sharedDatabaseForTests()) }
    private val programs by lazy { ProgramService(sharedDatabaseForTests()) }
    private val projects by lazy { ProjectService(sharedDatabaseForTests()) }

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
