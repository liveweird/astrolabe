package ch.nokillswit

import ch.nokillswit.flow.CapacityDeviationService
import ch.nokillswit.flow.FlowFlagSource
import ch.nokillswit.flow.FlowMirrorStore
import ch.nokillswit.flow.FlowTeamBindingService
import ch.nokillswit.jira.DeviationViewServiceKey
import ch.nokillswit.jira.JiraFlagSource
import ch.nokillswit.planning.CompositeExternalFlagSource
import ch.nokillswit.planning.FlagCounts
import ch.nokillswit.planning.FlagKind
import ch.nokillswit.planning.FlagSeverity
import ch.nokillswit.planning.HomeView
import ch.nokillswit.planning.PlanActor
import ch.nokillswit.planning.PlanFlag
import ch.nokillswit.planning.ProgramsView
import ch.nokillswit.planning.RoadmapProject
import ch.nokillswit.planning.RoadmapView
import ch.nokillswit.planning.RoadmapViewService
import ch.nokillswit.planning.TeamView
import ch.nokillswit.sync.SyncRunService
import io.ktor.client.HttpClient
import io.ktor.client.call.body
import io.ktor.client.request.get
import io.ktor.client.request.header
import io.ktor.http.HttpHeaders
import io.ktor.http.HttpStatusCode
import io.ktor.server.testing.ApplicationTestBuilder
import io.ktor.server.testing.testApplication
import kotlin.test.AfterTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNotNull
import kotlin.test.assertTrue

/**
 * The Flow capacity flag on the Roadmap's and Programs' project rows (1.23, `FLOW_CAPACITY_MILESTONES`) through HTTP, over
 * `CapacityAcknowledgeSupport`'s scripted world: on day two the team's sprint 2 (WARNING, 2049-03-15..03-26) and sprint 3 (INFO,
 * 2049-03-29..04-09) are open, the other team's Flow team is gone. The kernel's date test is `RoadmapKernelsTest`'s, the source's states
 * are `FlowFlagSourceTest`'s; here the whole path is exercised: a flag per team for the projects whose scheduled milestones lie in the
 * disputed days, the roll-ups that count it, the validators and the statements. Plan tables are SHARED: rows are looked up by id and
 * every plan-wide figure is a delta around this test's own writes.
 */
class RoadmapFlowFlagTest {
    private val mirrors = mutableListOf<ScriptedFlowMirror>()

    @AfterTest
    fun cleanUp() {
        mirrors.forEach { it.cleanUp() }
        mirrors.clear()
        removeFlowFixtureRows(CAPACK_PREFIX)
    }

    private suspend fun ApplicationTestBuilder.dayTwo(label: String): CapAckWorld = capAckWorld(label, mirrors).also { it.refresh() }

    private suspend fun HttpClient.roadmap(query: String = ""): RoadmapView = get("/api/v1/views/roadmap$query").body()

    private suspend fun HttpClient.programs(): ProgramsView = get("/api/v1/views/programs").body()

    private suspend fun HttpClient.home(): HomeView = get("/api/v1/views/home").body()

    private suspend fun HttpClient.team(id: UInt): TeamView = get("/api/v1/views/team/$id").body()

    private fun RoadmapView.row(id: UInt): RoadmapProject = (ranked.map { it.project } + unranked).single { it.id == id }

    private fun ProgramsView.row(id: UInt): RoadmapProject =
        workStreams.flatMap { it.programs }.flatMap { it.projects }.single { it.id == id }

    private fun RoadmapProject.capacity(): List<PlanFlag> = flags.filter { it.kind == FlagKind.FLOW_CAPACITY_MILESTONES }

    private fun capacity(teamId: UInt, severity: FlagSeverity, count: Int) =
        PlanFlag(FlagKind.FLOW_CAPACITY_MILESTONES, severity, teamId = teamId, count = count)

    /** A milestone of [project] on [team] scheduled [start]..[end] (null = left unscheduled). */
    private suspend fun milestone(project: UInt, team: UInt, start: String?, end: String? = start): UInt =
        TestPlan.milestone(project, team, planName("rff")).also { if (start != null) TestPlan.schedule(it, start, end) }

    private suspend fun CapAckWorld.secondProject(): UInt = TestPlan.project(w.programId, w.projectOwner.personId!!, planName("rff-pj"))

    @Test
    fun `a milestone across the disputed sprints flags its project once per team on the roadmap and programs views`() = testApplication {
        val world = dayTwo("rff1")
        with(world) {
            val client = w.stranger.client
            milestone(w.projectId, teamId, "2049-03-17", "2049-03-19")
            for (row in listOf(client.roadmap().row(w.projectId), client.programs().row(w.projectId))) {
                assertEquals(listOf(capacity(teamId, FlagSeverity.WARNING, 1)), row.capacity())
            }
            // The week no open row covers (sprint 1, in line with Flow: Monday 03-08 to Friday 03-12) adds nothing.
            milestone(w.projectId, teamId, "2049-03-08", "2049-03-12")
            assertEquals(listOf(capacity(teamId, FlagSeverity.WARNING, 1)), client.roadmap().row(w.projectId).capacity())
            // One inside the INFO sprint makes the count 2; the flag stays at the worst severity.
            milestone(w.projectId, teamId, "2049-04-01", "2049-04-02")
            for (row in listOf(client.roadmap().row(w.projectId), client.programs().row(w.projectId))) {
                assertEquals(listOf(capacity(teamId, FlagSeverity.WARNING, 2)), row.capacity())
            }
            // ... and it is a flag of its own kind: none of the members the other kinds use.
            val flag = client.roadmap().row(w.projectId).capacity().single()
            assertEquals(listOf(null, null, null), listOf(flag.days, flag.otherProjectId, flag.deviation))
        }
    }

    @Test
    fun `a project whose only milestone lies in the INFO sprints carries an INFO, a project with none in the dispute carries none`() =
        testApplication {
            val world = dayTwo("rff2")
            with(world) {
                val client = w.admin.client
                milestone(w.projectId, teamId, "2049-04-05", "2049-04-09")
                val clear = secondProject().also { milestone(it, teamId, "2049-05-03", "2049-05-07") }
                val roadmap = client.roadmap()
                assertEquals(listOf(capacity(teamId, FlagSeverity.INFO, 1)), roadmap.row(w.projectId).capacity())
                assertEquals(emptyList(), roadmap.row(clear).capacity(), "dates after the disputed sprints")
            }
        }

    @Test
    fun `an unscheduled milestone and a gone Flow team's milestone raise no project flag but the header flags`() = testApplication {
        val world = dayTwo("rff3")
        with(world) {
            val other = w.requireTeams().otherTeamId
            milestone(w.projectId, teamId, null)
            milestone(w.projectId, other, "2049-03-15", "2049-03-19")
            val row = w.admin.client.roadmap().row(w.projectId)
            assertEquals(emptyList(), row.capacity(), "unscheduled has no days; TEAM_GONE holds none")
            assertEquals(1, w.admin.client.team(other).team.flags.single().count, "the gone team's header flags")
        }
    }

    @Test
    fun `acknowledging the warning leaves an INFO, both leave none, a changed figure flags again`() = testApplication {
        val world = dayTwo("rff4")
        with(world) {
            val client = w.admin.client
            milestone(w.projectId, teamId, "2049-03-17", "2049-03-19")
            milestone(w.projectId, teamId, "2049-04-01", "2049-04-02")
            assertEquals(capacity(teamId, FlagSeverity.WARNING, 2), client.roadmap().row(w.projectId).capacity().single())

            manager.client.capAck(bindingId, 2, client.rowOf(2).fingerprint).capAcknowledgement()
            assertEquals(capacity(teamId, FlagSeverity.INFO, 1), client.roadmap().row(w.projectId).capacity().single())

            manager.client.capAck(bindingId, 3, client.rowOf(3).fingerprint).capAcknowledgement()
            assertEquals(emptyList(), client.roadmap().row(w.projectId).capacity())
            assertEquals(emptyList(), client.programs().row(w.projectId).capacity())

            jbSql("UPDATE team_capacity_periods SET md_per_week = 17 WHERE team_id = ? AND flow_sprint_id = 2", teamId.toInt())
            assertEquals(capacity(teamId, FlagSeverity.WARNING, 1), client.roadmap().row(w.projectId).capacity().single())
        }
    }

    @Test
    fun `a disabled connection flags nothing, enabling it flags again, and the roll-ups move by exactly that flag`() = testApplication {
        val world = dayTwo("rff5")
        with(world) {
            val client = w.stranger.client
            milestone(w.projectId, teamId, "2049-03-17", "2049-03-19")
            fun ProgramsView.counts(): Pair<FlagCounts, FlagCounts> {
                val stream = workStreams.single { it.id == w.streamId }
                return stream.flags to stream.programs.single { it.id == w.programId }.flags
            }

            val enabledPrograms = client.programs().counts()
            val enabledHome = client.home().plan.flags
            assertEquals(1, client.roadmap().row(w.projectId).capacity().size)

            jbSql("UPDATE flow_connections SET enabled = FALSE WHERE id = ?", mirror.connectionId.toInt())
            assertEquals(emptyList(), client.roadmap().row(w.projectId).capacity())
            val disabledPrograms = client.programs().counts()
            val disabledHome = client.home().plan.flags
            assertEquals(1, enabledPrograms.first.warnings - disabledPrograms.first.warnings, "the work stream's roll-up")
            assertEquals(1, enabledPrograms.second.warnings - disabledPrograms.second.warnings, "the program's roll-up")
            assertEquals(0, enabledPrograms.first.infos - disabledPrograms.first.infos)
            assertEquals(1, enabledHome.warnings - disabledHome.warnings, "Home's plan block")
            assertEquals(0, enabledHome.infos - disabledHome.infos)

            jbSql("UPDATE flow_connections SET enabled = TRUE WHERE id = ?", mirror.connectionId.toInt())
            assertEquals(capacity(teamId, FlagSeverity.WARNING, 1), client.roadmap().row(w.projectId).capacity().single())
        }
    }

    @Test
    fun `an administrator, the owner and a stranger read the same flags, and so does baseline N`() = testApplication {
        val world = dayTwo("rff6")
        with(world) {
            milestone(w.projectId, teamId, "2049-03-17", "2049-03-19")
            val admin = w.admin.client.roadmap().row(w.projectId).flags
            assertEquals(admin, w.projectOwner.client.roadmap().row(w.projectId).flags)
            assertEquals(admin, w.stranger.client.roadmap().row(w.projectId).flags)
            assertEquals(admin, w.stranger.client.programs().row(w.projectId).flags)
            val baselineId = TestPlan.baseline(planName("rff-bl"))
            val compared = w.admin.client.roadmap("?baseline=$baselineId")
            assertNotNull(compared.baseline, "the baseline block is there")
            assertEquals(admin, compared.row(w.projectId).flags)
        }
    }

    @Test
    fun `an acknowledge makes the next conditional roadmap read a 200`() = testApplication {
        val world = dayTwo("rff7")
        with(world) {
            val client = w.admin.client
            milestone(w.projectId, teamId, "2049-03-17", "2049-03-19")
            val first = client.get("/api/v1/views/roadmap")
            val tag = assertNotNull(first.headers[HttpHeaders.ETag])
            assertEquals(
                HttpStatusCode.NotModified,
                client.get("/api/v1/views/roadmap") { header(HttpHeaders.IfNoneMatch, tag) }.status,
                "nothing moved: the tag still matches",
            )
            manager.client.capAck(bindingId, 2, client.rowOf(2).fingerprint).capAcknowledgement()
            val after = client.get("/api/v1/views/roadmap") { header(HttpHeaders.IfNoneMatch, tag) }
            assertEquals(HttpStatusCode.OK, after.status, "the flag left the document, so its tag changed")
            assertTrue(after.headers[HttpHeaders.ETag] != tag)
        }
    }

    @Test
    fun `an enabled Flow connection reads each Flow table once for every team, and the figures`() = testApplication {
        val world = dayTwo("rff8")
        with(world) {
            val client = w.admin.client
            milestone(w.projectId, teamId, "2049-03-17", "2049-03-19")
            // The Flow services are built on the COUNTING database too: the app's own sit on the app's pool and nest their reads into
            // the view's transaction without passing the counter, so only their composition here shows the five statements.
            suspend fun roadmapStatements(): List<String> {
                val (database, factory) = countingDatabase()
                val deviations = CapacityDeviationService(
                    database, FlowTeamBindingService(database), FlowMirrorStore(database), capacityService(database),
                    SyncRunService(database, maxRunMinutes = 30),
                )
                val source = CompositeExternalFlagSource(
                    listOf(JiraFlagSource(application.attributes[DeviationViewServiceKey]), FlowFlagSource(deviations)),
                )
                RoadmapViewService(database, source).view(NEUTRAL_ACTOR)
                return factory.sql.filter { !it.startsWith("SELECT current_database()") }
            }

            suspend fun median(): Double {
                client.roadmap()
                val timings = List(RUNS) {
                    val started = System.nanoTime()
                    client.roadmap()
                    (System.nanoTime() - started) / NANOS_PER_MILLI
                }
                return ScaleFigures.median(timings)
            }

            val enabled = roadmapStatements()
            val enabledMs = median()
            jbSql("UPDATE flow_connections SET enabled = FALSE WHERE id = ?", mirror.connectionId.toInt())
            val disabled = roadmapStatements()
            val disabledMs = median()
            println("scale-figure\troadmap flow flag: statements, the connection enabled\t${enabled.size}")
            println("scale-figure\troadmap flow flag: statements, the connection disabled\t${disabled.size}")
            ScaleFigures.print("roadmap flow flag: median, the connection enabled", enabledMs)
            ScaleFigures.print("roadmap flow flag: median, the connection disabled", disabledMs)
            // Absolute per-table pins in the ENABLED run: each table is read ONCE for every team, however many other connections the
            // shared database holds, and a per-team loop breaks them (the roadmap read touches none of these tables otherwise).
            for (table in listOf("flow_team_bindings", "team_capacity_periods", "flow_capacity_acknowledgements")) {
                assertEquals(1, enabled.count { table in it }, "$table is read once:\n${enabled.joinToString("\n")}")
            }
            val mirrorReads = enabled.count { "flow_teams" in it && "flow_sprints" in it }
            assertEquals(1, mirrorReads, "the mirror is read once:\n${enabled.joinToString("\n")}")
        }
    }

    private companion object {
        const val RUNS = 5
        const val NANOS_PER_MILLI = 1_000_000.0

        /** The actor that may do nothing: the flags are the same for everybody. */
        val NEUTRAL_ACTOR = PlanActor(isAdmin = false, personId = null, roadmapEditor = false, managedTeamIds = emptySet())
    }
}
