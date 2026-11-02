package ch.nokillswit

import ch.nokillswit.planning.BaselineCreateRequest
import ch.nokillswit.planning.BaselineHeader
import ch.nokillswit.planning.BaselineList
import ch.nokillswit.planning.BaselineResponse
import ch.nokillswit.planning.DaySpan
import ch.nokillswit.planning.FrozenMilestoneRow
import ch.nokillswit.planning.FrozenProjectRow
import ch.nokillswit.planning.PlanView
import ch.nokillswit.planning.RankingUpdateRequest
import ch.nokillswit.planning.RoadmapView
import ch.nokillswit.planning.TargetWindowRequest
import ch.nokillswit.planning.activeBaseline
import ch.nokillswit.planning.frozenMilestonesOfProject
import ch.nokillswit.planning.frozenMilestonesOfTeam
import ch.nokillswit.planning.frozenProjects
import ch.nokillswit.users.UserRole
import io.ktor.client.HttpClient
import io.ktor.client.call.body
import io.ktor.client.request.delete
import io.ktor.client.request.get
import io.ktor.http.HttpStatusCode
import io.ktor.server.testing.testApplication
import org.jetbrains.exposed.v1.r2dbc.transactions.suspendTransaction
import java.sql.SQLException
import java.time.LocalDate
import kotlin.test.Test
import kotlin.test.assertContains
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertNotEquals
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * What a baseline CONTAINS (V20): the copy equals the plan row for row, the frozen rows are immutable at the database (the triggers),
 * `createdBy` resolves person-first, and the loaders the views will use read the frozen rows back. `BaselineTest` owns the registry.
 */
class BaselineCopyTest {
    private fun query(sql: String): List<List<String?>> = PostgresTestSupport.connect().use { c ->
        c.createStatement().use { st ->
            st.executeQuery(sql).use { rs ->
                buildList { while (rs.next()) add((1..rs.metaData.columnCount).map { rs.getString(it) }) }
            }
        }
    }

    private suspend fun HttpClient.roadmap(): RoadmapView = get("/api/v1/views/roadmap").body()

    @Test
    fun `the copy equals the plan - every active milestone and project row as stored, nothing deleted, the revision it left`() =
        testApplication {
            usePostgresTestcontainer()
            val w = planWorld("blc-copy", teams = true)
            val t = w.requireTeams()
            val scheduled = TestPlan.milestone(w.projectId, t.teamId, planName("ms-a"), 3.5)
            val otherTeam = TestPlan.milestone(w.projectId, t.otherTeamId, planName("ms-b"), 0.25)
            val unscheduled = TestPlan.milestone(w.projectId, t.teamId, planName("ms-u"), 12.0)
            val deletedMilestone = TestPlan.milestone(w.projectId, t.teamId, planName("ms-gone"), 1.0)
            TestPlan.schedule(scheduled, "2027-03-01", "2027-03-05")
            TestPlan.schedule(otherTeam, "2027-03-08", "2027-03-12")
            val second = TestPlan.project(w.programId, w.projectOwner.personId!!, planName("pj-second"))
            val secondMilestone = TestPlan.milestone(second, t.teamId, planName("ms-s"), 2.0)
            val deletedProject = TestPlan.project(w.programId, w.projectOwner.personId!!, planName("pj-gone"))
            assertEquals(HttpStatusCode.NoContent, w.projectOwner.client.delete("/api/v1/milestones/$deletedMilestone").status)
            assertEquals(HttpStatusCode.NoContent, w.projectOwner.client.delete("/api/v1/projects/$deletedProject").status)
            val window = TargetWindowRequest("2027-03-01", "2027-04-30")
            assertEquals(HttpStatusCode.NoContent, w.admin.client.putJson("/api/v1/projects/${w.projectId}/target-window", window).status)
            // Rank our project last, keeping everybody else's position (the ranking is shared state; never rewrite it blindly).
            val before = w.admin.client.roadmap()
            val ranking = RankingUpdateRequest(before.revision, before.ranked.map { it.project.id } + w.projectId)
            assertEquals(HttpStatusCode.OK, w.admin.client.putJson("/api/v1/roadmap/ranking", ranking).status)

            val response = w.editor.client.postJson("/api/v1/baselines", BaselineCreateRequest(planName("blc-copy")))
            val baseline = response.body<BaselineResponse>()
            try {
                val view = w.admin.client.roadmap()
                val plan = w.admin.client.get("/api/v1/views/plan").body<PlanView>()
                assertEquals(plan.revision, baseline.planRevision, "the plan equals the baseline at the revision its creation left")
                assertEquals(TestPlan.revision(), baseline.planRevision)

                val projects = (view.ranked.map { it.project } + view.unranked).sortedBy { it.id }
                val expectedProjects = projects.map { p ->
                    listOf(
                        p.id, p.programId, p.workStreamId, p.name, p.programName, p.workStreamName, p.rankPosition, p.targetStart,
                        p.targetEnd, p.span?.start, p.span?.end,
                    ).map { it?.toString() }
                }
                val frozenProjects = query(
                    "SELECT project_id, program_id, work_stream_id, name, program_name, work_stream_name, rank_position, target_start, " +
                        "target_end, span_start, span_end FROM baseline_projects WHERE baseline_id = ${baseline.id} ORDER BY project_id",
                )
                assertEquals(expectedProjects, frozenProjects, "every active project, as the roadmap shows it")
                assertEquals(projects.size, baseline.projectCount)
                assertTrue(frozenProjects.none { it[0] == deletedProject.toString() }, "a soft-deleted project is absent")
                val ours = frozenProjects.single { it[0] == w.projectId.toString() }
                val windowAndSpan = listOf("2027-03-01", "2027-04-30", "2027-03-01", "2027-03-12")
                assertEquals(windowAndSpan, ours.subList(7, 11), "target window and derived span")
                assertEquals(projects.last { it.id == w.projectId }.rankPosition.toString(), ours[6], "the rank position")
                assertNotNull(frozenProjects.singleOrNull { it[0] == second.toString() }, "the unranked second project is present")
                assertNull(frozenProjects.single { it[0] == second.toString() }[6], "unranked = no rank position")

                val expectedMilestones = query(
                    "SELECT id, project_id, team_id, name, estimate_md, start_date, end_date FROM milestones " +
                        "WHERE NOT marked_as_deleted ORDER BY id",
                )
                val frozenMilestones = query(
                    "SELECT milestone_id, project_id, team_id, name, estimate_md, start_date, end_date FROM baseline_milestones " +
                        "WHERE baseline_id = ${baseline.id} ORDER BY milestone_id",
                )
                assertEquals(expectedMilestones, frozenMilestones, "every active milestone with its stored values")
                assertEquals(expectedMilestones.size, baseline.milestoneCount)
                assertTrue(frozenMilestones.none { it[0] == deletedMilestone.toString() }, "a soft-deleted milestone is absent")
                assertEquals(
                    listOf(unscheduled.toString(), null, null),
                    frozenMilestones.single { it[0] == unscheduled.toString() }.let { listOf(it[0], it[5], it[6]) },
                    "an unscheduled milestone keeps null dates",
                )
                assertEquals("0.25", frozenMilestones.single { it[0] == otherTeam.toString() }[4], "the estimate at scale two")
                assertEquals(t.otherTeamId.toString(), frozenMilestones.single { it[0] == otherTeam.toString() }[2])
                assertNotNull(frozenMilestones.singleOrNull { it[0] == secondMilestone.toString() })
            } finally {
                TestPlan.deleteBaseline(baseline.id)
            }
        }

    @Test
    fun `createdBy is the person's name, else the display name (never the email), and null once the login is gone`() = testApplication {
        usePostgresTestcontainer()
        val w = planWorld("blc-by")
        val withPerson = planCaller("blc-person", UserRole.ADMIN)
        val withoutPerson = planCaller("blc-nobody", UserRole.ADMIN, withPerson = false)
        val ids = mutableListOf<UInt>()
        try {
            val personName = TestPlan.scalar("SELECT name FROM people WHERE id = ${withPerson.personId}") { it.getString(1) }
            val email = TestPlan.scalar("SELECT email FROM users WHERE id = ${withoutPerson.userId}") { it.getString(1) }
            execSql("UPDATE users SET name = 'Plain Display' WHERE id IN (${withoutPerson.userId}, ${withPerson.userId})")
            val namedRequest = BaselineCreateRequest(planName("blc-by-a"))
            val named = withPerson.client.postJson("/api/v1/baselines", namedRequest).body<BaselineResponse>()
            ids += named.id
            val bareRequest = BaselineCreateRequest(planName("blc-by-b"))
            val bare = withoutPerson.client.postJson("/api/v1/baselines", bareRequest).body<BaselineResponse>()
            ids += bare.id
            assertEquals(withPerson.userId, named.createdBy?.userId)
            assertEquals(personName, named.createdBy?.name, "the ACTIVE linked person's name")
            assertEquals(withoutPerson.userId, bare.createdBy?.userId)
            assertEquals("Plain Display", bare.createdBy?.name, "no person: the login's display name")
            assertNotEquals(email, bare.createdBy?.name, "never the email")

            // A soft-deleted person falls back to the display name too; a soft-deleted login reads as null.
            TestPeople.softDelete(withPerson.personId!!)
            val afterPersonGone = w.admin.client.get("/api/v1/baselines/${named.id}").body<BaselineResponse>().createdBy?.name
            assertEquals("Plain Display", afterPersonGone, "a deleted person is not a name")
            TestUsers.softDelete(withoutPerson.userId)
            assertNull(w.admin.client.get("/api/v1/baselines/${bare.id}").body<BaselineResponse>().createdBy, "the login is gone")
            val listed = w.admin.client.get("/api/v1/baselines").body<BaselineList>().items
            assertNull(listed.single { it.id == bare.id }.createdBy)
            assertNotNull(listed.single { it.id == named.id }.createdBy)
        } finally {
            ids.forEach { TestPlan.deleteBaseline(it) }
        }
    }

    private fun execSql(sql: String): Int = PostgresTestSupport.connect().use { c -> c.createStatement().use { it.executeUpdate(sql) } }

    @Test
    fun `the frozen rows and the header are protected at the database - UPDATE, DELETE and TRUNCATE are refused, a rename is not`() =
        testApplication {
            usePostgresTestcontainer()
            val w = planWorld("blc-frozen", teams = true)
            TestPlan.milestone(w.projectId, w.requireTeams().teamId)
            val id = TestPlan.baseline(planName("blc-frozen"))
            try {
                val rows = "baseline_id = $id"
                val frozen = listOf(
                    "UPDATE baseline_projects SET name = 'tampered' WHERE $rows" to "UPDATE on baseline_projects",
                    "DELETE FROM baseline_projects WHERE $rows" to "DELETE on baseline_projects",
                    "UPDATE baseline_milestones SET estimate_md = 99 WHERE $rows" to "UPDATE on baseline_milestones",
                    "DELETE FROM baseline_milestones WHERE $rows" to "DELETE on baseline_milestones",
                    "TRUNCATE baseline_projects" to "TRUNCATE on baseline_projects",
                    "TRUNCATE baseline_milestones" to "TRUNCATE on baseline_milestones",
                    // The FK stops a plain TRUNCATE of the header before any trigger; CASCADE reaches the triggers.
                    "TRUNCATE baselines CASCADE" to "TRUNCATE on baseline",
                )
                val projects = query("SELECT count(*) FROM baseline_projects WHERE $rows").single().single()
                val milestones = query("SELECT count(*) FROM baseline_milestones WHERE $rows").single().single()
                for ((sql, what) in frozen) {
                    val failure = assertFailsWith<SQLException>(sql) { execSql(sql) }
                    assertContains(failure.message.orEmpty(), "baseline rows are frozen", message = sql)
                    assertContains(failure.message.orEmpty(), what, message = sql)
                }
                assertEquals(projects, query("SELECT count(*) FROM baseline_projects WHERE $rows").single().single())
                assertEquals(milestones, query("SELECT count(*) FROM baseline_milestones WHERE $rows").single().single())
                assertEquals(listOf(listOf("0")), query("SELECT count(*) FROM baseline_projects WHERE $rows AND name = 'tampered'"))

                // The header: the capture facts never change, and a row is never hard-deleted.
                for (change in listOf(
                    "plan_revision = plan_revision + 1", "milestone_count = milestone_count + 1", "project_count = project_count + 1",
                    "created_at = created_at + 1", "created_by_user_id = NULL", "id = id + 100000",
                )) {
                    val failure = assertFailsWith<SQLException>(change) { execSql("UPDATE baselines SET $change WHERE id = $id") }
                    assertContains(failure.message.orEmpty(), "baseline header columns are frozen", message = change)
                }
                val noDelete = assertFailsWith<SQLException> { execSql("DELETE FROM baselines WHERE id = $id") }
                assertContains(noDelete.message.orEmpty(), "baselines are soft-deleted only")
                assertEquals(listOf(listOf("1")), query("SELECT count(*) FROM baselines WHERE id = $id"), "the header survived")

                // What stays writable: name, description, updated_at and the soft-delete flag (the registry's rename and delete).
                val rename = "name = '${planName("blc-renamed")}', description = 'd', updated_at = updated_at + 1"
                assertEquals(1, execSql("UPDATE baselines SET $rename WHERE id = $id"))
                assertEquals(HttpStatusCode.NoContent, w.admin.client.delete("/api/v1/baselines/$id").status, "the soft delete")
            } finally {
                TestPlan.deleteBaseline(id)
            }
        }

    @Test
    fun `the loaders read the frozen rows back - the header, the projects and the milestones of a project and of a team`() =
        testApplication {
            usePostgresTestcontainer()
            val w = planWorld("blc-load", teams = true)
            val t = w.requireTeams()
            val a = TestPlan.milestone(w.projectId, t.teamId, planName("ms-a"), 2.5)
            val b = TestPlan.milestone(w.projectId, t.otherTeamId, planName("ms-b"), 1.0)
            TestPlan.schedule(a, "2027-05-03", "2027-05-07")
            val id = TestPlan.baseline(planName("blc-load"))
            try {
                val loaded = suspendTransaction(sharedDatabaseForTests()) {
                    Loaded(
                        header = activeBaseline(id),
                        projects = frozenProjects(id),
                        ofProject = frozenMilestonesOfProject(id, w.projectId),
                        ofTeam = frozenMilestonesOfTeam(id, t.teamId),
                    )
                }
                val header = assertNotNull(loaded.header)
                assertEquals(id, header.id)
                assertEquals(header.projectCount, loaded.projects.size)
                val ours = loaded.projects.single { it.id == w.projectId }
                assertEquals(w.programId, ours.programId)
                assertEquals(w.streamId, ours.workStreamId)
                assertEquals(DaySpan(LocalDate.parse("2027-05-03"), LocalDate.parse("2027-05-07")), ours.span)
                assertNull(ours.target)
                assertEquals(listOf(a, b), loaded.ofProject.map { it.id }, "the project's milestones, by id")
                assertEquals(java.math.BigDecimal("2.50"), loaded.ofProject.first().estimateMd)
                assertNull(loaded.ofProject.last().span, "unscheduled at the time")
                assertEquals(listOf(a), loaded.ofTeam.map { it.id }, "the team's milestones only")
                TestPlan.deleteBaseline(id)
                val gone = suspendTransaction(sharedDatabaseForTests()) { activeBaseline(id) }
                assertNull(gone, "a deleted baseline is not active")
            } finally {
                TestPlan.deleteBaseline(id)
            }
        }

    private class Loaded(
        val header: BaselineHeader?,
        val projects: List<FrozenProjectRow>,
        val ofProject: List<FrozenMilestoneRow>,
        val ofTeam: List<FrozenMilestoneRow>,
    )
}
