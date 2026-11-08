package ch.nokillswit

import ch.nokillswit.planning.DependencyStatus
import ch.nokillswit.planning.DependencyType
import ch.nokillswit.planning.FlagKind
import ch.nokillswit.planning.FlagSeverity
import ch.nokillswit.planning.PlanFlag
import ch.nokillswit.planning.RankingResponse
import ch.nokillswit.planning.RankingUpdateRequest
import ch.nokillswit.planning.RoadmapCriticalPair
import ch.nokillswit.planning.RoadmapCriticalProject
import ch.nokillswit.planning.RoadmapLink
import ch.nokillswit.planning.RoadmapProject
import ch.nokillswit.planning.RoadmapView
import ch.nokillswit.planning.TargetWindowRequest
import ch.nokillswit.plugins.ProblemDetail
import io.ktor.client.HttpClient
import io.ktor.client.call.body
import io.ktor.client.request.delete
import io.ktor.client.request.get
import io.ktor.http.HttpStatusCode
import io.ktor.server.testing.testApplication
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * `GET /views/roadmap` since v0.6.0: the additive fields end to end - derived spans, drift, a flag of each kind, `teams[]` and
 * `teamIds`, the rolled-up links (direct and milestone, both directions) and `can.editTargetWindow` for every kind of caller, checked
 * against the REAL `PUT /projects/{id}/target-window`. The ranking is SHARED suite state: each test replaces it with its own list first
 * (a wholesale PUT), so the neighbours of a flag are always this test's projects. 2027-03-01 and 2027-03-08 are Mondays.
 */
class RoadmapViewTest {
    private val path = "/api/v1/views/roadmap"

    private suspend fun HttpClient.view(): RoadmapView = get(path).body()

    private suspend fun HttpClient.rank(ids: List<UInt>): Long =
        putJson("/api/v1/roadmap/ranking", RankingUpdateRequest(TestPlan.revision(), ids)).body<RankingResponse>().revision

    private fun RoadmapView.project(id: UInt): RoadmapProject = (ranked.map { it.project } + unranked).single { it.id == id }

    private fun RoadmapView.link(predecessor: UInt, successor: UInt): RoadmapLink? =
        links.singleOrNull { it.predecessorProjectId == predecessor && it.successorProjectId == successor }

    private fun flag(kind: FlagKind, severity: FlagSeverity, days: Int, teamId: UInt? = null, other: UInt? = null) =
        PlanFlag(kind, severity, days, teamId, other)

    @Test
    fun `unauthenticated requests are 401`() = testApplication {
        usePostgresTestcontainer()
        assertEquals(HttpStatusCode.Unauthorized, jsonClient().get(path).status)
    }

    @Test
    fun `the wire carries spans, drift, a flag of each kind, teams and teamIds, and the rolled-up links`() = testApplication {
        usePostgresTestcontainer()
        val w = planWorld("rv-wire", teams = true)
        val t = w.requireTeams()
        val owner = w.projectOwner.personId!!
        val a = TestPlan.project(w.programId, owner, planName("A"), "2027-03-01", "2027-03-31")
        val b = TestPlan.project(w.programId, owner, planName("B"), "2027-02-22", "2027-03-02")
        val c = TestPlan.project(w.programId, owner, planName("C"))
        val d = TestPlan.project(w.programId, owner, planName("D"))
        val aMs = TestPlan.milestone(a, t.teamId)
        val bMs = TestPlan.milestone(b, t.teamId)
        val cMs = TestPlan.milestone(c, t.otherTeamId)
        TestPlan.milestone(c, t.teamId, planName("unscheduled"))
        TestPlan.schedule(aMs, "2027-03-08", "2027-03-12")
        TestPlan.schedule(bMs, "2027-03-01", "2027-03-05")
        TestPlan.schedule(cMs, "2027-02-01", "2027-02-05")
        TestPlan.dependency(projectRef(a), projectRef(b))
        TestPlan.dependency(milestoneRef(aMs), milestoneRef(bMs))
        TestPlan.dependency(milestoneRef(cMs), projectRef(a))
        val revision = w.admin.client.rank(listOf(a, b, c))

        val view = w.stranger.client.view()
        assertEquals(revision, view.revision, "the RANKING's revision")
        assertEquals(listOf(a, b, c), view.ranked.map { it.project.id }, "the wholesale PUT left exactly these ranked")
        assertEquals(listOf(1, 2, 3), view.ranked.map { it.position })
        assertTrue(view.ranked.all { it.position == it.project.rankPosition }, "rankPosition mirrors the position")
        assertTrue(d in view.unranked.map { it.id })

        val pa = view.project(a)
        assertEquals(owner, pa.ownerPersonId)
        assertEquals(1, pa.rankPosition)
        assertEquals(listOf(t.teamId), pa.teamIds)
        assertEquals("2027-03-08", pa.span?.start)
        assertEquals("2027-03-12", pa.span?.end)
        assertEquals(7L, pa.drift?.startDays)
        assertEquals(-19L, pa.drift?.endDays)
        assertEquals(
            listOf(flag(FlagKind.DRIFT_START_LATE, FlagSeverity.INFO, 7), flag(FlagKind.DRIFT_END_EARLY, FlagSeverity.INFO, 19)),
            pa.flags,
        )

        val pb = view.project(b)
        assertEquals(
            listOf(
                flag(FlagKind.DRIFT_END_LATE, FlagSeverity.WARNING, 3),
                flag(FlagKind.RANK_INVERSION, FlagSeverity.WARNING, 7, t.teamId, a),
                flag(FlagKind.DRIFT_START_LATE, FlagSeverity.INFO, 7),
            ),
            pb.flags,
            "WARNING first, then by kind",
        )

        val pc = view.project(c)
        assertEquals(listOf(t.teamId, t.otherTeamId).sorted(), pc.teamIds, "unscheduled work counts, ascending")
        assertNull(pc.drift)
        assertEquals(listOf(flag(FlagKind.RANK_INVERSION, FlagSeverity.INFO, 28, null, b)), pc.flags, "no shared team with B")

        val pd = view.project(d)
        assertNull(pd.rankPosition)
        assertNull(pd.span)
        assertNull(pd.drift)
        assertTrue(pd.teamIds.isEmpty() && pd.flags.isEmpty())

        val teamNames = view.teams.associate { it.id to it.name }
        assertTrue(t.teamId in teamNames && t.otherTeamId in teamNames, "the teams with milestones")
        assertEquals(view.teams.sortedWith(compareBy({ it.name.lowercase() }, { it.id })), view.teams, "by name")

        val ab = checkNotNull(view.link(a, b))
        assertEquals(DependencyType.FS, ab.direct?.type)
        assertEquals(DependencyStatus.VIOLATED, ab.direct?.check?.status)
        assertEquals(1, ab.milestoneLinks.count)
        assertEquals(1, ab.milestoneLinks.violated)
        val ca = checkNotNull(view.link(c, a))
        assertNull(ca.direct)
        assertEquals(1, ca.milestoneLinks.count)
        assertEquals(0, ca.milestoneLinks.violated)
        assertNull(view.link(b, a), "only the stored direction")
        val pairs = view.links.map { it.predecessorProjectId to it.successorProjectId }
        assertEquals(pairs.sortedWith(compareBy({ it.first }, { it.second })), pairs, "ordered by (predecessor, successor)")
    }

    @Test
    fun `a deleted project, its milestones and its links leave the view`() = testApplication {
        usePostgresTestcontainer()
        val w = planWorld("rv-gone", teams = true)
        val t = w.requireTeams()
        val owner = w.projectOwner.personId!!
        val keep = TestPlan.project(w.programId, owner)
        val gone = TestPlan.project(w.programId, owner)
        val keepMs = TestPlan.milestone(keep, t.teamId)
        val goneMs = TestPlan.milestone(gone, t.teamId)
        TestPlan.schedule(keepMs, "2027-03-08", "2027-03-12")
        TestPlan.schedule(goneMs, "2027-03-01", "2027-03-05")
        TestPlan.dependency(milestoneRef(keepMs), milestoneRef(goneMs))
        w.admin.client.rank(listOf(keep, gone))
        val before = w.stranger.client.view()
        assertEquals(listOf(warningOnGone(t.teamId, keep)), before.project(gone).flags)
        assertNotNull(before.link(keep, gone))

        assertEquals(HttpStatusCode.NoContent, w.admin.client.delete("/api/v1/projects/$gone").status)
        val after = w.stranger.client.view()
        assertTrue(gone !in (after.ranked.map { it.project.id } + after.unranked.map { it.id }))
        assertNull(after.link(keep, gone))
        assertEquals(emptyList<PlanFlag>(), after.project(keep).flags)
        assertEquals(1, after.project(keep).rankPosition)
    }

    @Test
    fun `deleting a milestone alone removes its span contribution and its team from the view`() = testApplication {
        usePostgresTestcontainer()
        val w = planWorld("rv-msdel", teams = true)
        val t = w.requireTeams()
        val project = TestPlan.project(w.programId, w.projectOwner.personId!!)
        val first = TestPlan.milestone(project, t.teamId)
        val second = TestPlan.milestone(project, t.otherTeamId)
        TestPlan.schedule(first, "2027-03-01", "2027-03-05")
        TestPlan.schedule(second, "2027-03-15", "2027-03-19")
        val before = w.stranger.client.view()
        assertEquals("2027-03-19", before.project(project).span?.end)
        assertEquals(listOf(t.teamId, t.otherTeamId).sorted(), before.project(project).teamIds)
        assertTrue(before.teams.any { it.id == t.otherTeamId })

        assertEquals(HttpStatusCode.NoContent, w.admin.client.delete("/api/v1/milestones/$second").status)
        val afterSecond = w.stranger.client.view()
        assertEquals("2027-03-01", afterSecond.project(project).span?.start)
        assertEquals("2027-03-05", afterSecond.project(project).span?.end)
        assertEquals(listOf(t.teamId), afterSecond.project(project).teamIds)
        assertTrue(afterSecond.teams.none { it.id == t.otherTeamId }, "the team's only milestone is gone")
        assertTrue(afterSecond.teams.any { it.id == t.teamId })

        assertEquals(HttpStatusCode.NoContent, w.admin.client.delete("/api/v1/milestones/$first").status)
        val afterFirst = w.stranger.client.view()
        assertNull(afterFirst.project(project).span)
        assertTrue(afterFirst.project(project).teamIds.isEmpty())
        assertTrue(afterFirst.teams.none { it.id == t.teamId })
    }

    @Test
    fun `deleting a dependency alone removes its links entry, or just its part of the pair`() = testApplication {
        usePostgresTestcontainer()
        val w = planWorld("rv-depdel", teams = true)
        val t = w.requireTeams()
        val owner = w.projectOwner.personId!!
        val a = TestPlan.project(w.programId, owner)
        val b = TestPlan.project(w.programId, owner)
        val aMs = TestPlan.milestone(a, t.teamId)
        val bMs = TestPlan.milestone(b, t.teamId)
        TestPlan.schedule(aMs, "2027-03-01", "2027-03-05")
        TestPlan.schedule(bMs, "2027-03-08", "2027-03-12")
        val direct = TestPlan.dependency(projectRef(a), projectRef(b))
        val bundled = TestPlan.dependency(milestoneRef(aMs), milestoneRef(bMs))
        val both = checkNotNull(w.stranger.client.view().link(a, b))
        assertEquals(direct, both.direct?.id)
        assertEquals(1, both.milestoneLinks.count)

        assertEquals(HttpStatusCode.NoContent, w.admin.client.delete("/api/v1/dependencies/$bundled").status)
        val onlyDirect = checkNotNull(w.stranger.client.view().link(a, b))
        assertEquals(direct, onlyDirect.direct?.id)
        assertEquals(0, onlyDirect.milestoneLinks.count)

        assertEquals(HttpStatusCode.NoContent, w.admin.client.delete("/api/v1/dependencies/$direct").status)
        assertNull(w.stranger.client.view().link(a, b), "no link left between the pair")
    }

    @Test
    fun `a holiday flips the rolled-up links - a lag counts working days of the calendar, and removing it restores the verdict`() =
        testApplication {
            usePostgresTestcontainer()
            val w = planWorld("rv-hol", teams = true)
            val t = w.requireTeams()
            val owner = w.projectOwner.personId!!
            val a = TestPlan.project(w.programId, owner)
            val b = TestPlan.project(w.programId, owner)
            val aMs = TestPlan.milestone(a, t.teamId)
            val bMs = TestPlan.milestone(b, t.teamId)
            TestPlan.schedule(aMs, "2027-03-01", "2027-03-05")
            TestPlan.schedule(bMs, "2027-03-10", "2027-03-12")
            // FS lag 2: a's end is Friday 03-05, so b may start Wednesday 03-10 - exactly met. A holiday on Monday 03-08 takes a working
            // day out of the lag, the requirement moves to Thursday 03-11 and both the direct link and the bundle are violated by one.
            val direct = TestPlan.dependency(projectRef(a), projectRef(b), DependencyType.FS, 2)
            TestPlan.dependency(milestoneRef(aMs), milestoneRef(bMs), DependencyType.FS, 2)
            val plain = checkNotNull(w.stranger.client.view().link(a, b))
            assertEquals(DependencyStatus.OK, plain.direct?.check?.status)
            assertEquals(0, plain.milestoneLinks.violated)

            TestHolidays.with("2027-03-08") {
                val held = checkNotNull(w.stranger.client.view().link(a, b))
                assertEquals(direct, held.direct?.id)
                assertEquals(DependencyStatus.VIOLATED, held.direct?.check?.status)
                assertEquals(1, held.direct?.check?.shortfallDays)
                assertEquals(1, held.milestoneLinks.violated)
            }
            val restored = checkNotNull(w.stranger.client.view().link(a, b))
            assertEquals(DependencyStatus.OK, restored.direct?.check?.status)
            assertEquals(0, restored.milestoneLinks.violated)
        }

    // --- the critical path toward a picked project (1.7) --------------------------------------------------------------------------

    /**
     * The chain world: x1 -> y1 -> p1 (projects X, Y, P; 2027-02-01 is a Monday, one week each) and z1, a week ahead of p1's start, which
     * is five working days of slack for the link z1 -> p1. [empty] is a project with nothing scheduled.
     */
    private class Chain(val x: UInt, val y: UInt, val p: UInt, val z: UInt, val empty: UInt)

    private suspend fun PlanWorld.chain(): Chain {
        val t = requireTeams()
        val owner = projectOwner.personId!!
        val ids = List(5) { TestPlan.project(programId, owner, planName("cp$it")) }
        val (x, y, p) = ids
        val (z, empty) = ids.drop(3)
        suspend fun at(project: UInt, start: String, end: String): UInt =
            TestPlan.milestone(project, t.teamId).also { TestPlan.schedule(it, start, end) }
        val x1 = at(x, "2027-02-01", "2027-02-05")
        val y1 = at(y, "2027-02-08", "2027-02-12")
        val p1 = at(p, "2027-02-15", "2027-02-19")
        val z1 = at(z, "2027-02-01", "2027-02-05")
        TestPlan.milestone(empty, t.teamId)
        TestPlan.dependency(milestoneRef(x1), milestoneRef(y1))
        TestPlan.dependency(milestoneRef(y1), milestoneRef(p1))
        TestPlan.dependency(milestoneRef(z1), milestoneRef(p1))
        return Chain(x, y, p, z, empty)
    }

    private fun JsonElement.withoutCriticalPath(): JsonElement = JsonObject((this as JsonObject).filterKeys { it != "criticalPath" })

    @Test
    fun `criticalPath answers the chain toward the picked project - projects by hops and slack, the critical pairs`() = testApplication {
        usePostgresTestcontainer()
        val w = planWorld("rv-cp", teams = true)
        val c = w.chain()
        val block = assertNotNull(w.stranger.client.get("$path?criticalPath=${c.p}").body<RoadmapView>().criticalPath)

        assertEquals(c.p, block.projectId)
        assertEquals(
            listOf(
                RoadmapCriticalProject(c.y, 0, true, 1),
                RoadmapCriticalProject(c.z, 5, false, 1),
                RoadmapCriticalProject(c.x, 0, true, 2),
            ),
            block.projects,
            "the target is implied; Z has slack and is off the chain",
        )
        assertEquals(
            listOf(RoadmapCriticalPair(c.x, c.y), RoadmapCriticalPair(c.y, c.p))
                .sortedWith(compareBy({ it.predecessorProjectId }, { it.successorProjectId })),
            block.pairs,
        )
        // Another target of the same plan: Y's chain is X alone; the same document otherwise.
        val toY = assertNotNull(w.stranger.client.get("$path?criticalPath=${c.y}").body<RoadmapView>().criticalPath)
        assertEquals(listOf(RoadmapCriticalProject(c.x, 0, true, 1)), toY.projects)
        assertEquals(listOf(RoadmapCriticalPair(c.x, c.y)), toY.pairs)
    }

    @Test
    fun `a target with nothing scheduled answers empty lists, and a target upstream of nothing has no chain`() = testApplication {
        usePostgresTestcontainer()
        val w = planWorld("rv-cp-empty", teams = true)
        val c = w.chain()
        val empty = assertNotNull(w.stranger.client.get("$path?criticalPath=${c.empty}").body<RoadmapView>().criticalPath)
        assertEquals(c.empty, empty.projectId)
        assertTrue(empty.projects.isEmpty() && empty.pairs.isEmpty())
        val first = assertNotNull(w.stranger.client.get("$path?criticalPath=${c.x}").body<RoadmapView>().criticalPath)
        assertTrue(first.projects.isEmpty() && first.pairs.isEmpty(), "nothing is upstream of the first project")
    }

    @Test
    fun `without the parameter there is no criticalPath key, with it the plain document plus that key - baseline combines`() =
        testApplication {
            usePostgresTestcontainer()
            val w = planWorld("rv-cp-add", teams = true)
            val c = w.chain()
            val client = w.stranger.client
            val plain = client.rawJson(path)
            assertFalse((plain as JsonObject).containsKey("criticalPath"), "the plain document is exactly what it was")
            val picked = client.rawJson("$path?criticalPath=${c.p}")
            assertEquals(plain, picked.withoutCriticalPath(), "the parameter only adds the block")
            assertTrue((picked as JsonObject).containsKey("criticalPath"))

            val id = TestPlan.baseline()
            try {
                val both = client.get("$path?baseline=$id&criticalPath=${c.p}").body<RoadmapView>()
                assertNotNull(both.baseline, "the baseline block")
                assertEquals(c.p, assertNotNull(both.criticalPath, "and the chain").projectId)
                assertEquals(
                    client.get("$path?baseline=$id").body<RoadmapView>().copy(criticalPath = null),
                    both.copy(criticalPath = null),
                    "independent blocks",
                )
            } finally {
                TestPlan.deleteBaseline(id)
            }
        }

    @Test
    fun `criticalPath is refused with 400 - malformed, repeated, unknown, deleted`() = testApplication {
        usePostgresTestcontainer()
        val w = planWorld("rv-cp-400", teams = true)
        val c = w.chain()
        val client = w.stranger.client
        for (malformed in listOf("abc", "-1", "1.5", "99999999999", "${c.p}&criticalPath=${c.x}")) {
            val response = client.get("$path?criticalPath=$malformed")
            assertEquals(HttpStatusCode.BadRequest, response.status, "?criticalPath=$malformed")
            assertEquals("about:blank", response.body<ProblemDetail>().type, "?criticalPath=$malformed is a plain 400")
        }
        val unknown = client.get("$path?criticalPath=999999")
        assertEquals(HttpStatusCode.BadRequest, unknown.status)
        assertEquals("Unknown or deleted project id: 999999", unknown.body<ProblemDetail>().detail)

        assertEquals(HttpStatusCode.NoContent, w.admin.client.delete("/api/v1/projects/${c.z}").status)
        val gone = client.get("$path?criticalPath=${c.z}")
        assertEquals(HttpStatusCode.BadRequest, gone.status, "a soft-deleted project")
        assertEquals("Unknown or deleted project id: ${c.z}", gone.body<ProblemDetail>().detail)
        // A deleted project leaves the chain of the others: Z's link is gone with it.
        val toP = assertNotNull(client.get("$path?criticalPath=${c.p}").body<RoadmapView>().criticalPath)
        assertEquals(listOf(c.y, c.x), toP.projects.map { it.projectId })
    }

    private fun warningOnGone(teamId: UInt, other: UInt) = flag(FlagKind.RANK_INVERSION, FlagSeverity.WARNING, 7, teamId, other)

    @Test
    fun `can editTargetWindow matches what the real target-window PUT lets through for every kind of caller`() = testApplication {
        usePostgresTestcontainer()
        val w = planWorld("rv-can", teams = true)
        val t = w.requireTeams()
        val everyone = listOf(
            "admin" to (w.admin to true),
            "stream owner" to (w.streamOwner to true),
            "program owner" to (w.programOwner to true),
            "project owner" to (w.projectOwner to false),
            "roadmap editor" to (w.editor to true),
            "stranger" to (w.stranger to false),
            "person-less login" to (w.personless to false),
            "team manager" to (t.manager to false),
        )
        for ((label, entry) in everyone) {
            val (caller, expected) = entry
            val project = caller.client.view().project(w.projectId)
            assertEquals(expected, project.can.editTargetWindow, "$label: the flag")
            val put = caller.client.putJson(
                "/api/v1/projects/${project.id}/target-window",
                TargetWindowRequest(project.targetStart, project.targetEnd),
            )
            val allowed = if (project.can.editTargetWindow) HttpStatusCode.NoContent else HttpStatusCode.Forbidden
            assertEquals(allowed, put.status, "$label: the real PUT")
        }
        // The flag follows the chain of EACH project: the project's own owner may not move the band of a project they merely own.
        val second = secondProject(w)
        assertEquals(false, second.owner.client.view().project(second.projectId).can.editTargetWindow)
        assertEquals(true, w.programOwner.client.view().project(second.projectId).can.editTargetWindow)
    }
}
