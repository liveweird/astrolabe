package ch.nokillswit

import ch.nokillswit.jira.JiraLevel
import ch.nokillswit.jira.JiraStatusCategory
import ch.nokillswit.planning.DeviationKind
import ch.nokillswit.planning.FlagKind
import ch.nokillswit.planning.FlagSeverity
import ch.nokillswit.planning.JiraRollup
import ch.nokillswit.planning.JiraSite
import ch.nokillswit.planning.PlanFlag
import ch.nokillswit.planning.ProgramsView
import ch.nokillswit.planning.ProjectView
import ch.nokillswit.planning.RoadmapProject
import ch.nokillswit.planning.RoadmapView
import ch.nokillswit.planning.TeamView
import io.ktor.client.HttpClient
import io.ktor.client.call.body
import io.ktor.client.request.get
import io.ktor.server.testing.ApplicationTestBuilder
import io.ktor.server.testing.testApplication
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import org.junit.After
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * The Jira links and flags in the four timeline views (1.3, server half) through HTTP, on one bound world: a project with its own
 * deviation and five milestones (a WARNING, an INFO, a clean one, an unscheduled one Jira has dates for, an unbound one), next to a
 * wholly unbound project on another team. The source's own table is `JiraFlagSourceTest`; the overlay's additivity on the unbound
 * worlds is the four `*ViewBaselineTest`s, repeated here on a bound one.
 */
class TimelineJiraFlagsTest {
    private val ledger = ConnectionLedger()

    @After
    fun dropConnections() = ledger.drop()

    private class Bound(val w: PlanWorld, val c: UInt, val siteUrl: String) {
        val team = w.requireTeams().teamId
        val otherTeam = w.requireTeams().otherTeamId
        lateinit var warn: Pair<UInt, UInt>
        lateinit var info: Pair<UInt, UInt>
        lateinit var clean: Pair<UInt, UInt>
        lateinit var dated: Pair<UInt, UInt>
        var unbound = 0u
        var projectBinding = 0u
        var otherProject = 0u
        var otherMilestone = 0u
        val raising get() = listOf(warn.first, info.first, dated.first)
        val client get() = w.stranger.client
    }

    private suspend fun ApplicationTestBuilder.world(prefix: String): Bound {
        usePostgresTestcontainer()
        val w = planWorld(prefix, teams = true)
        val c = ledger.track(w.admin.client.dvConnection())
        val b = Bound(w, c, w.admin.client.dvView().connections.single { it.id == c }.siteUrl)
        suspend fun milestone(obs: (String) -> DvObs, start: String? = null, end: String? = null): Pair<UInt, UInt> {
            val name = planName("ms")
            val id = TestPlan.milestone(w.projectId, b.team, name)
            if (start != null) TestPlan.schedule(id, start, end)
            val (issueId, key) = nextIssue()
            return id to dvBind(c, JiraLevel.MILESTONE, id, issueId, key, obs(name))
        }
        b.warn = milestone({ DvObs(it, 1, start = "2044-02-07", end = "2044-02-11") }, "2044-02-07", "2044-02-18")
        b.info = milestone({ DvObs("Not the name", 1) })
        b.clean = milestone({ DvObs(it, 1) })
        b.dated = milestone({ DvObs(it, 1, start = "2044-03-07", end = "2044-03-11") })
        b.unbound = TestPlan.milestone(w.projectId, b.team)
        b.projectBinding = deviatingBinding(c, JiraLevel.PROJECT, w.projectId)
        b.otherProject = TestPlan.project(w.programId, w.projectOwner.personId!!)
        b.otherMilestone = TestPlan.milestone(b.otherProject, b.otherTeam)
        TestPlan.schedule(b.otherMilestone, "2044-02-07", "2044-02-11")
        return b
    }

    private suspend fun HttpClient.roadmap(): RoadmapView = get("/api/v1/views/roadmap").body()

    private suspend fun HttpClient.programs(): ProgramsView = get("/api/v1/views/programs").body()

    private suspend fun HttpClient.project(id: UInt): ProjectView = get("/api/v1/views/project/$id").body()

    private suspend fun HttpClient.team(id: UInt): TeamView = get("/api/v1/views/team/$id").body()

    private fun RoadmapView.row(id: UInt): RoadmapProject = (ranked.map { it.project } + unranked).single { it.id == id }

    private fun ProgramsView.row(id: UInt): RoadmapProject =
        workStreams.flatMap { it.programs }.flatMap { it.projects }.single { it.id == id }

    private fun List<PlanFlag>.shape() = map { (it.deviation?.kind ?: it.kind) to it.severity }

    private val jiraKinds = setOf(FlagKind.JIRA_DEVIATION, FlagKind.JIRA_MILESTONES)

    @Test
    fun `the project's row carries its link, its own flags and ONE roll-up of its milestones on the roadmap and the programs view`() =
        testApplication {
            val b = world("tjf1")
            val rollUp = PlanFlag(FlagKind.JIRA_MILESTONES, FlagSeverity.WARNING, null, null, null, count = 3)
            for (row in listOf(b.client.roadmap().row(b.w.projectId), b.client.programs().row(b.w.projectId))) {
                val link = assertNotNull(row.jira)
                assertEquals(listOf(b.projectBinding, b.c), listOf(link.bindingId, link.connectionId))
                assertNull(link.start, "no dates observed on the project")
                val kinds = listOf(rollUp.kind, FlagKind.JIRA_DEVIATION, FlagKind.JIRA_DEVIATION)
                assertEquals(kinds, row.flags.map { it.kind }, "WARNING first")
                assertEquals(rollUp, row.flags.first(), "ONE roll-up, never a flag per milestone: 3 of 5 milestones raise")
                assertEquals(
                    listOf(DeviationKind.RENAMED to FlagSeverity.INFO, DeviationKind.UNLINKED_IN_PLAN to FlagSeverity.INFO),
                    row.flags.drop(1).shape(),
                    "its own RENAMED and the 1.4 coverage of the unbound milestone",
                )
            }
            val unbound = b.client.roadmap().row(b.otherProject)
            assertNull(unbound.jira)
            assertEquals(emptyList(), unbound.flags.filter { it.kind in jiraKinds })
            for (sites in listOf(b.client.roadmap().jiraSites, b.client.programs().jiraSites)) {
                assertEquals(1, sites.count { it.connectionId == b.c })
                assertTrue(JiraSite(b.c, b.siteUrl) in sites)
            }
        }

    @Test
    fun `the programs tree counts the Jira flags with the projects' others`() = testApplication {
        val b = world("tjf2")
        val view = b.client.programs()
        val program = view.workStreams.flatMap { it.programs }.single { p -> p.projects.any { it.id == b.w.projectId } }
        assertEquals(3, program.projects.single { it.id == b.w.projectId }.flags.size)
        assertEquals(1, program.flags.warnings, "the roll-up's WARNING")
        assertEquals(2, program.flags.infos, "the project's own RENAMED and UNLINKED_IN_PLAN (its unbound milestone)")
        val stream = view.workStreams.single { s -> s.programs.any { it.id == program.id } }
        assertEquals(program.flags, stream.flags)
    }

    @Test
    fun `the project view carries the project's, every milestone's link and open flags, and the sites`() = testApplication {
        val b = world("tjf3")
        val view = b.client.project(b.w.projectId)
        assertEquals(b.client.roadmap().row(b.w.projectId).flags.filter { it.kind in jiraKinds }, view.project.flags)
        assertEquals(b.projectBinding, view.project.jira?.bindingId)
        assertEquals(listOf(JiraSite(b.c, b.siteUrl)), view.jiraSites)

        val rows = (view.scheduled + view.unscheduled).associateBy { it.id }
        assertEquals(listOf(DeviationKind.END_DIFFERS to FlagSeverity.WARNING), rows.getValue(b.warn.first).flags.shape())
        assertEquals(listOf(DeviationKind.RENAMED to FlagSeverity.INFO), rows.getValue(b.info.first).flags.shape())
        assertEquals(listOf(DeviationKind.UNSCHEDULED_IN_PLAN to FlagSeverity.INFO), rows.getValue(b.dated.first).flags.shape())
        assertEquals(emptyList(), rows.getValue(b.clean.first).flags)
        assertEquals(b.clean.second, rows.getValue(b.clean.first).jira?.bindingId, "a clean binding still has its bar")
        assertEquals(listOf("2044-02-07", "2044-02-11"), rows.getValue(b.warn.first).jira.let { listOf(it?.start, it?.end) })
        assertNull(rows.getValue(b.unbound).jira)
        assertEquals(emptyList(), rows.getValue(b.unbound).flags)
        assertTrue(view.scheduled.any { it.id == b.warn.first } && view.unscheduled.any { it.id == b.info.first })
    }

    @Test
    fun `the team view carries each milestone's link and flags, scheduled and unscheduled, and its sites`() = testApplication {
        val b = world("tjf4")
        val view = b.client.team(b.team)
        val rows = (view.scheduled + view.unscheduled).associateBy { it.id }
        assertEquals(setOf(b.warn.first, b.info.first, b.clean.first, b.dated.first, b.unbound), rows.keys)
        assertEquals(listOf(DeviationKind.END_DIFFERS to FlagSeverity.WARNING), rows.getValue(b.warn.first).flags.shape())
        assertEquals(listOf(DeviationKind.RENAMED to FlagSeverity.INFO), rows.getValue(b.info.first).flags.shape())
        assertEquals(b.warn.second, rows.getValue(b.warn.first).jira?.bindingId)
        assertNull(rows.getValue(b.unbound).jira)
        assertEquals(listOf(JiraSite(b.c, b.siteUrl)), view.jiraSites)
        assertTrue(view.scheduled.any { it.id == b.warn.first } && view.unscheduled.any { it.id == b.dated.first })
    }

    @Test
    fun `an unbound project and team answer null links, empty flags and no sites, with every member present`() = testApplication {
        val b = world("tjf5")
        val project = b.client.project(b.otherProject)
        assertNull(project.project.jira)
        assertEquals(emptyList(), project.project.flags)
        assertEquals(emptyList(), project.jiraSites)
        assertNull(project.scheduled.single().jira)
        assertEquals(emptyList(), project.scheduled.single().flags)
        val team = b.client.team(b.otherTeam)
        assertEquals(emptyList(), team.jiraSites)
        assertNull(team.scheduled.single().jira)

        // The members are on the wire even when empty (explicit nulls, encoded defaults): the schema declares them nullable, not optional.
        val raw = b.client.rawJson("/api/v1/views/project/${b.otherProject}").jsonObject
        assertEquals(JsonNull, raw.getValue("project").jsonObject.getValue("jira"))
        assertEquals(JsonArray(emptyList()), raw.getValue("project").jsonObject.getValue("flags"))
        assertEquals(JsonArray(emptyList()), raw.getValue("jiraSites"))
        val milestone = raw.getValue("scheduled").jsonArray.single().jsonObject
        assertEquals(JsonNull, milestone.getValue("jira"))
        assertEquals(JsonArray(emptyList()), milestone.getValue("flags"))
        val flagged = b.client.rawJson("/api/v1/views/roadmap").jsonObject.getValue("unranked").jsonArray
            .map { it.jsonObject }.single { it.getValue("id").toString() == b.w.projectId.toString() }
        val flags = flagged.getValue("flags").jsonArray.map { it.jsonObject }
        fun ofKind(kind: String) = flags.filter { it.getValue("kind").toString() == "\"$kind\"" }
        val flag = ofKind("JIRA_MILESTONES").single()
        assertEquals(JsonNull, flag.getValue("deviation"))
        assertEquals("3", flag.getValue("count").toString())
        val deviation = ofKind("JIRA_DEVIATION").first() // several are legitimate: RENAMED and the 1.4 UNLINKED_IN_PLAN
        assertEquals(JsonNull, deviation.getValue("count"))
        assertTrue(deviation.getValue("deviation") is JsonObject)
    }

    @Test
    fun `acknowledging removes the flags in every view and keeps the bars, a changed item raises them again`() = testApplication {
        val b = world("tjf6")
        val admin = b.w.admin.client
        val item = admin.ackItem(b.c, b.warn.second)
        admin.ack(b.warn.second, item.fingerprint).acknowledgement()

        val project = b.client.project(b.w.projectId)
        assertEquals(emptyList(), project.scheduled.single { it.id == b.warn.first }.flags)
        assertEquals(b.warn.second, project.scheduled.single { it.id == b.warn.first }.jira?.bindingId)
        val rollUp = project.project.flags.single { it.kind == FlagKind.JIRA_MILESTONES }
        assertEquals(2 to FlagSeverity.INFO, rollUp.count to rollUp.severity, "the acknowledged one leaves the roll-up")
        assertEquals(emptyList(), b.client.team(b.team).scheduled.single { it.id == b.warn.first }.flags)
        assertEquals(2, b.client.roadmap().row(b.w.projectId).flags.single { it.kind == FlagKind.JIRA_MILESTONES }.count)
        assertEquals(2, b.client.programs().row(b.w.projectId).flags.single { it.kind == FlagKind.JIRA_MILESTONES }.count)

        // Acknowledged, then changed (the plan end moves to Jira's): the fingerprint no longer matches, so it is open again.
        jbSql("UPDATE jira_observations SET end_date = '2044-02-14' WHERE binding_id = ?", b.warn.second.toInt())
        val reopened = b.client.project(b.w.projectId).scheduled.single { it.id == b.warn.first }
        assertEquals(listOf(DeviationKind.END_DIFFERS to FlagSeverity.WARNING), reopened.flags.shape())
    }

    @Test
    fun `a disabled connection keeps its link and site but raises no flag or dates in any view, and a gone item is a dateless GONE flag`() =
        testApplication {
            val b = world("tjf7")
            jbSql("UPDATE jira_observations SET gone = TRUE, gone_reason = 'DELETED' WHERE binding_id = ?", b.warn.second.toInt())
            val gone = b.client.project(b.w.projectId).scheduled.single { it.id == b.warn.first }
            assertEquals(listOf(DeviationKind.GONE to FlagSeverity.WARNING), gone.flags.shape())
            assertEquals(listOf<String?>(null, null), listOf(gone.jira?.start, gone.jira?.end))
            assertEquals(b.warn.second, gone.jira?.bindingId)

            jbSql("UPDATE jira_connections SET enabled = FALSE WHERE id = ?", b.c.toInt())
            val project = b.client.project(b.w.projectId)
            assertEquals(emptyList(), project.project.flags)
            // Still linked (the page shows the link and can unlink it), with no flags and no dates.
            val linked = (project.scheduled + project.unscheduled).filter { it.jira != null }
            assertTrue(linked.isNotEmpty())
            assertTrue(linked.all { it.flags.isEmpty() && it.jira?.start == null && it.jira?.end == null && it.jira?.connectionId == b.c })
            assertEquals(listOf(b.c), project.jiraSites.map { it.connectionId })
            val team = b.client.team(b.team)
            assertTrue((team.scheduled + team.unscheduled).all { it.flags.isEmpty() && it.jira?.start == null && it.jira?.end == null })
            assertTrue((team.scheduled + team.unscheduled).any { it.jira != null })
            assertEquals(listOf(b.c), team.jiraSites.map { it.connectionId })
            val roadmap = b.client.roadmap()
            assertEquals(emptyList(), roadmap.row(b.w.projectId).flags.filter { it.kind in jiraKinds })
            assertNull(roadmap.row(b.w.projectId).jira?.start)
            assertTrue(roadmap.jiraSites.any { it.connectionId == b.c })
            assertTrue(b.client.programs().jiraSites.any { it.connectionId == b.c })
            assertEquals(
                true,
                b.w.admin.client.dvView("connectionId=${b.c}&all=true").items.isNotEmpty(),
                "the Deviations page still lists the disabled connection's bindings",
            )
        }

    @Test
    fun `the baseline overlay stays additive on a bound world`() = testApplication {
        val b = world("tjf8")
        val id = TestPlan.baseline(planName("tjf8"))
        try {
            b.client.assertOverlayIsAdditive("/api/v1/views/project/${b.w.projectId}", id)
            b.client.assertOverlayIsAdditive("/api/v1/views/team/${b.team}", id)
            b.client.assertOverlayIsAdditive("/api/v1/views/roadmap", id)
            b.client.assertOverlayIsAdditive("/api/v1/views/programs", id)
        } finally {
            TestPlan.deleteBaseline(id)
        }
    }

    /** Every object of [this] document that is a Jira link (it has an `issueKey`), at any depth. */
    private fun JsonElement.links(): List<JsonObject> = when (this) {
        is JsonObject -> (if ("issueKey" in this) listOf(this) else emptyList()) + values.flatMap { it.links() }
        is JsonArray -> flatMap { it.links() }
        else -> emptyList()
    }

    @Test
    fun `every Jira link in the four views carries the rollup member, null or filled`() = testApplication {
        val b = world("tjf9")
        val epic = jbScalar("SELECT jira_issue_id FROM jira_bindings WHERE id = ?", b.warn.second.toInt()) { it.getString(1) }
        dvMirror(b.c, "7401", 0, epic, JiraStatusCategory.DONE, "3", observedAt = 111)
        dvMirror(b.c, "7402", 0, epic, JiraStatusCategory.TODO, null, observedAt = 222)
        val filled = JiraRollup(2, 1, 3.0, 222L)

        val paths = listOf(
            "/api/v1/views/roadmap", "/api/v1/views/programs", "/api/v1/views/project/${b.w.projectId}", "/api/v1/views/team/${b.team}",
        )
        for (path in paths) {
            val links = b.client.rawJson(path).links()
            assertTrue(links.isNotEmpty(), "$path has bound rows")
            assertTrue(links.all { "rollup" in it }, "$path: the rollup member is on every link, as an explicit null when empty")
            assertEquals(
                paths.indexOf(path) >= 2,
                links.any { it.getValue("rollup") is JsonObject },
                "$path: only the milestone-level views carry a filled roll-up",
            )
        }
        val project = b.client.project(b.w.projectId)
        assertEquals(filled, (project.scheduled + project.unscheduled).single { it.id == b.warn.first }.jira?.rollup)
        assertNull((project.scheduled + project.unscheduled).single { it.id == b.clean.first }.jira?.rollup)
        assertNull(project.project.jira?.rollup)
        val team = b.client.team(b.team)
        assertEquals(filled, (team.scheduled + team.unscheduled).single { it.id == b.warn.first }.jira?.rollup)
        assertNull(b.client.roadmap().row(b.w.projectId).jira?.rollup)
        assertNull(b.client.programs().row(b.w.projectId).jira?.rollup)
    }
}
