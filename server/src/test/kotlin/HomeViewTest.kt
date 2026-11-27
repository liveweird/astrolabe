package ch.nokillswit

import ch.nokillswit.planning.DependencyStatus
import ch.nokillswit.planning.FlagCounts
import ch.nokillswit.planning.FlagKind
import ch.nokillswit.planning.FlagSeverity
import ch.nokillswit.planning.HomeCaller
import ch.nokillswit.planning.HomeMe
import ch.nokillswit.planning.HomeView
import ch.nokillswit.planning.HomeViewService
import ch.nokillswit.planning.HomeViewServiceKey
import ch.nokillswit.planning.PlanFlag
import ch.nokillswit.planning.PlanView
import ch.nokillswit.planning.ProgramsView
import ch.nokillswit.planning.ProjectView
import ch.nokillswit.planning.RoadmapProject
import ch.nokillswit.planning.RoadmapView
import ch.nokillswit.planning.TeamView
import ch.nokillswit.users.UserRole
import io.ktor.client.HttpClient
import io.ktor.client.call.body
import io.ktor.client.request.delete
import io.ktor.client.request.get
import io.ktor.client.statement.bodyAsText
import io.ktor.http.HttpStatusCode
import io.ktor.server.testing.ApplicationTestBuilder
import io.ktor.server.testing.testApplication
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlin.test.AfterTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * `GET /views/home` (1.18.0): the plan's figures and the caller's own items. Every figure is compared with the page it repeats, read in
 * the same test (the plan tables are shared state, so a plan-wide figure is never asserted as an absolute number and a plan-wide move
 * is a delta around this test's own seeding; "yours" is exact, the caller's person being the test's own). No Jira or Flow stub: the
 * Jira bindings are raw rows (`dvBind`) and the Flow mirror is scripted (`capAckWorld`), as `TimelineJiraFlagsTest` and
 * `TeamViewFlowFlagTest` build them.
 */
class HomeViewTest {
    private val path = "/api/v1/views/home"
    private val ledger = ConnectionLedger()
    private val mirrors = mutableListOf<ScriptedFlowMirror>()

    @AfterTest
    fun cleanUp() {
        ledger.drop()
        mirrors.forEach { it.cleanUp() }
        mirrors.clear()
        removeFlowFixtureRows(CAPACK_PREFIX)
    }

    private suspend fun HttpClient.home(): HomeView = get(path).body()

    private suspend fun HttpClient.roadmap(): RoadmapView = get("/api/v1/views/roadmap").body()

    private suspend fun HttpClient.programs(): ProgramsView = get("/api/v1/views/programs").body()

    private suspend fun HttpClient.project(id: UInt): ProjectView = get("/api/v1/views/project/$id").body()

    private suspend fun HttpClient.team(id: UInt): TeamView = get("/api/v1/views/team/$id").body()

    private fun RoadmapView.rows(): List<RoadmapProject> = ranked.map { it.project } + unranked

    private fun List<PlanFlag>.counts() =
        FlagCounts(count { it.severity == FlagSeverity.WARNING }, count { it.severity == FlagSeverity.INFO })

    private fun TeamView.violated() = dependencies.count { it.check.status == DependencyStatus.VIOLATED }

    private fun ProjectView.violated() = dependencies.count { it.check.status == DependencyStatus.VIOLATED }

    /** An owner of a work stream, program, project (its target window overrun) and a team, with two milestones (one unscheduled). */
    private class Owned(val w: PlanWorld, val owner: PlanCaller, val programId: UInt, val projectId: UInt, val teamId: UInt)

    private suspend fun ApplicationTestBuilder.owned(prefix: String): Owned {
        usePostgresTestcontainer()
        val w = planWorld(prefix, teams = true)
        val owner = planCaller("$prefix-ow")
        val me = owner.personId!!
        val programId = TestPlan.program(TestPlan.workStream(me), me)
        val projectId = TestPlan.project(programId, me, targetStart = "2044-05-30", targetEnd = "2044-06-03")
        val teamId = TestTeams.seed(planName("$prefix-team"), me)
        TestPlan.schedule(TestPlan.milestone(projectId, teamId), "2044-06-06", "2044-06-10")
        TestPlan.milestone(projectId, teamId)
        return Owned(w, owner, programId, projectId, teamId)
    }

    @Test
    fun `an anonymous request is a 401, an unknown parameter is ignored and the JSON holds exactly the documented members`() =
        testApplication {
            val o = owned("hv1")
            assertEquals(HttpStatusCode.Unauthorized, jsonClient().get(path).status)
            // No parameter reaches the lookup: another person's id changes nothing.
            val other = o.w.stranger.personId
            val response = o.owner.client.get("$path?personId=$other&foo=bar")
            assertEquals(HttpStatusCode.OK, response.status)
            val root = Json.parseToJsonElement(response.bodyAsText()).jsonObject
            assertEquals(setOf("revision", "plan", "me", "jiraSites"), root.keys, "no can")
            assertEquals(
                setOf(
                    "workStreams", "programs", "projects", "rankedProjects", "unrankedProjects", "milestones", "unscheduledMilestones",
                    "flags", "conflicts", "overloadedTeams", "wipExceededTeams",
                ),
                root.getValue("plan").jsonObject.keys,
            )
            val me = root.getValue("me").jsonObject
            assertEquals(setOf("personId", "name", "workStreams", "programs", "projects", "teams", "truncated"), me.keys)
            assertEquals(o.owner.personId.toString(), me.getValue("personId").toString())
            fun row(list: String): JsonObject = me.getValue(list).jsonArray.single().jsonObject
            assertEquals(setOf("id", "name", "endDate", "programs", "projects", "flags"), row("workStreams").keys)
            assertEquals(
                setOf("id", "name", "workStreamId", "workStreamName", "ownerPersonId", "ownerName", "direct", "projects", "flags"),
                row("programs").keys,
            )
            assertEquals(
                setOf(
                    "id", "name", "programId", "programName", "ownerPersonId", "ownerName", "direct", "rankPosition", "milestones",
                    "unscheduledMilestones", "flags", "conflicts",
                ),
                row("projects").keys,
            )
            assertEquals(
                setOf(
                    "id", "name", "milestones", "unscheduledMilestones", "conflicts", "overloadedWeeks", "wipExceededWeeks",
                    "jira", "flags",
                ),
                row("teams").keys,
            )
            assertEquals(setOf("warnings", "infos"), row("projects").getValue("flags").jsonObject.keys)
            val loginOnly = Json.parseToJsonElement(o.w.personless.client.get(path).bodyAsText()).jsonObject
            assertEquals(JsonNull, loginOnly.getValue("me"), "the member is present and null")
        }

    @Test
    fun `the plan block is the same for every caller and equals the roadmap and the programs views, and moves by exactly what is seeded`() =
        testApplication {
            val o = owned("hv2")
            val w = o.w
            val everyone = listOf(w.admin, w.streamOwner, w.programOwner, w.projectOwner, w.stranger, w.personless, w.editor, o.owner)
            val base = w.personless.client.home().plan
            for (caller in everyone) assertEquals(base, caller.client.home().plan, "never depends on who asks")

            val roadmap = w.personless.client.roadmap()
            val programs = w.personless.client.programs()
            assertEquals(roadmap.rows().size, base.projects)
            assertEquals(roadmap.ranked.size, base.rankedProjects)
            assertEquals(roadmap.unranked.size, base.unrankedProjects)
            assertEquals(roadmap.rows().flatMap { it.flags }.counts(), base.flags)
            assertEquals(programs.workStreams.size, base.workStreams)
            assertEquals(programs.workStreams.sumOf { it.programs.size }, base.programs)

            // Five milestones (two unscheduled), one more project, two violated links (one inside a project, one across two).
            val team = w.requireTeams().teamId
            val second = TestPlan.project(w.programId, w.projectOwner.personId!!)
            val a = TestPlan.milestone(w.projectId, team).also { TestPlan.schedule(it, "2044-06-06", "2044-06-10") }
            val b = TestPlan.milestone(w.projectId, team).also { TestPlan.schedule(it, "2044-06-01", "2044-06-03") }
            val c = TestPlan.milestone(second, team).also { TestPlan.schedule(it, "2044-06-01", "2044-06-02") }
            val d = TestPlan.milestone(w.projectId, team)
            TestPlan.milestone(w.projectId, team)
            TestPlan.dependency(milestoneRef(a), milestoneRef(b))
            TestPlan.dependency(milestoneRef(a), milestoneRef(c))
            TestPlan.dependency(milestoneRef(b), milestoneRef(d))
            val after = w.stranger.client.home().plan
            assertEquals(
                listOf(5, 2, 2, 1, 1),
                listOf(
                    after.milestones - base.milestones, after.unscheduledMilestones - base.unscheduledMilestones,
                    after.conflicts - base.conflicts, after.projects - base.projects, after.unrankedProjects - base.unrankedProjects,
                ),
            )
            assertEquals(base.rankedProjects, after.rankedProjects)
            assertEquals(w.admin.client.roadmap().rows().flatMap { it.flags }.counts(), after.flags)
        }

    @Test
    fun `me lists what the owner chain lets the person manage, with the owner of each row and whether it is their own`() = testApplication {
        usePostgresTestcontainer()
        val w = planWorld("hv3", teams = true)
        val t = w.requireTeams()
        suspend fun ownerName(caller: PlanCaller) = TestPeople.rawRows().single { it.id == caller.personId }.name
        // The stream's owner: the stream, the program under it (not theirs) and the project under that (not theirs either).
        val streamOwner = checkNotNull(w.streamOwner.client.home().me)
        assertEquals(listOf(w.streamId), streamOwner.workStreams.map { it.id })
        assertEquals(listOf(w.programId), streamOwner.programs.map { it.id })
        assertEquals(listOf(w.projectId), streamOwner.projects.map { it.id })
        assertEquals(emptyList(), streamOwner.teams)
        assertEquals(listOf(1, 1), streamOwner.workStreams.single().let { listOf(it.programs, it.projects) }, "its roll-up, as before")
        assertEquals(listOf(ownerName(w.programOwner), false), streamOwner.programs.single().let { listOf(it.ownerName, it.direct) })
        assertEquals(listOf(ownerName(w.projectOwner), false), streamOwner.projects.single().let { listOf(it.ownerName, it.direct) })
        // The ids of the names the rows show: the work stream and the owner of the program, the program and the owner of the project.
        val seenProgram = streamOwner.programs.single()
        assertEquals(listOf(w.streamId, w.programOwner.personId), listOf(seenProgram.workStreamId, seenProgram.ownerPersonId))
        val seenProject = streamOwner.projects.single()
        assertEquals(listOf(w.programId, w.projectOwner.personId), listOf(seenProject.programId, seenProject.ownerPersonId))
        // The program's owner: the program and its project, no work stream.
        val programOwner = checkNotNull(w.programOwner.client.home().me)
        assertEquals(listOf(w.programId), programOwner.programs.map { it.id })
        assertEquals(listOf(w.projectId), programOwner.projects.map { it.id })
        assertEquals(emptyList(), programOwner.workStreams + programOwner.teams)
        assertEquals(listOf(ownerName(w.programOwner), true), programOwner.programs.single().let { listOf(it.ownerName, it.direct) })
        assertFalse(programOwner.projects.single().direct)
        // The project's owner: that project alone, and it is theirs.
        val projectOwner = checkNotNull(w.projectOwner.client.home().me)
        assertEquals(listOf(w.projectId), projectOwner.projects.map { it.id })
        assertEquals(emptyList(), projectOwner.workStreams + projectOwner.programs + projectOwner.teams)
        assertEquals(listOf(ownerName(w.projectOwner), true), projectOwner.projects.single().let { listOf(it.ownerName, it.direct) })
        assertEquals(listOf(t.teamId), checkNotNull(t.manager.client.home().me).teams.map { it.id })
        assertEquals(listOf(t.otherTeamId), checkNotNull(t.otherManager.client.home().me).teams.map { it.id })
        val stranger = checkNotNull(w.stranger.client.home().me)
        assertEquals(emptyList(), stranger.workStreams + stranger.programs + stranger.projects + stranger.teams)
        assertFalse(stranger.truncated)
        assertEquals(w.stranger.personId, stranger.personId)
        assertEquals(TestPeople.rawRows().single { it.id == w.stranger.personId }.name, stranger.name)
        assertNull(w.personless.client.home().me, "a login without a person")
        assertNull(w.admin.client.home().me, "an administrator without a person is not 'everyone'")

        // An ADMINISTRATOR with a person is looked up like anyone, and gets that person's chain, never everything: a project of their
        // own, and a program of their own with another person's project under it.
        val admin = planCaller("hv3-adp", UserRole.ADMIN)
        val project = TestPlan.project(w.programId, admin.personId!!)
        val team = TestTeams.seed(planName("hv3-adteam"), admin.personId)
        val adminProgram = TestPlan.program(w.streamId, admin.personId)
        val underAdminProgram = TestPlan.project(adminProgram, w.stranger.personId!!)
        val me = checkNotNull(admin.client.home().me)
        assertEquals(setOf(project, underAdminProgram), me.projects.map { it.id }.toSet())
        assertEquals(mapOf(project to true, underAdminProgram to false), me.projects.associate { it.id to it.direct })
        assertEquals(listOf(adminProgram), me.programs.map { it.id })
        assertEquals(listOf(team), me.teams.map { it.id })
        assertEquals(emptyList(), me.workStreams)
        assertTrue(w.projectId !in me.projects.map { it.id }, "the project under the world's program is not the administrator's")
    }

    @Test
    fun `me lists exactly the projects and programs the owner chain guard lets the caller edit`() = testApplication {
        usePostgresTestcontainer()
        val w = planWorld("hv3g")
        val other = planWorld("hv3h")
        val second = secondProject(w, "hv3g")
        // A second program in the world's work stream, owned by a new person, with a project owned by the stranger.
        val programCaller = planCaller("hv3g-pg")
        val secondProgram = TestPlan.program(w.streamId, programCaller.personId!!)
        val underSecond = TestPlan.project(secondProgram, w.stranger.personId!!)
        val projects = listOf(w.projectId, second.projectId, underSecond, other.projectId)
        val programs = listOf(w.programId, secondProgram, other.programId)
        val roadmap = w.admin.client.roadmap().rows().associateBy { it.id }
        val callers = listOf(
            w.streamOwner, w.programOwner, w.projectOwner, w.stranger, w.editor, second.owner, programCaller, other.streamOwner,
            other.projectOwner,
        )
        for (caller in callers) {
            val me = checkNotNull(caller.client.home().me)
            // The caller's own (non-administrator) project view, one project at a time: the list is exactly the projects it lets them edit.
            val editable = projects.filter { caller.client.project(it).project.can.edit }.toSet()
            assertEquals(editable, me.projects.map { it.id }.toSet(), "projects of person ${caller.personId}")
            assertEquals(me.projects.size, editable.size, "each project once")
            for (row in me.projects) {
                assertEquals(roadmap.getValue(row.id).ownerPersonId == caller.personId, row.direct, "direct, project ${row.id}")
                assertEquals(roadmap.getValue(row.id).ownerName, row.ownerName)
            }
            // The same for the programs, from the plan view's own `can.edit` for this caller.
            val plan = caller.client.get("/api/v1/views/plan").body<PlanView>()
            val canEditProgram = plan.workStreams.flatMap { it.programs }.associate { it.id to it.can.edit }
            assertEquals(programs.filter { canEditProgram.getValue(it) }.toSet(), me.programs.map { it.id }.toSet(), "programs")
        }
        assertEquals(3, checkNotNull(w.streamOwner.client.home().me).projects.size, "non-vacuous: the stream owner manages three of four")
        assertTrue(w.stranger.client.project(underSecond).project.can.edit, "non-vacuous: the stranger owns one project of the world")
        // The administrator without a person gets no list at all, whatever the project views say about the role.
        assertNull(w.admin.client.home().me)
    }

    @Test
    fun `a project row and a team row equal the pages they repeat, conflicts and flags included`() = testApplication {
        val o = owned("hv4")
        val team = o.teamId
        TestPlan.capacityPeriod(team, "2044-01-03", 1.0, wipLimit = 1)
        // A violated link inside the owner's project, and one across to another project, both on the owner's team.
        val inside = TestPlan.milestone(o.projectId, team).also { TestPlan.schedule(it, "2044-06-01", "2044-06-03") }
        val outside = TestPlan.milestone(o.w.projectId, team).also { TestPlan.schedule(it, "2044-06-01", "2044-06-02") }
        val first = o.owner.client.project(o.projectId).scheduled.first { it.startDate == "2044-06-06" }.id
        TestPlan.dependency(milestoneRef(first), milestoneRef(inside))
        TestPlan.dependency(milestoneRef(first), milestoneRef(outside))

        val me = checkNotNull(o.owner.client.home().me)
        val project = me.projects.single()
        val roadmapRow = o.owner.client.roadmap().rows().single { it.id == o.projectId }
        val view = o.owner.client.project(o.projectId)
        assertEquals(roadmapRow.flags.counts(), project.flags)
        assertTrue(project.flags.warnings + project.flags.infos > 0, "the overrun of the target window is flagged")
        assertEquals(view.scheduled.size + view.unscheduled.size, project.milestones)
        assertEquals(view.unscheduled.size, project.unscheduledMilestones)
        assertEquals(view.violated(), project.conflicts)
        assertEquals(2, project.conflicts)
        assertNull(project.rankPosition)
        assertEquals(roadmapRow.programName, project.programName)

        val row = me.teams.single()
        val teamView = o.owner.client.team(team)
        assertEquals(teamView.scheduled.size + teamView.unscheduled.size, row.milestones)
        assertEquals(teamView.unscheduled.size, row.unscheduledMilestones)
        assertEquals(teamView.violated(), row.conflicts)
        assertEquals(2, row.conflicts)
        assertTrue(teamView.weeks.any { it.overloaded } && teamView.weeks.any { it.wipExceeded }, "non-vacuous: the weeks are flagged")
        assertEquals(teamView.weeks.count { it.overloaded }, row.overloadedWeeks)
        assertEquals(teamView.weeks.count { it.wipExceeded }, row.wipExceededWeeks)
        assertEquals(teamView.team.name, row.name)
        assertEquals(teamView.team.flags, row.flags)

        // The other project's page counts the cross link too, and its owner's Home agrees.
        val otherOwner = checkNotNull(o.w.projectOwner.client.home().me).projects.single { it.id == o.w.projectId }
        assertEquals(o.w.projectOwner.client.project(o.w.projectId).violated(), otherOwner.conflicts)
        assertEquals(1, otherOwner.conflicts)
    }

    @Test
    fun `a team is listed exactly for the caller whose team view answers can schedule as a non-administrator`() = testApplication {
        usePostgresTestcontainer()
        val w = planWorld("hv5", teams = true)
        val t = w.requireTeams()
        val callers = listOf(w.streamOwner, w.programOwner, w.projectOwner, w.stranger, w.personless, w.editor, t.manager, t.otherManager)
        for (caller in callers) {
            val expected = listOf(t.teamId, t.otherTeamId).filter { caller.client.team(it).team.can.schedule }.toSet()
            assertEquals(expected, caller.client.home().me?.teams.orEmpty().map { it.id }.toSet())
        }
        assertEquals(setOf(t.teamId), t.manager.client.home().me?.teams.orEmpty().map { it.id }.toSet(), "non-vacuous")
    }

    @Test
    fun `the capacity figures equal the team views and the plan block counts every team for every caller`() = testApplication {
        val o = owned("hv6")
        val w = o.w
        val owner = o.owner
        val base = w.personless.client.home().plan
        // Team a: overloaded and over its WIP limit; team b: overloaded, no limit; team c: neither. All on the owner's project.
        val teams = listOf("a", "b", "c").map { TestTeams.seed(planName("hv6-$it"), owner.personId) }
        suspend fun load(team: UInt, milestones: Int) = repeat(milestones) {
            TestPlan.schedule(TestPlan.milestone(o.projectId, team, estimate = 3.0), "2044-09-05", "2044-09-09")
        }
        TestPlan.capacityPeriod(teams[0], "2044-01-03", 1.0, wipLimit = 1).also { load(teams[0], 2) }
        TestPlan.capacityPeriod(teams[1], "2044-01-03", 1.0).also { load(teams[1], 1) }
        TestPlan.capacityPeriod(teams[2], "2044-01-03", 100.0, wipLimit = 5).also { load(teams[2], 1) }

        val views = teams.map { owner.client.team(it) }
        val overloaded = views.count { v -> v.weeks.any { it.overloaded } }
        val wip = views.count { v -> v.weeks.any { it.wipExceeded } }
        assertEquals(listOf(2, 1), listOf(overloaded, wip), "the seeding is non-vacuous: the team pages flag what the test means them to")
        for (caller in listOf(owner, w.personless, w.admin, w.stranger)) {
            val plan = caller.client.home().plan
            assertEquals(overloaded, plan.overloadedTeams - base.overloadedTeams, "never depends on who asks")
            assertEquals(wip, plan.wipExceededTeams - base.wipExceededTeams)
        }
        val rows = checkNotNull(owner.client.home().me).teams.associateBy { it.id }
        for ((team, view) in teams.zip(views)) {
            val row = rows.getValue(team)
            assertEquals(view.weeks.count { it.overloaded }, row.overloadedWeeks)
            assertEquals(view.weeks.count { it.wipExceeded }, row.wipExceededWeeks)
        }
        assertEquals(listOf(1, 1), rows.getValue(teams[0]).let { listOf(it.overloadedWeeks, it.wipExceededWeeks) })
        assertEquals(listOf(1, 0), rows.getValue(teams[1]).let { listOf(it.overloadedWeeks, it.wipExceededWeeks) })
        assertEquals(listOf(0, 0), rows.getValue(teams[2]).let { listOf(it.overloadedWeeks, it.wipExceededWeeks) })
        assertTrue(rows.keys.containsAll(teams) && o.teamId in rows)
    }

    @Test
    fun `on a bound world the team's Jira counts, the project's flags and the sites are the other views' own`() = testApplication {
        usePostgresTestcontainer()
        val w = planWorld("hv7", teams = true)
        val t = w.requireTeams()
        val c = ledger.track(w.admin.client.dvConnection())
        twoLineBinding(c, w.projectId, t.teamId)
        twoLineBinding(c, w.projectId, t.teamId)
        TestPlan.milestone(w.projectId, t.teamId) // unbound: raises its own coverage line

        val roadmap = w.stranger.client.roadmap()
        val teamView = t.manager.client.team(t.teamId)
        val milestoneFlags = (teamView.scheduled + teamView.unscheduled).flatMap { it.flags }
        val expected = milestoneFlags.filter { it.kind == FlagKind.JIRA_DEVIATION }.counts()
        assertTrue(expected.warnings >= 2 && expected.infos >= 2, "the world raises what the test pins")
        val row = checkNotNull(t.manager.client.home().me).teams.single()
        assertEquals(expected, row.jira)
        assertEquals(teamView.team.flags, row.flags)
        val project = checkNotNull(w.projectOwner.client.home().me).projects.single()
        assertEquals(roadmap.rows().single { it.id == w.projectId }.flags.counts(), project.flags)
        assertTrue(roadmap.jiraSites.isNotEmpty() && roadmap.jiraSites.any { it.connectionId == c })
        for (caller in listOf(w.stranger, w.personless, w.admin)) assertEquals(roadmap.jiraSites, caller.client.home().jiraSites)
        assertEquals(roadmap.rows().flatMap { it.flags }.counts(), w.stranger.client.home().plan.flags)
    }

    @Test
    fun `on a scripted Flow the manager's team row carries the team view's Flow flag exactly`() = testApplication {
        val world = capAckWorld("hv8", mirrors)
        with(world) {
            refresh()
            TestPlan.schedule(TestPlan.milestone(w.projectId, teamId, planName("hv8"), 5.0), "2049-03-08", "2049-04-09")
            // A load no imported capacity can carry, so the overloaded weeks are not 0 == 0.
            TestPlan.schedule(TestPlan.milestone(w.projectId, teamId, planName("hv8-heavy"), 5000.0), "2049-03-08", "2049-04-09")
            val view = w.stranger.client.get("/api/v1/views/team/$teamId").body<TeamView>()
            val flag = view.team.flags.single()
            assertEquals(FlagKind.FLOW_CAPACITY, flag.kind)
            val row = checkNotNull(manager.client.home().me).teams.single()
            assertEquals(view.team.flags, row.flags)
            assertTrue(view.weeks.any { it.overloaded }, "non-vacuous: the team page flags overloaded weeks")
            assertEquals(view.weeks.count { it.overloaded }, row.overloadedWeeks)
            // An unlinked team of the same manager carries no Flow flag and no error.
            val unlinked = TestTeams.seed(planName("hv8-unlinked"), manager.personId)
            val rows = checkNotNull(manager.client.home().me).teams.associateBy { it.id }
            assertEquals(emptyList(), rows.getValue(unlinked).flags)
            assertEquals(view.team.flags, rows.getValue(teamId).flags)
        }
    }

    @Test
    fun `a deleted person, an unlinked login, a deleted team and a deleted project show nothing`() = testApplication {
        usePostgresTestcontainer()
        val w = planWorld("hv9", teams = true)
        val gone = planCaller("hv9-gone")
        TestPlan.project(w.programId, gone.personId!!)
        assertNotNull(gone.client.home().me)
        TestPeople.softDelete(gone.personId)
        assertNull(gone.client.home().me, "its person was deleted")

        val unlinked = planCaller("hv9-unl")
        assertNotNull(unlinked.client.home().me)
        jbSql("UPDATE people SET user_id = NULL WHERE id = ?", unlinked.personId!!.toInt())
        assertNull(unlinked.client.home().me, "its person is no longer linked to the login")

        val owner = planCaller("hv9-ow")
        val keep = TestPlan.project(w.programId, owner.personId!!)
        val drop = TestPlan.project(w.programId, owner.personId)
        val team = TestTeams.seed(planName("hv9-team"), owner.personId)
        val before = w.stranger.client.home().plan
        val full = checkNotNull(owner.client.home().me)
        assertEquals(setOf(keep, drop), full.projects.map { it.id }.toSet())
        assertEquals(listOf(team), full.teams.map { it.id })
        assertEquals(HttpStatusCode.NoContent, w.admin.client.delete("/api/v1/projects/$drop").status)
        assertEquals(HttpStatusCode.NoContent, w.admin.client.delete("/api/v1/teams/$team").status)
        val me = checkNotNull(owner.client.home().me)
        assertEquals(listOf(keep), me.projects.map { it.id })
        assertEquals(emptyList(), me.teams)
        assertEquals(1, before.projects - w.stranger.client.home().plan.projects)

        // A deleted project and a deleted program leave the lists of the person who held them only through the chain.
        val holder = planCaller("hv9-hold")
        val heldProgram = TestPlan.program(w.streamId, holder.personId!!)
        val inherited = TestPlan.project(heldProgram, owner.personId)
        val held = checkNotNull(holder.client.home().me)
        assertEquals(listOf(heldProgram), held.programs.map { it.id })
        assertEquals(listOf(inherited), held.projects.map { it.id })
        assertEquals(HttpStatusCode.NoContent, w.admin.client.delete("/api/v1/projects/$inherited").status)
        assertEquals(emptyList(), checkNotNull(holder.client.home().me).projects)
        assertEquals(HttpStatusCode.NoContent, w.admin.client.delete("/api/v1/programs/$heldProgram").status)
        assertEquals(emptyList(), checkNotNull(holder.client.home().me).programs)
    }

    @Test
    fun `a list is cut at the service's cap and says so`() = testApplication {
        val o = owned("hv10")
        val me = checkNotNull(o.owner.personId)
        val second = TestPlan.project(o.programId, me, name = "zz-${planName("hv10")}")
        val secondTeam = TestTeams.seed(planName("hv10-zz"), me)
        val caller = HomeCaller(o.owner.userId)
        val database = sharedDatabaseForTests()
        // Self-built services carry no Jira or Flow source: only the rows' ids and sizes are compared with them, never a flag figure.
        val cut = checkNotNull(HomeViewService(database, maxRows = 1).view(caller).me)
        assertTrue(cut.truncated)
        assertEquals(1, cut.projects.size)
        assertEquals(o.projectId, cut.projects.single().id, "the first of the order (the unranked, by name)")
        assertEquals(1, cut.teams.size)
        val whole: HomeMe = checkNotNull(HomeViewService(database).view(caller).me)
        assertFalse(whole.truncated)
        assertEquals(setOf(o.projectId, second), whole.projects.map { it.id }.toSet())
        assertEquals(setOf(o.teamId, secondTeam), whole.teams.map { it.id }.toSet())
        assertNull(HomeViewService(database).view(HomeCaller(o.w.personless.userId)).me)
        // The app's OWN service (its Jira and Flow source) answers what the endpoint answers, whatever other classes left behind.
        val app = application.attributes[HomeViewServiceKey]
        assertEquals(app.view(HomeCaller(o.w.personless.userId)).plan, o.owner.client.home().plan)
    }
}
