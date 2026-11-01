package ch.nokillswit

import ch.nokillswit.planning.FlagCounts
import ch.nokillswit.planning.FlagKind
import ch.nokillswit.planning.FlagSeverity
import ch.nokillswit.planning.ProgramsProgram
import ch.nokillswit.planning.ProgramsView
import ch.nokillswit.planning.ProgramsWorkStream
import ch.nokillswit.planning.RankingResponse
import ch.nokillswit.planning.RankingUpdateRequest
import ch.nokillswit.planning.RoadmapProject
import ch.nokillswit.planning.RoadmapView
import io.ktor.client.HttpClient
import io.ktor.client.call.body
import io.ktor.client.request.delete
import io.ktor.client.request.get
import io.ktor.http.HttpStatusCode
import io.ktor.server.testing.testApplication
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNotEquals
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * `GET /views/programs` (v0.6.0): the tree order, the empty programs and work streams, the derived program and stream spans, the flag
 * roll-ups, and that its project rows, `teams` and `links` are the roadmap view's for the same plan. The plan tables are SHARED suite
 * state: every assertion filters to this test's own nodes by a unique name tag. 2027-02-01 and 2027-03-01 are Mondays.
 */
class ProgramsViewTest {
    private val path = "/api/v1/views/programs"

    private suspend fun HttpClient.programs(): ProgramsView = get(path).body()

    private suspend fun HttpClient.roadmap(): RoadmapView = get("/api/v1/views/roadmap").body()

    private suspend fun HttpClient.rank(ids: List<UInt>): Long =
        putJson("/api/v1/roadmap/ranking", RankingUpdateRequest(TestPlan.revision(), ids)).body<RankingResponse>().revision

    private fun ProgramsView.mine(tag: String): List<ProgramsWorkStream> = workStreams.filter { it.name.startsWith(tag) }

    private fun ProgramsView.allProjects(): List<RoadmapProject> = workStreams.flatMap { it.programs }.flatMap { it.projects }

    private fun ProgramsWorkStream.program(name: String): ProgramsProgram = programs.single { it.name == name }

    @Test
    fun `unauthenticated requests are 401`() = testApplication {
        usePostgresTestcontainer()
        assertEquals(HttpStatusCode.Unauthorized, jsonClient().get(path).status)
    }

    @Test
    fun `the tree is ordered, keeps empty nodes, derives the spans and rolls the flags up`() = testApplication {
        usePostgresTestcontainer()
        val w = planWorld("pv-tree", teams = true)
        val team = w.requireTeams().teamId
        val owner = w.streamOwner.personId!!
        val projectOwner = w.projectOwner.personId!!
        val tag = planName("pvt")

        // Names sort case-insensitively: Alpha < bravo < Charlie (a case-sensitive sort would put bravo last), closed ones after open.
        val bravo = TestPlan.workStream(owner, "$tag-bravo")
        val alpha = TestPlan.workStream(owner, "$tag-Alpha")
        val closed = TestPlan.workStream(owner, "$tag-aaa-closed", endDate = "2026-12-31")
        val emptyStream = TestPlan.workStream(owner, "$tag-Charlie-empty")
        val pB = TestPlan.program(alpha, owner, "$tag-pB")
        val pA = TestPlan.program(alpha, owner, "$tag-Pa-empty")
        val pC = TestPlan.program(alpha, owner, "$tag-pC")
        val pClosed = TestPlan.program(closed, owner, "$tag-pClosed")
        TestPlan.program(bravo, owner, "$tag-pBravo")

        val first = TestPlan.project(pB, projectOwner, "$tag-first", "2027-03-01", "2027-03-05")
        val second = TestPlan.project(pB, projectOwner, "$tag-second")
        val aaa = TestPlan.project(pB, projectOwner, "$tag-aaa-unranked")
        val zzz = TestPlan.project(pB, projectOwner, "$tag-ZZZ-unranked")
        val early = TestPlan.project(pC, projectOwner, "$tag-early")
        val inClosed = TestPlan.project(pClosed, projectOwner, "$tag-inClosed")
        TestPlan.schedule(TestPlan.milestone(first, team), "2027-03-08", "2027-03-12")
        TestPlan.schedule(TestPlan.milestone(second, team), "2027-03-15", "2027-03-19")
        TestPlan.schedule(TestPlan.milestone(early, team), "2027-02-01", "2027-02-05")
        TestPlan.schedule(TestPlan.milestone(inClosed, team), "2027-04-05", "2027-04-09")
        w.admin.client.rank(listOf(second, first, inClosed))

        val view = w.stranger.client.programs()
        val streams = view.mine(tag)
        assertEquals(
            listOf(alpha, bravo, emptyStream, closed),
            streams.map { it.id },
            "open streams by name (case-insensitive), then the closed one",
        )
        assertEquals(listOf(null, null, null, "2026-12-31"), streams.map { it.endDate })
        assertEquals("2026-01-01", streams.first().startDate)

        val a = streams.first()
        assertEquals(listOf(pA, pB, pC), a.programs.map { it.id }, "programs by name, case-insensitive; the empty one is present")
        assertTrue(a.ownerName.isNotBlank() && a.programs.all { it.ownerName == a.ownerName }, "the owner's name rides on every level")

        val empty = a.program("$tag-Pa-empty")
        assertTrue(empty.projects.isEmpty())
        assertNull(empty.span)
        assertEquals(FlagCounts(0, 0), empty.flags)

        val pb = a.program("$tag-pB")
        assertEquals(listOf(second, first, aaa, zzz), pb.projects.map { it.id }, "ranked in rank order, then the unranked by name")
        assertEquals(listOf(1, 2, null, null), pb.projects.map { it.rankPosition })
        assertEquals("2027-03-08", pb.span?.start)
        assertEquals("2027-03-19", pb.span?.end)
        val firstFlags = pb.projects.single { it.id == first }.flags
        assertEquals(
            listOf(FlagKind.DRIFT_END_LATE, FlagKind.RANK_INVERSION, FlagKind.DRIFT_START_LATE),
            firstFlags.map { it.kind },
            "first ends late, starts late and starts before the higher-ranked second on the shared team",
        )
        assertEquals(FlagCounts(warnings = 2, infos = 1), pb.flags)

        val early0 = a.program("$tag-pC")
        assertEquals("2027-02-01", early0.span?.start)
        assertEquals("2027-02-05", early0.span?.end)
        assertEquals(FlagCounts(0, 0), early0.flags, "an unranked project with no window raises nothing")

        assertEquals("2027-02-01", a.span?.start, "the stream's span is derived from its programs' spans")
        assertEquals("2027-03-19", a.span?.end)
        assertEquals(FlagCounts(warnings = 2, infos = 1), a.flags)

        val b = streams[1]
        assertEquals(1, b.programs.size)
        assertTrue(b.program("$tag-pBravo").projects.isEmpty())
        assertNull(b.span)
        val e = streams[2]
        assertTrue(e.programs.isEmpty())
        assertNull(e.span)
        assertEquals(FlagCounts(0, 0), e.flags)
        val c = streams[3]
        assertEquals(inClosed, c.program("$tag-pClosed").projects.single().id)
        assertEquals("2027-04-05", c.span?.start)

        // Every roll-up is the sum of its projects' flags, whatever the plan holds.
        for (stream in view.workStreams) {
            for (program in stream.programs) {
                val all = program.projects.flatMap { it.flags }
                assertEquals(all.count { it.severity == FlagSeverity.WARNING }, program.flags.warnings, "${program.name} warnings")
                assertEquals(all.count { it.severity == FlagSeverity.INFO }, program.flags.infos, "${program.name} infos")
            }
            assertEquals(stream.programs.sumOf { it.flags.warnings }, stream.flags.warnings, "${stream.name} warnings")
            assertEquals(stream.programs.sumOf { it.flags.infos }, stream.flags.infos, "${stream.name} infos")
        }
    }

    @Test
    fun `the project rows, teams and links are the roadmap view's, for every kind of caller`() = testApplication {
        usePostgresTestcontainer()
        val w = planWorld("pv-same", teams = true)
        val t = w.requireTeams()
        val owner = w.projectOwner.personId!!
        val a = TestPlan.project(w.programId, owner, planName("A"), "2027-03-01", "2027-03-31")
        val b = TestPlan.project(w.programId, owner, planName("B"), "2027-02-22", "2027-03-02")
        val aMs = TestPlan.milestone(a, t.teamId)
        val bMs = TestPlan.milestone(b, t.otherTeamId)
        TestPlan.schedule(aMs, "2027-03-08", "2027-03-12")
        TestPlan.schedule(bMs, "2027-03-01", "2027-03-05")
        TestPlan.dependency(projectRef(a), projectRef(b))
        TestPlan.dependency(milestoneRef(aMs), milestoneRef(bMs))
        w.admin.client.rank(listOf(a, b))

        val callers = listOf(w.admin, w.streamOwner, w.programOwner, w.projectOwner, w.editor, w.stranger, w.personless)
        for (caller in callers) {
            val programs = caller.client.programs()
            val roadmap = caller.client.roadmap()
            val roadmapRows = (roadmap.ranked.map { it.project } + roadmap.unranked).associateBy { it.id }
            val rows = programs.allProjects().associateBy { it.id }
            assertEquals(roadmapRows, rows, "the same rows, flags and can for caller ${caller.userId}")
            assertEquals(roadmap.teams, programs.teams)
            assertEquals(roadmap.links, programs.links)
            assertNotNull(programs.links.singleOrNull { it.predecessorProjectId == a && it.successorProjectId == b }?.direct)
        }
        assertEquals(true, w.admin.client.programs().allProjects().single { it.id == a }.can.editTargetWindow)
        assertEquals(false, w.stranger.client.programs().allProjects().single { it.id == a }.can.editTargetWindow)
    }

    @Test
    fun `the revision is the plan's, not the ranking's`() = testApplication {
        usePostgresTestcontainer()
        val w = planWorld("pv-rev", teams = true)
        val rankingRevision = w.admin.client.rank(listOf(w.projectId))
        TestPlan.milestone(w.projectId, w.requireTeams().teamId)
        val plan = TestPlan.revision()
        assertTrue(plan > rankingRevision, "a plan write elsewhere moved the plan revision only")

        assertEquals(plan, w.stranger.client.programs().revision)
        assertEquals(rankingRevision, w.stranger.client.roadmap().revision)
        assertNotEquals(w.stranger.client.roadmap().revision, w.stranger.client.programs().revision)
    }

    @Test
    fun `a deleted project leaves its program empty, a deleted program and work stream leave the view`() = testApplication {
        usePostgresTestcontainer()
        val w = planWorld("pv-del", teams = true)
        val owner = w.streamOwner.personId!!
        val tag = planName("pvd")
        val stream = TestPlan.workStream(owner, "$tag-ws")
        val program = TestPlan.program(stream, owner, "$tag-pg")
        val project = TestPlan.project(program, w.projectOwner.personId!!, "$tag-pj")
        TestPlan.schedule(TestPlan.milestone(project, w.requireTeams().teamId), "2027-03-08", "2027-03-12")
        val before = w.stranger.client.programs().mine(tag).single()
        assertEquals(project, before.programs.single().projects.single().id)
        assertEquals("2027-03-08", before.span?.start)

        assertEquals(HttpStatusCode.NoContent, w.admin.client.delete("/api/v1/projects/$project").status)
        val afterProject = w.stranger.client.programs().mine(tag).single()
        assertTrue(afterProject.programs.single().projects.isEmpty(), "the program stays, empty")
        assertNull(afterProject.programs.single().span)
        assertNull(afterProject.span)

        assertEquals(HttpStatusCode.NoContent, w.admin.client.delete("/api/v1/programs/$program").status)
        val afterProgram = w.stranger.client.programs().mine(tag).single()
        assertTrue(afterProgram.programs.isEmpty(), "the work stream stays, empty")

        assertEquals(HttpStatusCode.NoContent, w.admin.client.delete("/api/v1/work-streams/$stream").status)
        assertTrue(w.stranger.client.programs().mine(tag).isEmpty())
    }
}
