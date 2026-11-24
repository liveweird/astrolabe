package ch.nokillswit

import ch.nokillswit.planning.BaselineCapacityFigure
import ch.nokillswit.planning.BaselineCreateRequest
import ch.nokillswit.planning.BaselineList
import ch.nokillswit.planning.BaselineResponse
import ch.nokillswit.planning.BaselineUpdateRequest
import ch.nokillswit.planning.BaselineView
import ch.nokillswit.planning.DependencyType
import ch.nokillswit.planning.EndpointKind
import ch.nokillswit.planning.LinkChangeKind
import io.ktor.client.HttpClient
import io.ktor.client.call.body
import io.ktor.client.request.delete
import io.ktor.client.request.get
import io.ktor.http.HttpStatusCode
import io.ktor.server.testing.testApplication
import java.sql.SQLException
import kotlin.test.Test
import kotlin.test.assertContains
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue

/** The columns a 1.25 build writes for a baseline header (no V33 counts: they stay NULL). */
private const val OLD_COLUMNS = "(name, plan_revision, milestone_count, project_count, created_at, updated_at)"

/**
 * What a baseline freezes besides the dated structure (V33, 1.26): every ACTIVE link and every ACTIVE capacity period of an ACTIVE team,
 * copied row for row and immune to later edits, the triggers on the two new tables and the two counts, a baseline taken before 1.26 (NULL
 * counts) reading "not captured", and the comparison view's `links` and `capacity` blocks - live and with `?against=`. The pure
 * arithmetic is `BaselineLinkKernelsTest`'s and `BaselineCapacityKernelsTest`'s; the overlays' additions are
 * `ProjectViewBaselineTest`'s and `TeamViewBaselineTest`'s. The shared plan is global, so every assertion is anchored on this test's
 * own rows.
 */
class BaselineCaptureTest {
    private fun query(sql: String): List<List<String?>> = PostgresTestSupport.connect().use { c ->
        c.createStatement().use { st ->
            st.executeQuery(sql).use { rs ->
                buildList { while (rs.next()) add((1..rs.metaData.columnCount).map { rs.getString(it) }) }
            }
        }
    }

    private fun execSql(sql: String): Int = PostgresTestSupport.connect().use { c -> c.createStatement().use { it.executeUpdate(sql) } }

    private suspend fun HttpClient.take(name: String): BaselineResponse =
        postJson("/api/v1/baselines", BaselineCreateRequest(name)).body()

    private suspend fun HttpClient.compare(id: UInt, against: UInt? = null): BaselineView =
        get("/api/v1/views/baseline/$id" + (against?.let { "?against=$it" } ?: "")).body()

    private fun nameOfProject(id: UInt) = TestPlan.scalar("SELECT name FROM projects WHERE id = $id") { it.getString(1) }

    private fun milestoneName(id: UInt) = TestPlan.scalar("SELECT name FROM milestones WHERE id = $id") { it.getString(1) }

    private fun figure(figure: BaselineCapacityFigure?) = "${figure?.mdPerWeek}/${figure?.wipLimit}"

    private val liveLinks = "SELECT id, pred_milestone_id, pred_project_id, succ_milestone_id, succ_project_id, \"type\", lag_days " +
        "FROM dependencies WHERE NOT marked_as_deleted ORDER BY id"

    private val liveCapacity = "SELECT p.id, p.team_id, p.effective_from, p.md_per_week, p.wip_limit FROM team_capacity_periods p " +
        "JOIN teams t ON t.id = p.team_id WHERE NOT p.marked_as_deleted AND NOT t.marked_as_deleted " +
        "ORDER BY p.team_id, p.effective_from, p.id"

    private fun frozenLinks(id: UInt) = query(
        "SELECT dependency_id, pred_milestone_id, pred_project_id, succ_milestone_id, succ_project_id, \"type\", lag_days " +
            "FROM baseline_dependencies WHERE baseline_id = $id ORDER BY dependency_id",
    )

    private fun frozenCapacity(id: UInt) = query(
        "SELECT period_id, team_id, effective_from, md_per_week, wip_limit FROM baseline_capacity_periods " +
            "WHERE baseline_id = $id ORDER BY team_id, effective_from, period_id",
    )

    @Test
    fun `the copy equals the live links and capacity periods, the counts equal the rows, and later edits never reach it`() =
        testApplication {
            usePostgresTestcontainer()
            val w = planWorld("bcc", teams = true)
            val t = w.requireTeams()
            val a = TestPlan.milestone(w.projectId, t.teamId, planName("ms-a"))
            val b = TestPlan.milestone(w.projectId, t.teamId, planName("ms-b"))
            val c = TestPlan.milestone(w.projectId, t.teamId, planName("ms-c"))
            val second = TestPlan.project(w.programId, w.projectOwner.personId!!, planName("pj-second"))
            val d = TestPlan.milestone(second, t.otherTeamId, planName("ms-d"))
            val l1 = TestPlan.dependency(milestoneRef(a), milestoneRef(b))
            val l2 = TestPlan.dependency(milestoneRef(b), projectRef(second), DependencyType.SS, 3)
            val l3 = TestPlan.dependency(projectRef(w.projectId), milestoneRef(d), DependencyType.FF, -2)
            val deletedLink = TestPlan.dependency(milestoneRef(a), milestoneRef(c))
            assertEquals(HttpStatusCode.NoContent, w.admin.client.delete("/api/v1/dependencies/$deletedLink").status)
            val p1 = TestPlan.capacityPeriod(t.teamId, "2027-03-01", 12.5, 3)
            val p2 = TestPlan.capacityPeriod(t.teamId, "2027-06-01", 8.0)
            val p3 = TestPlan.capacityPeriod(t.otherTeamId, "2027-03-01", 0.0)
            val deletedPeriod = TestPlan.capacityPeriod(t.teamId, "2027-09-01", 5.0)
            assertEquals(1, execSql("UPDATE team_capacity_periods SET marked_as_deleted = TRUE WHERE id = $deletedPeriod"))

            val baseline = w.editor.client.take(planName("bcc"))
            try {
                val links = frozenLinks(baseline.id)
                assertEquals(query(liveLinks), links, "every active link as stored")
                assertEquals(links.size, baseline.dependencyCount)
                assertEquals(
                    listOf(l1, a, null, b, null, "FS", "0").map { it?.toString() },
                    links.single { it[0] == l1.toString() },
                    "a milestone-to-milestone link",
                )
                assertEquals(
                    listOf(l2, b, null, null, second, "SS", "3").map { it?.toString() },
                    links.single { it[0] == l2.toString() },
                    "a milestone predecessor, a project successor",
                )
                assertEquals(
                    listOf(l3, null, w.projectId, d, null, "FF", "-2").map { it?.toString() },
                    links.single { it[0] == l3.toString() },
                    "a project predecessor, a milestone successor, a lead",
                )
                assertTrue(links.none { it[0] == deletedLink.toString() }, "a soft-deleted link is absent")

                val periods = frozenCapacity(baseline.id)
                assertEquals(query(liveCapacity), periods, "every active period of every active team as stored")
                assertEquals(periods.size, baseline.capacityPeriodCount)
                val teamId = t.teamId.toString()
                assertEquals(listOf(p1.toString(), teamId, "2027-03-01", "12.50", "3"), periods.single { it[0] == p1.toString() })
                assertEquals(listOf(p2.toString(), teamId, "2027-06-01", "8.00", null), periods.single { it[0] == p2.toString() })
                assertEquals("0.00", periods.single { it[0] == p3.toString() }[3], "zero is a figure")
                assertTrue(periods.none { it[0] == deletedPeriod.toString() }, "a soft-deleted period is absent")

                // The registry answers the counts, on the create, the read and the list.
                assertEquals(links.size, w.stranger.client.get("/api/v1/baselines/${baseline.id}").body<BaselineResponse>().dependencyCount)
                val listed = w.stranger.client.get("/api/v1/baselines").body<BaselineList>().items.single { it.id == baseline.id }
                assertEquals(periods.size, listed.capacityPeriodCount)

                // Later edits - a lag, a deleted link, a cut and a removed period - never reach the frozen rows.
                assertEquals(HttpStatusCode.NoContent, w.admin.client.putDependency(l2, DependencyType.FS, 1).status)
                assertEquals(HttpStatusCode.NoContent, w.admin.client.delete("/api/v1/dependencies/$l3").status)
                execSql("UPDATE team_capacity_periods SET md_per_week = 1, wip_limit = NULL WHERE id = $p1")
                execSql("UPDATE team_capacity_periods SET marked_as_deleted = TRUE WHERE id = $p2")
                assertEquals(links, frozenLinks(baseline.id))
                assertEquals(periods, frozenCapacity(baseline.id))
            } finally {
                TestPlan.deleteBaseline(baseline.id)
            }
        }

    @Test
    fun `the two new tables and the two counts are frozen at the database - UPDATE, DELETE and TRUNCATE are refused`() = testApplication {
        usePostgresTestcontainer()
        val w = planWorld("bcf", teams = true)
        val t = w.requireTeams()
        val a = TestPlan.milestone(w.projectId, t.teamId)
        TestPlan.dependency(milestoneRef(a), milestoneRef(TestPlan.milestone(w.projectId, t.teamId)))
        TestPlan.capacityPeriod(t.teamId, "2027-03-01", 5.0)
        val id = TestPlan.baseline(planName("bcf"))
        try {
            val rows = "baseline_id = $id"
            val frozen = listOf(
                "UPDATE baseline_dependencies SET lag_days = 9 WHERE $rows" to "UPDATE on baseline_dependencies",
                "DELETE FROM baseline_dependencies WHERE $rows" to "DELETE on baseline_dependencies",
                "UPDATE baseline_capacity_periods SET md_per_week = 99 WHERE $rows" to "UPDATE on baseline_capacity_periods",
                "DELETE FROM baseline_capacity_periods WHERE $rows" to "DELETE on baseline_capacity_periods",
                "TRUNCATE baseline_dependencies" to "TRUNCATE on baseline_dependencies",
                "TRUNCATE baseline_capacity_periods" to "TRUNCATE on baseline_capacity_periods",
            )
            val links = query("SELECT count(*) FROM baseline_dependencies WHERE $rows").single().single()
            val periods = query("SELECT count(*) FROM baseline_capacity_periods WHERE $rows").single().single()
            assertTrue(links != "0" && periods != "0", "the baseline holds rows of both tables")
            for ((sql, what) in frozen) {
                val failure = assertFailsWith<SQLException>(sql) { execSql(sql) }
                assertContains(failure.message.orEmpty(), "baseline rows are frozen", message = sql)
                assertContains(failure.message.orEmpty(), what, message = sql)
            }
            assertEquals(links, query("SELECT count(*) FROM baseline_dependencies WHERE $rows").single().single())
            assertEquals(periods, query("SELECT count(*) FROM baseline_capacity_periods WHERE $rows").single().single())

            for (change in listOf(
                "dependency_count = dependency_count + 1",
                "capacity_period_count = capacity_period_count + 1",
                "dependency_count = NULL, capacity_period_count = NULL",
            )) {
                val failure = assertFailsWith<SQLException>(change) { execSql("UPDATE baselines SET $change WHERE id = $id") }
                assertContains(failure.message.orEmpty(), "baseline header columns are frozen", message = change)
            }
            // V20's guard still guards what it guarded, and the writable columns stay writable.
            assertFailsWith<SQLException> { execSql("UPDATE baselines SET milestone_count = milestone_count + 1 WHERE id = $id") }
            assertEquals(1, execSql("UPDATE baselines SET description = 'd', updated_at = updated_at + 1 WHERE id = $id"))
        } finally {
            TestPlan.deleteBaseline(id)
        }
    }

    @Test
    fun `a baseline taken before 1_26 has NULL counts and reads not captured everywhere - and the two counts are set together`() =
        testApplication {
            usePostgresTestcontainer()
            val w = planWorld("bco", teams = true)
            val t = w.requireTeams()
            val name = planName("bco-old")
            // What a 1.25 build writes on this schema: a header without the two counts (NULL), no rows in the new tables.
            execSql("INSERT INTO baselines $OLD_COLUMNS VALUES ('$name', 1, 0, 0, 1, 1)")
            val old = query("SELECT id FROM baselines WHERE name = '$name'").single().single()!!.toUInt()
            val current = w.editor.client.take(planName("bco-new"))
            try {
                val half = assertFailsWith<SQLException> {
                    execSql(
                        "INSERT INTO baselines (name, plan_revision, milestone_count, project_count, dependency_count, created_at, " +
                            "updated_at) VALUES ('${planName("bco-half")}', 1, 0, 0, 1, 1, 1)",
                    )
                }
                assertContains(half.message.orEmpty(), "ck_baselines_capture_counts")
                val read = w.stranger.client.get("/api/v1/baselines/$old").body<BaselineResponse>()
                assertNull(read.dependencyCount)
                assertNull(read.capacityPeriodCount)
                assertNotNull(w.stranger.client.get("/api/v1/baselines").body<BaselineList>().items.single { it.id == old })
                val rename = w.editor.client.putJson("/api/v1/baselines/$old", BaselineUpdateRequest(name, "renamed"))
                assertEquals(HttpStatusCode.NoContent, rename.status)

                for ((then, against) in listOf(old to null, old to current.id, current.id to old)) {
                    val view = w.stranger.client.compare(then, against)
                    assertEquals(false, view.links.captured, "then=$then against=$against")
                    assertEquals(emptyList(), view.links.items)
                    val totals = view.links.totals
                    assertEquals(0, totals.added + totals.removed + totals.changed + totals.unchanged)
                    assertEquals(false, view.capacity.captured, "then=$then against=$against")
                    assertEquals(emptyList(), view.capacity.teams)
                    assertEquals(0, view.capacity.totals.teams)
                }
                assertEquals(true, w.stranger.client.compare(current.id).links.captured, "a baseline taken now captured them")
                assertEquals(HttpStatusCode.OK, w.stranger.client.get("/api/v1/views/team/${t.teamId}?baseline=$old").status)
            } finally {
                TestPlan.deleteBaseline(old)
                TestPlan.deleteBaseline(current.id)
            }
        }

    @Test
    fun `the comparison lists the changed links and capacity ranges - added, removed, changed - live and against a later baseline`() =
        testApplication {
            usePostgresTestcontainer()
            val w = planWorld("bcv", teams = true)
            val t = w.requireTeams()
            val a = TestPlan.milestone(w.projectId, t.teamId, planName("ms-a"))
            val b = TestPlan.milestone(w.projectId, t.teamId, planName("ms-b"))
            val c = TestPlan.milestone(w.projectId, t.teamId, planName("ms-c"))
            val e = TestPlan.milestone(w.projectId, t.teamId, planName("ms-e"))
            val second = TestPlan.project(w.programId, w.projectOwner.personId!!, planName("pj-second"))
            val d = TestPlan.milestone(second, t.otherTeamId, planName("ms-d"))
            val kept = TestPlan.dependency(milestoneRef(a), milestoneRef(b))
            val relagged = TestPlan.dependency(milestoneRef(b), projectRef(second), DependencyType.SS, 3)
            val removed = TestPlan.dependency(projectRef(w.projectId), milestoneRef(d), DependencyType.FF, -2)
            val orphaned = TestPlan.dependency(milestoneRef(e), milestoneRef(c))
            val cut = TestPlan.capacityPeriod(t.teamId, "2027-03-01", 12.5, 3)
            val dropped = TestPlan.capacityPeriod(t.teamId, "2027-06-01", 8.0)
            TestPlan.capacityPeriod(t.otherTeamId, "2027-03-01", 6.0)
            val teamName = TestPlan.scalar("SELECT name FROM teams WHERE id = ${t.teamId}") { it.getString(1) }
            val eName = milestoneName(e)
            val projectName = nameOfProject(w.projectId)
            val secondName = nameOfProject(second)
            val before = w.editor.client.take(planName("bcv-before"))
            var after: BaselineResponse? = null
            try {
                assertEquals(HttpStatusCode.NoContent, w.admin.client.putDependency(relagged, DependencyType.SS, 5).status)
                assertEquals(HttpStatusCode.NoContent, w.admin.client.delete("/api/v1/dependencies/$removed").status)
                assertEquals(HttpStatusCode.NoContent, w.admin.client.delete("/api/v1/milestones/$e").status, "its link goes with it")
                val added = TestPlan.dependency(milestoneRef(a), milestoneRef(c), DependencyType.SF, 1)
                execSql("UPDATE team_capacity_periods SET md_per_week = 9.5 WHERE id = $cut")
                execSql("UPDATE team_capacity_periods SET marked_as_deleted = TRUE WHERE id = $dropped")
                TestPlan.capacityPeriod(t.teamId, "2027-12-01", 4.0)

                val view = w.stranger.client.compare(before.id)
                val links = view.links
                assertTrue(links.captured)
                assertEquals(false, links.truncated)
                val mine = setOf(kept, relagged, removed, orphaned, added)
                val ours = links.items.filter { it.dependencyId in mine }.associateBy { it.dependencyId }
                assertEquals(setOf(relagged, removed, orphaned, added), ours.keys, "the untouched link is not listed")
                assertEquals(links.items.map { it.dependencyId }.sorted(), links.items.map { it.dependencyId }, "by dependency id")
                assertEquals(links.totals.added, links.items.count { it.change == LinkChangeKind.ADDED })
                assertEquals(links.totals.removed, links.items.count { it.change == LinkChangeKind.REMOVED })
                assertEquals(links.totals.changed, links.items.count { it.change == LinkChangeKind.CHANGED })
                assertTrue(links.totals.unchanged >= 1, "the untouched link counts")

                val changed = ours.getValue(relagged)
                assertEquals(LinkChangeKind.CHANGED, changed.change)
                assertEquals(DependencyType.SS to 3, changed.then?.type to changed.then?.lagDays)
                assertEquals(DependencyType.SS to 5, changed.now?.type to changed.now?.lagDays)
                assertEquals(EndpointKind.MILESTONE to milestoneName(b), changed.predecessor.kind to changed.predecessor.name)
                assertEquals(projectName, changed.predecessor.projectName, "a milestone end names its project")
                assertEquals(EndpointKind.PROJECT to secondName, changed.successor.kind to changed.successor.name)
                assertNull(changed.successor.projectName)

                val gone = ours.getValue(removed)
                assertEquals(LinkChangeKind.REMOVED, gone.change)
                assertEquals(DependencyType.FF to -2, gone.then?.type to gone.then?.lagDays)
                assertNull(gone.now)
                assertEquals(projectName to milestoneName(d), gone.predecessor.name to gone.successor.name)
                assertEquals(secondName, gone.successor.projectName)

                val orphan = ours.getValue(orphaned)
                assertEquals(LinkChangeKind.REMOVED, orphan.change)
                assertEquals(eName to projectName, orphan.predecessor.name to orphan.predecessor.projectName, "a deleted end: frozen name")

                val new = ours.getValue(added)
                assertEquals(LinkChangeKind.ADDED, new.change)
                assertNull(new.then)
                assertEquals(DependencyType.SF to 1, new.now?.type to new.now?.lagDays)

                val capacity = view.capacity
                assertTrue(capacity.captured)
                val team = capacity.teams.single { it.teamId == t.teamId }
                assertEquals(teamName, team.teamName)
                assertNull(capacity.teams.firstOrNull { it.teamId == t.otherTeamId }, "the unchanged team is not listed")
                assertEquals(
                    listOf(
                        listOf("2027-03-01", "2027-05-31", "12.5/3", "9.5/3"),
                        listOf("2027-06-01", "2027-11-30", "8.0/null", "9.5/3"),
                        listOf("2027-12-01", null, "8.0/null", "4.0/null"),
                    ),
                    team.changes.map { listOf(it.from, it.to, figure(it.then), figure(it.now)) },
                )
                assertEquals(capacity.totals.changedTeams, capacity.teams.size)
                assertTrue(capacity.totals.teams >= capacity.totals.changedTeams + 1, "the unchanged team is counted")

                // Against a baseline taken now ("now" = its frozen rows): the same changes; the other way round, the inverse.
                after = w.editor.client.take(planName("bcv-after"))
                val forward = w.stranger.client.compare(before.id, after.id)
                val changes = view.links.items.map { it.dependencyId to it.change }
                assertEquals(changes, forward.links.items.map { it.dependencyId to it.change })
                assertEquals(view.links.totals, forward.links.totals)
                assertEquals(
                    team.changes.map { it.from to it.to },
                    forward.capacity.teams.single { it.teamId == t.teamId }.changes.map { it.from to it.to },
                )
                val orphanForward = forward.links.items.single { it.dependencyId == orphaned }
                assertEquals(eName, orphanForward.predecessor.name, "named from the frozen side")
                val inverse = w.stranger.client.compare(after.id, before.id)
                val flipped = mapOf(LinkChangeKind.ADDED to LinkChangeKind.REMOVED, LinkChangeKind.REMOVED to LinkChangeKind.ADDED)
                assertEquals(
                    view.links.items.map { it.dependencyId to (flipped[it.change] ?: it.change) },
                    inverse.links.items.map { it.dependencyId to it.change },
                )
                val back = inverse.links.items.single { it.dependencyId == relagged }
                assertEquals(5 to 3, back.then?.lagDays to back.now?.lagDays)
                val backCapacity = inverse.capacity.teams.single { it.teamId == t.teamId }.changes
                assertEquals("9.5/3" to "12.5/3", figure(backCapacity.first().then) to figure(backCapacity.first().now))
                // Right after taking a baseline nothing differs from the plan: no row of either block.
                val same = w.stranger.client.compare(after.id)
                assertEquals(emptyList(), same.links.items)
                assertEquals(emptyList(), same.capacity.teams)
                assertEquals(0, same.links.totals.added + same.links.totals.removed + same.links.totals.changed)
            } finally {
                TestPlan.deleteBaseline(before.id)
                after?.let { TestPlan.deleteBaseline(it.id) }
            }
        }
}
