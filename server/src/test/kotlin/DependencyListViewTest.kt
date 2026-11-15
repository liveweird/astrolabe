package ch.nokillswit

import ch.nokillswit.planning.DependencyListRow
import ch.nokillswit.planning.DependencyListView
import ch.nokillswit.planning.DependencyListViewService
import ch.nokillswit.planning.DependencyStatus
import ch.nokillswit.planning.DependencyType
import ch.nokillswit.planning.HomeView
import ch.nokillswit.planning.MAX_DEPENDENCY_ROWS
import ch.nokillswit.planning.PlanActor
import ch.nokillswit.planning.ProjectDependency
import ch.nokillswit.planning.ProjectDependencyCan
import ch.nokillswit.planning.ProjectView
import ch.nokillswit.planning.TeamView
import io.ktor.client.HttpClient
import io.ktor.client.call.body
import io.ktor.client.request.delete
import io.ktor.client.request.get
import io.ktor.client.statement.bodyAsText
import io.ktor.http.HttpStatusCode
import io.ktor.server.testing.ApplicationTestBuilder
import io.ktor.server.testing.testApplication
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

/**
 * `GET /views/dependencies` (1.20.0): every link of the plan, the ones that do not hold first. Each row is compared with the item the
 * project and team pages answer for the same link, and `totals.violated` with Home's `plan.conflicts`, read in the same test. The plan
 * tables are shared state, so a plan-wide figure is never asserted as an absolute number: a total is a delta around this test's own
 * seeding, and a row is looked up by its link's id on the uncapped document ([uncapped]). No Jira or Flow stub (no external source).
 * Since 1.22.0 each row carries the caller's `can`: compared with the project and team pages' items for every kind of caller, and each
 * flag against the real `PUT` and `DELETE /dependencies/{id}`. 2027-02-01 is a Monday.
 */
class DependencyListViewTest {
    private val path = "/api/v1/views/dependencies"

    private companion object {
        val NOBODY = PlanActor(isAdmin = false, personId = null, roadmapEditor = false, managedTeamIds = emptySet())
    }

    private suspend fun HttpClient.load(): DependencyListView = get(path).body()

    private suspend fun HttpClient.home(): HomeView = get("/api/v1/views/home").body()

    private suspend fun HttpClient.project(id: UInt): ProjectView = get("/api/v1/views/project/$id").body()

    private suspend fun HttpClient.team(id: UInt): TeamView = get("/api/v1/views/team/$id").body()

    /** The links, violated and unscheduled counts that moved since [base]. */
    private fun DependencyListView.figuresSince(base: DependencyListView) =
        listOf(totals.links - base.totals.links, totals.violated - base.totals.violated, totals.unscheduled - base.totals.unscheduled)

    private fun DependencyListView.row(id: UInt): DependencyListRow = dependencies.single { it.id == id }

    /**
     * The document with NO row cap. The endpoint cuts at 1,000 rows (the unscheduled and kept links go first) and the shared database
     * of a CI fork holds the links of hundreds of other classes, so row lookups and "not truncated" claims are made here; the HTTP
     * reads keep what only HTTP proves (status, shape, one body for every caller, the cut itself).
     */
    private suspend fun uncapped(actor: PlanActor = NOBODY): DependencyListView =
        DependencyListViewService(sharedDatabaseForTests(), maxRows = Int.MAX_VALUE).view(actor)

    /** The actor the route would resolve for [caller] (the dependency flags read the administrator flag and the person only). */
    private fun PlanWorld.actorOf(caller: PlanCaller) =
        PlanActor(isAdmin = caller === admin, personId = caller.personId, roadmapEditor = false, managedTeamIds = emptySet())

    /** Every kind of caller of the world, plus the owner of the second project (the successor project's owner of the seeded links). */
    private fun callers(s: Seeded, t: PlanTeams): List<Pair<String, PlanCaller>> = listOf(
        "admin" to s.w.admin, "stream owner" to s.w.streamOwner, "program owner" to s.w.programOwner,
        "the first project's owner" to s.w.projectOwner, "the second project's owner" to s.other.owner, "team manager" to t.manager,
        "stranger" to s.w.stranger, "personless" to s.w.personless, "roadmap editor" to s.w.editor,
    )

    /** The seeded links: l1 violated across two projects, l2 kept inside one, l3 project to project (one empty), l4 to a project. */
    private class Seeded(
        val w: PlanWorld,
        val other: SecondProject,
        val empty: UInt,
        val a1: UInt,
        val a2: UInt,
        val b1: UInt,
        val l1: UInt,
        val l2: UInt,
        val l3: UInt,
        val l4: UInt,
    ) {
        val links get() = listOf(l1, l2, l3, l4)
    }

    private suspend fun ApplicationTestBuilder.world(prefix: String): PlanWorld {
        usePostgresTestcontainer()
        return planWorld(prefix, teams = true)
    }

    private suspend fun ApplicationTestBuilder.seeded(prefix: String, w: PlanWorld): Seeded {
        val t = w.requireTeams()
        val other = secondProject(w, prefix)
        val empty = TestPlan.project(w.programId, w.projectOwner.personId!!)
        TestPlan.milestone(empty, t.teamId, planName("$prefix-tray"))
        val a1 = TestPlan.milestone(w.projectId, t.teamId, planName("$prefix-a1"))
        val a2 = TestPlan.milestone(w.projectId, t.teamId, planName("$prefix-a2"))
        val b1 = TestPlan.milestone(other.projectId, t.otherTeamId, planName("$prefix-b1"))
        TestPlan.schedule(a1, "2027-02-08", "2027-02-12")
        TestPlan.schedule(a2, "2027-02-15", "2027-02-19")
        TestPlan.schedule(b1, "2027-01-25", "2027-01-29")
        return Seeded(
            w, other, empty, a1, a2, b1,
            l1 = TestPlan.dependency(milestoneRef(a1), milestoneRef(b1)),
            l2 = TestPlan.dependency(milestoneRef(a1), milestoneRef(a2)),
            l3 = TestPlan.dependency(projectRef(w.projectId), projectRef(empty)),
            l4 = TestPlan.dependency(milestoneRef(a2), projectRef(other.projectId)),
        )
    }

    @Test
    fun `an anonymous request is a 401, an unknown parameter is ignored and the JSON holds exactly the documented members`() =
        testApplication {
            val s = seeded("dl1", world("dl1"))
            assertEquals(HttpStatusCode.Unauthorized, jsonClient().get(path).status)
            val response = s.w.stranger.client.get("$path?projectId=${s.w.projectId}&foo=bar")
            assertEquals(HttpStatusCode.OK, response.status)
            val root = Json.parseToJsonElement(response.bodyAsText()).jsonObject
            assertEquals(
                setOf("revision", "totals", "projects", "teams", "milestones", "dependencies", "truncated"),
                root.keys,
                "the three name lists, no document-level can",
            )
            assertEquals(setOf("links", "violated", "unscheduled"), root.getValue("totals").jsonObject.keys)
            val row = root.getValue("dependencies").jsonArray.first().jsonObject
            assertEquals(setOf("id", "predecessor", "successor", "type", "lagDays", "check", "can"), row.keys, "no critical")
            assertEquals(setOf("edit", "delete"), row.getValue("can").jsonObject.keys)
            val end = setOf("kind", "id")
            assertEquals(end, row.getValue("predecessor").jsonObject.keys, "an end is a kind and an id, no name, no date")
            assertEquals(end, row.getValue("successor").jsonObject.keys)
            assertEquals(setOf("id", "name", "projectId", "teamId"), root.getValue("milestones").jsonArray.first().jsonObject.keys)
            assertEquals(setOf("id", "name"), root.getValue("projects").jsonArray.first().jsonObject.keys)
            assertEquals(setOf("id", "name"), root.getValue("teams").jsonArray.first().jsonObject.keys)
            assertEquals(
                setOf("status", "shortfallDays", "slackDays", "requiredDate", "actualDate"),
                row.getValue("check").jsonObject.keys,
            )
            assertEquals(TestPlan.revision(), s.w.stranger.client.load().revision)
        }

    @Test
    fun `each row equals the project and team pages' item for its link, and the totals move by exactly what is seeded`() = testApplication {
        val w = world("dl2")
        val base = uncapped()
        val s = seeded("dl2", w)
        val client = s.w.stranger.client
        val list = uncapped(w.actorOf(w.stranger))
        assertFalse(list.truncated)
        list.assertListsHoldExactlyWhatTheRowsName()
        assertEquals(listOf(4, 2, 1), list.figuresSince(base), "four links: l1 and l4 do not hold, l3 has an end with nothing scheduled")
        assertEquals(list.totals.links, list.dependencies.size)

        // An end is compared RESOLVED through the lists, without the dates the list's ends do not carry.
        fun assertEqualItem(row: DependencyListRow, item: ProjectDependency, where: String) {
            assertEquals(list.endOf(row.predecessor), item.predecessor.withoutDates(), "$where predecessor of ${row.id}")
            assertEquals(list.endOf(row.successor), item.successor.withoutDates(), "$where successor of ${row.id}")
            assertEquals(row.type, item.type, "$where type of ${row.id}")
            assertEquals(row.lagDays, item.lagDays, "$where lag of ${row.id}")
            assertEquals(row.check, item.check, "$where check of ${row.id}")
            assertEquals(row.can, item.can, "$where can of ${row.id}")
        }
        fun ProjectView.item(id: UInt) = dependencies.single { it.id == id }
        fun TeamView.item(id: UInt) = dependencies.single { it.id == id }

        val mine = client.project(s.w.projectId)
        val theirs = client.project(s.other.projectId)
        val emptyPage = client.project(s.empty)
        for (id in listOf(s.l1, s.l2, s.l3, s.l4)) assertEqualItem(list.row(id), mine.item(id), "project page")
        for (id in listOf(s.l1, s.l4)) assertEqualItem(list.row(id), theirs.item(id), "other project page")
        assertEqualItem(list.row(s.l3), emptyPage.item(s.l3), "empty project page")
        val t = s.w.requireTeams()
        val team = client.team(t.teamId)
        for (id in listOf(s.l1, s.l2, s.l4)) assertEqualItem(list.row(id), team.item(id), "team page")
        assertEqualItem(list.row(s.l1), client.team(t.otherTeamId).item(s.l1), "other team page")
        assertTrue(team.dependencies.none { it.id == s.l3 }, "a project-to-project link has no milestone in the team")

        assertEquals(DependencyStatus.VIOLATED, list.row(s.l1).check.status)
        assertEquals(DependencyStatus.OK, list.row(s.l2).check.status)
        assertEquals(DependencyStatus.UNSCHEDULED, list.row(s.l3).check.status)
        assertEquals(DependencyStatus.VIOLATED, list.row(s.l4).check.status)
        assertEquals(DependencyType.FS, list.row(s.l2).type)
        // Violated first, the largest shortfall first (l4: 20 working days short, l1: 15), then the kept link, then the unscheduled one.
        assertEquals(listOf(s.l4, s.l1, s.l2, s.l3), list.dependencies.map { it.id }.filter { it in s.links }, "the documented order")
        val ids = list.dependencies.map { it.id }
        assertEquals(ids.toSet().size, ids.size, "every link once")
        val order = mapOf(DependencyStatus.VIOLATED to 0, DependencyStatus.OK to 1, DependencyStatus.UNSCHEDULED to 2)
        val rank = list.dependencies.map { order.getValue(it.check.status) }
        assertEquals(rank.sorted(), rank, "VIOLATED, then OK, then UNSCHEDULED over the whole list")
    }

    @Test
    fun `totals violated moves with Home's conflicts figure across the seeding`() = testApplication {
        // Deltas, not absolutes: a raw-SQL orphan another class left in the shared database (an active project under a
        // deleted program) is in the list's project set but not Home's, which no API write can produce.
        val w = world("dl3")
        val homeBefore = w.stranger.client.home().plan.conflicts
        val listBefore = uncapped().totals.violated
        seeded("dl3", w)
        val homeDelta = w.stranger.client.home().plan.conflicts - homeBefore
        assertEquals(2, uncapped().totals.violated - listBefore, "the two violated links seeded")
        assertEquals(2, homeDelta, "and Home counts the same two")
    }

    @Test
    fun `a deleted link, a deleted milestone's links and a deleted project's links are in no row and no total`() = testApplication {
        val w = world("dl4")
        val base = uncapped()
        val homeBase = w.stranger.client.home().plan.conflicts
        val s = seeded("dl4", w)
        val admin = s.w.admin.client
        val home = s.w.stranger.client

        fun DependencyListView.figures() = figuresSince(base)

        val full = uncapped()
        assertEquals(listOf(4, 2, 1), full.figures())
        assertTrue(s.links.all { id -> full.dependencies.any { it.id == id } }, "non-vacuous: all four are listed")

        assertEquals(HttpStatusCode.NoContent, admin.delete("/api/v1/dependencies/${s.l1}").status)
        val afterLink = uncapped()
        assertTrue(afterLink.dependencies.none { it.id == s.l1 })
        assertEquals(listOf(3, 1, 1), afterLink.figures())

        // The milestone's links go with it: l2 (kept) and l4 (violated).
        assertEquals(HttpStatusCode.NoContent, admin.delete("/api/v1/milestones/${s.a2}").status)
        val afterMilestone = uncapped()
        assertTrue(afterMilestone.dependencies.none { it.id == s.l2 || it.id == s.l4 })
        assertEquals(listOf(1, 0, 1), afterMilestone.figures())
        assertEquals(0, home.home().plan.conflicts - homeBase, "Home agrees after a milestone left")

        // The project's links go with it: l3 (its end is the deleted project).
        assertEquals(HttpStatusCode.NoContent, admin.delete("/api/v1/projects/${s.empty}").status)
        val afterProject = uncapped()
        assertTrue(afterProject.dependencies.none { it.id in s.links })
        assertEquals(listOf(0, 0, 0), afterProject.figures())
        assertEquals(0, home.home().plan.conflicts - homeBase, "Home agrees after a project left")
    }

    @Test
    fun `each row's can equals the project and team pages' item for the same link, for every kind of caller`() = testApplication {
        val s = seeded("dl5", world("dl5"))
        val t = s.w.requireTeams()
        for ((label, caller) in callers(s, t)) {
            val list = uncapped(s.w.actorOf(caller))
            val mine = caller.client.project(s.w.projectId)
            val theirs = caller.client.project(s.other.projectId)
            val team = caller.client.team(t.teamId)
            for (id in listOf(s.l1, s.l2, s.l4)) {
                assertEquals(list.row(id).can, mine.dependencies.single { it.id == id }.can, "$label: project page of link $id")
            }
            for (id in listOf(s.l1, s.l4)) {
                assertEquals(list.row(id).can, theirs.dependencies.single { it.id == id }.can, "$label: other project page of link $id")
            }
            for (id in listOf(s.l1, s.l2, s.l4)) {
                assertEquals(list.row(id).can, team.dependencies.single { it.id == id }.can, "$label: team page of link $id")
            }
            // The route resolves the same actor: EVERY row the endpoint's own (cut) document lists carries the flags the service computes
            // for that actor (rows another class deleted between the two reads are skipped; the document is never empty).
            val http = caller.client.load()
            val byId = uncapped(s.w.actorOf(caller)).dependencies.associateBy { it.id }
            var compared = 0
            for (row in http.dependencies) {
                val expected = byId[row.id] ?: continue
                assertEquals(expected.can, row.can, "$label: the endpoint, link ${row.id}")
                compared++
            }
            assertTrue(compared > 0, "$label: at least one row of the endpoint's document was compared")
        }
    }

    @Test
    fun `can edit is true exactly when PUT answers 204 and can delete exactly when DELETE does, for every caller`() = testApplication {
        val s = seeded("dl8", world("dl8"))
        val t = s.w.requireTeams()
        val expectedAllowed = setOf("admin", "stream owner", "program owner", "the second project's owner")
        val from = TestPlan.milestone(s.w.projectId, t.teamId, planName("dl8-from"))
        val to = TestPlan.milestone(s.other.projectId, t.teamId, planName("dl8-to"))
        for ((label, caller) in callers(s, t)) {
            // A fresh link into the SECOND project, whose chain is the world's stream owner, program owner and the second project's
            // owner; the first project's owner is the PREDECESSOR's owner alone.
            val id = TestPlan.dependency(milestoneRef(from), milestoneRef(to))
            val can = uncapped(s.w.actorOf(caller)).row(id).can
            assertEquals(label in expectedAllowed, can.edit, "$label: the document's edit flag")
            assertEquals(label in expectedAllowed, can.delete, "$label: the document's delete flag")
            val put = caller.client.putDependency(id, DependencyType.SS, 1)
            assertEquals(if (can.edit) HttpStatusCode.NoContent else HttpStatusCode.Forbidden, put.status, "$label: PUT")
            val deleted = caller.client.delete("/api/v1/dependencies/$id")
            assertEquals(if (can.delete) HttpStatusCode.NoContent else HttpStatusCode.Forbidden, deleted.status, "$label: DELETE")
            if (!can.delete) assertEquals(HttpStatusCode.NoContent, s.w.admin.client.delete("/api/v1/dependencies/$id").status)
        }
    }

    @Test
    fun `a link whose successor project hangs under a deleted program offers nothing, even to an administrator`() = testApplication {
        val s = seeded("dl9", world("dl9"))
        val orphan = TestPlan.project(s.w.programId, s.other.owner.personId!!)
        val id = TestPlan.dependency(projectRef(s.w.projectId), projectRef(orphan))
        assertEquals(ProjectDependencyCan(true, true), uncapped(s.w.actorOf(s.w.admin)).row(id).can, "non-vacuous: an active chain")
        // Raw SQL, like a stray row another class could leave: the program is deleted under its active project (no API write does this).
        jbSql("UPDATE programs SET marked_as_deleted = TRUE WHERE id = ?", s.w.programId.toInt())
        try {
            val row = uncapped(s.w.actorOf(s.w.admin)).row(id)
            assertEquals(ProjectDependencyCan(false, false), row.can, "no write could succeed: the route answers 404")
            assertEquals(HttpStatusCode.NotFound, s.w.admin.client.putDependency(id, DependencyType.SS, 1).status)
        } finally {
            jbSql("UPDATE programs SET marked_as_deleted = FALSE WHERE id = ?", s.w.programId.toInt())
        }
    }

    @Test
    fun `the document is identical for every caller but for each row's can`() = testApplication {
        val s = seeded("dl5b", world("dl5b"))
        val w = s.w
        val bodies = listOf(w.admin, w.streamOwner, w.programOwner, w.projectOwner, w.stranger, w.personless, w.editor, s.other.owner)
            .map { Json.parseToJsonElement(it.client.get(path).bodyAsText()).jsonObject.withoutCan() }
        assertEquals(1, bodies.toSet().size, "no role, person or grant reaches anything but a row's can")
        val raw = Json.parseToJsonElement(w.admin.client.get(path).bodyAsText()).jsonObject
        assertFalse(raw.toString().contains("ownerPersonId") || raw.toString().contains("owners"), "no owner chain on the wire")
    }

    private fun JsonObject.withoutCan(): JsonObject = JsonObject(
        mapValues { (key, value) ->
            if (key == "dependencies") {
                JsonArray(value.jsonArray.map { JsonObject(it.jsonObject.filterKeys { member -> member != "can" }) })
            } else {
                value
            }
        },
    )

    @Test
    fun `a list is cut at the service's cap and says so, while the totals count every link`() = testApplication {
        val s = seeded("dl6", world("dl6"))
        val whole = uncapped()
        val cut = DependencyListViewService(sharedDatabaseForTests(), maxRows = 1).view(NOBODY)
        assertTrue(cut.truncated)
        assertEquals(1, cut.dependencies.size)
        cut.assertListsHoldExactlyWhatTheRowsName()
        assertTrue(cut.milestones.size <= 2 && cut.projects.size <= 2 && cut.teams.size <= 2, "a cut row's names only, not the plan's")
        assertEquals(whole.dependencies.first(), cut.dependencies.single(), "the first of the order")
        assertEquals(whole.totals, cut.totals, "the totals count every link")
        assertFalse(whole.truncated)
        assertTrue(whole.totals.links >= s.links.size)
    }

    @Test
    fun `the endpoint answers the first 1000 rows of the uncapped document and says it cut, with more than 1000 links`() = testApplication {
        val w = world("dl7")
        val project = TestPlan.project(w.programId, w.projectOwner.personId!!)
        val team = w.requireTeams().teamId
        // 46 unscheduled milestones of one throwaway project: 46 * 45 / 2 = 1,035 pairs, always from the lower id to the higher (acyclic).
        val ids = List(46) { TestPlan.milestone(project, team, planName("dl7-m")) }.sorted()
        val pairs = ids.flatMapIndexed { i, from -> ids.drop(i + 1).map { from to it } }
        assertTrue(pairs.size > MAX_DEPENDENCY_ROWS)
        try {
            val now = System.currentTimeMillis()
            val values = pairs.joinToString(",") { (from, to) -> "(${from.toInt()}, ${to.toInt()}, 'FS', 0, $now, $now)" }
            jbSql("INSERT INTO dependencies (pred_milestone_id, succ_milestone_id, type, lag_days, created_at, updated_at) VALUES $values")
            val whole = uncapped()
            val http = w.stranger.client.load()
            assertTrue(whole.totals.links >= pairs.size)
            assertTrue(http.truncated)
            assertEquals(MAX_DEPENDENCY_ROWS, http.dependencies.size)
            assertEquals(whole.dependencies.take(MAX_DEPENDENCY_ROWS), http.dependencies, "the first 1,000 rows of the one order")
            http.assertListsHoldExactlyWhatTheRowsName()
            assertEquals(whole.totals, http.totals, "the totals count every link")
            assertEquals(whole.revision, http.revision)
            assertFalse(whole.truncated)
            assertEquals(whole.totals.links, whole.dependencies.size)
        } finally {
            // NonCancellable: a test cancelled by the 60 s limit must still take its 1,035 links out of the shared plan.
            withContext(NonCancellable) {
                jbSql("DELETE FROM dependencies WHERE pred_milestone_id IN (${ids.joinToString(",") { it.toString() }})")
            }
        }
        // And the other way round: without them the flag is the rule it is: truncated == (totals.links > 1000).
        val now = w.stranger.client.load()
        assertEquals(now.totals.links > MAX_DEPENDENCY_ROWS, now.truncated)
        assertEquals(minOf(now.totals.links, MAX_DEPENDENCY_ROWS), now.dependencies.size)
    }
}
