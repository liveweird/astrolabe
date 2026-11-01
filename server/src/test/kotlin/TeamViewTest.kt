package ch.nokillswit

import ch.nokillswit.planning.MilestoneScheduleRequest
import ch.nokillswit.planning.RankingUpdateRequest
import ch.nokillswit.planning.TeamView
import ch.nokillswit.planning.DependencyStatus
import ch.nokillswit.teams.CapacityPeriodRequest
import io.ktor.client.call.body
import io.ktor.client.request.delete
import io.ktor.client.request.get
import io.ktor.http.HttpStatusCode
import io.ktor.server.testing.testApplication
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * `GET /views/team/{id}` (v0.5.0): one team for any authenticated caller - the team block and its `can` flags, the capacity periods, the
 * weekly load against the prorated capacity and the per-day WIP, the milestones in the team's effective order (the global project rank
 * by default, the manager's override first once set) and the links touching them. The arithmetic itself is `LoadKernelsTest`'s; here it
 * is checked through the wire. 2027-02-01 is a Monday.
 */
class TeamViewTest {
    private fun path(teamId: UInt) = "/api/v1/views/team/$teamId"

    private suspend fun PlanCaller.view(teamId: UInt): TeamView = client.get(path(teamId)).body()

    private suspend fun PlanWorld.view(teamId: UInt): TeamView = admin.view(teamId)

    private fun ranking(first: UInt, second: UInt) = RankingUpdateRequest(TestPlan.revision(), listOf(first, second))

    /** A manager-less team and a milestone of it per (start, end, estimate); null dates = unscheduled. */
    private suspend fun PlanWorld.milestone(
        teamId: UInt,
        start: String?,
        end: String?,
        estimate: Double = 5.0,
        name: String = planName("m"),
    ): UInt =
        TestPlan.milestone(projectId, teamId, name, estimate).also { if (start != null) TestPlan.schedule(it, start, end) }

    @Test
    fun `unauthenticated requests are 401`() = testApplication {
        usePostgresTestcontainer()
        assertEquals(HttpStatusCode.Unauthorized, jsonClient().get(path(1u)).status)
    }

    @Test
    fun `an unknown or deleted team is 404 for every caller and a malformed id is 400`() = testApplication {
        usePostgresTestcontainer()
        val w = planWorld("tvn", teams = true)
        val gone = TestTeams.seed(planName("tvn-gone"), null)
        assertEquals(HttpStatusCode.OK, w.stranger.client.get(path(gone)).status)
        assertEquals(HttpStatusCode.NoContent, w.admin.client.delete("/api/v1/teams/$gone").status)
        for ((label, caller) in w.outsiders + ("admin" to w.admin) + ("manager" to w.requireTeams().manager)) {
            assertEquals(HttpStatusCode.NotFound, caller.client.get(path(999_999u)).status, "unknown: $label")
            assertEquals(HttpStatusCode.NotFound, caller.client.get(path(gone)).status, "deleted: $label")
        }
        assertEquals(HttpStatusCode.BadRequest, w.stranger.client.get("/api/v1/views/team/not-a-number").status)
    }

    @Test
    fun `the document carries the team, its periods, both lists and the revision - and nothing of another team or a deleted milestone`() =
        testApplication {
            usePostgresTestcontainer()
            val w = planWorld("tvs", teams = true)
            val t = w.requireTeams()
            val scheduled = w.milestone(t.teamId, "2027-02-01", "2027-02-05", 4.0, "Build")
            val tray = TestPlan.milestone(w.projectId, t.teamId, "Idea", 1.5)
            val gone = w.milestone(t.teamId, "2027-02-01", "2027-02-05")
            val elsewhere = w.milestone(t.otherTeamId, "2027-02-01", "2027-02-05")
            assertEquals(HttpStatusCode.NoContent, w.admin.client.delete("/api/v1/milestones/$gone").status)
            val first = TestPlan.capacityPeriod(t.teamId, "2027-02-01", 10.0, wipLimit = 3)
            val second = TestPlan.capacityPeriod(t.teamId, "2027-03-01", 12.5)
            TestPlan.capacityPeriod(t.otherTeamId, "2027-01-01", 99.0)

            withAuditCapture { capture ->
                val view = w.stranger.view(t.teamId)
                assertTrue(capture.events.none { it.message.startsWith("team.") }, "a read audits nothing")
                assertEquals(TestPlan.revision(), view.revision)
                assertEquals(t.teamId, view.team.id)
                assertTrue(view.team.name.isNotBlank())
                assertEquals(t.manager.personId, view.team.managerPersonId)
                assertTrue(!view.team.managerName.isNullOrBlank())
                assertFalse(view.order.custom)
                assertEquals(0L, view.order.revision)
                assertEquals(listOf(first, second), view.capacity.periods.map { it.id }, "by effective date")
                assertEquals(listOf(3, null), view.capacity.periods.map { it.wipLimit })
                assertEquals(listOf(10.0, 12.5), view.capacity.periods.map { it.mdPerWeek })
                assertEquals(listOf(scheduled), view.scheduled.map { it.id })
                assertEquals(listOf(tray), view.unscheduled.map { it.id })
                val row = view.scheduled.single()
                assertEquals("Build", row.name)
                assertEquals(t.teamId, row.teamId)
                assertEquals(w.projectId, row.projectId)
                assertTrue(row.projectName.isNotBlank() && row.programName.isNotBlank() && row.workStreamName.isNotBlank())
                assertEquals(4.0, row.estimateMd)
                assertEquals("2027-02-01", row.startDate)
                assertNull(view.unscheduled.single().startDate)
                assertTrue(elsewhere !in (view.scheduled + view.unscheduled).map { it.id })
                assertEquals(emptyList(), view.dependencies)
            }
            val empty = w.stranger.view(t.otherTeamId)
            assertEquals(listOf(elsewhere), empty.scheduled.map { it.id })
            assertEquals(listOf(99.0), empty.capacity.periods.map { it.mdPerWeek })
        }

    /** The three real writes of the manager's `can` flags, each answering the same status for the one caller. */
    private suspend fun PlanCaller.writeStatuses(teamId: UInt, milestone: UInt): List<HttpStatusCode> {
        val view = view(teamId)
        val row = view.scheduled.single()
        return listOf(
            client.putJson("/api/v1/milestones/$milestone/schedule", MilestoneScheduleRequest(view.revision, row.startDate, row.endDate)),
            client.postJson("/api/v1/teams/$teamId/capacity", CapacityPeriodRequest("2026-01-01", 5.0, null)),
            client.putTeamOrder(teamId, view.revision, emptyList()),
        ).map { it.status }
    }

    @Test
    fun `a manager whose person was deleted or unlinked shows as no manager - the flags go false and the real writes are refused`() =
        testApplication {
            usePostgresTestcontainer()
            val allowed = listOf(HttpStatusCode.OK, HttpStatusCode.Created, HttpStatusCode.OK)
            val refused = List(3) { HttpStatusCode.Forbidden }
            for (case in listOf("deleted", "unlinked")) {
                val w = planWorld("tvg-$case", teams = true)
                val t = w.requireTeams()
                val milestone = w.milestone(t.teamId, "2027-02-01", "2027-02-05")
                assertEquals(t.manager.personId, w.stranger.view(t.teamId).team.managerPersonId, case)
                assertTrue(t.manager.view(t.teamId).team.can.editOrder, case)
                val person = t.manager.personId!!.toInt()
                val change = if (case == "deleted") "marked_as_deleted = TRUE" else "user_id = NULL"
                PostgresTestSupport.connect().use { it.exec("UPDATE people SET $change WHERE id = ?", person) }

                val team = w.stranger.view(t.teamId).team
                if (case == "deleted") {
                    assertNull(team.managerPersonId)
                    assertNull(team.managerName)
                } else {
                    assertEquals(t.manager.personId, team.managerPersonId, "an unlinked person is still the manager of record")
                }
                val can = t.manager.view(t.teamId).team.can
                assertEquals(listOf(false, false, false), listOf(can.schedule, can.editCapacity, can.editOrder), case)
                assertEquals(refused, t.manager.writeStatuses(t.teamId, milestone), "$case: the real writes agree with the flags")
                assertEquals(allowed, w.admin.writeStatuses(t.teamId, milestone), "$case: ADMIN is unaffected")
            }
        }

    // --- the order ----------------------------------------------------------------------------------------------------------

    @Test
    fun `the order is the global project rank by default, the manager's list first once set, and a rank change reorders only the tail`() =
        testApplication {
            usePostgresTestcontainer()
            val w = planWorld("tvo", teams = true)
            val t = w.requireTeams()
            val second = secondProject(w)
            val third = secondProject(w, "sp3")
            val p1a = w.milestone(t.teamId, "2027-02-08", "2027-02-12", name = "p1a")
            val p1b = w.milestone(t.teamId, "2027-02-01", "2027-02-05", name = "p1b")
            val p2a = TestPlan.milestone(second.projectId, t.teamId, "p2a").also { TestPlan.schedule(it, "2027-03-01", "2027-03-05") }
            val p3a = TestPlan.milestone(third.projectId, t.teamId, "p3a").also { TestPlan.schedule(it, "2027-01-04", "2027-01-08") }
            val p1u = TestPlan.milestone(w.projectId, t.teamId, "p1u")
            val p2u = TestPlan.milestone(second.projectId, t.teamId, "p2u")
            val head = ranking(second.projectId, w.projectId)
            assertEquals(HttpStatusCode.OK, w.admin.client.putJson("/api/v1/roadmap/ranking", head).status)

            val byRank = w.view(t.teamId)
            assertEquals(listOf(p2a, p1b, p1a, p3a), byRank.scheduled.map { it.id }, "ranked projects first in rank order, unranked last")
            assertEquals(listOf(p2u, p1u), byRank.unscheduled.map { it.id })
            assertEquals(listOf(1, 2, 2, null), byRank.scheduled.map { it.rankPosition })

            // A partial list: the listed first, exactly as listed - the lower-ranked project's milestone before a higher-ranked one's.
            assertEquals(HttpStatusCode.OK, t.manager.client.putTeamOrder(t.teamId, byRank.order.revision, listOf(p1a, p3a)).status)
            val custom = w.view(t.teamId)
            assertTrue(custom.order.custom)
            assertEquals(TestPlan.revision(), custom.order.revision)
            assertEquals(listOf(p1a, p3a, p2a, p1b), custom.scheduled.map { it.id }, "the listed, then the rest in rank order")
            assertEquals(listOf(p2u, p1u), custom.unscheduled.map { it.id })

            // A rank change reorders only the unlisted tail: the manager's head is untouched.
            val swapped = ranking(w.projectId, second.projectId)
            assertEquals(HttpStatusCode.OK, w.admin.client.putJson("/api/v1/roadmap/ranking", swapped).status)
            val afterSwap = w.view(t.teamId)
            assertEquals(listOf(p1a, p3a, p1b, p2a), afterSwap.scheduled.map { it.id })
            assertEquals(listOf(p1u, p2u), afterSwap.unscheduled.map { it.id })
            assertEquals(custom.order.revision, afterSwap.order.revision, "the rank change did not touch the team's order")

            // An empty list resets the team to the project rank.
            assertEquals(HttpStatusCode.OK, t.manager.client.putTeamOrder(t.teamId, afterSwap.order.revision, emptyList()).status)
            val reset = w.view(t.teamId)
            assertFalse(reset.order.custom)
            assertEquals(listOf(p1b, p1a, p2a, p3a), reset.scheduled.map { it.id })
        }

    // --- the weeks ----------------------------------------------------------------------------------------------------------

    private suspend fun PlanWorld.team(): UInt = TestTeams.seed(planName("tvw"), null)

    @Test
    fun `a capacity change mid-week is prorated and a weekend period applies from the Monday after`() = testApplication {
        usePostgresTestcontainer()
        val w = planWorld("tvp")
        val midWeek = w.team()
        TestPlan.capacityPeriod(midWeek, "2027-02-01", 10.0)
        TestPlan.capacityPeriod(midWeek, "2027-02-04", 20.0)
        w.milestone(midWeek, "2027-02-03", "2027-02-09", 10.0)
        val view = w.view(midWeek)
        assertEquals(listOf("2027-02-01", "2027-02-08"), view.weeks.map { it.weekStart })
        assertEquals(listOf(6.0, 4.0), view.weeks.map { it.load })
        assertEquals(listOf(14.0, 20.0), view.weeks.map { it.capacity }, "3 x 10/5 + 2 x 20/5, then 20")
        assertEquals(listOf(false, false), view.weeks.map { it.overloaded })
        assertFalse(view.weeksTruncated)

        val weekend = w.team()
        TestPlan.capacityPeriod(weekend, "2027-02-01", 10.0)
        TestPlan.capacityPeriod(weekend, "2027-02-06", 20.0)
        w.milestone(weekend, "2027-02-01", "2027-02-08", 6.0)
        assertEquals(listOf(10.0, 20.0), w.view(weekend).weeks.map { it.capacity }, "Saturday's 20 first counts on Monday")
    }

    @Test
    fun `a week is overloaded when its rounded load exceeds its rounded capacity, and no capacity is never flagged`() = testApplication {
        usePostgresTestcontainer()
        val w = planWorld("tvl")
        val loaded = w.team()
        TestPlan.capacityPeriod(loaded, "2027-02-01", 5.0)
        w.milestone(loaded, "2027-02-01", "2027-02-05", 7.5)
        val over = w.view(loaded).weeks.single()
        assertTrue(over.overloaded)
        assertEquals(2.5, over.overloadMd)

        val uncovered = w.team()
        TestPlan.capacityPeriod(uncovered, "2027-02-10", 5.0) // the week of 01-25 lies before the team's first period
        w.milestone(uncovered, "2027-01-25", "2027-01-29", 7.5)
        val before = w.view(uncovered).weeks.single()
        assertNull(before.capacity, "the week before the first period has no capacity")
        assertFalse(before.overloaded)
        assertNull(before.overloadMd)
        assertEquals(7.5, before.load)
    }

    @Test
    fun `the WIP limit is judged per working day, so a limit changed mid-week keeps its own verdict`() = testApplication {
        usePostgresTestcontainer()
        val w = planWorld("tvi")
        // Daily WIP, week of 02-01: 1 1 2 3 2; week of 02-08: 1 1 1 0 0.
        suspend fun team(vararg limits: Pair<String, Int?>): TeamView {
            val team = w.team()
            for ((from, limit) in limits) TestPlan.capacityPeriod(team, from, 10.0, limit)
            w.milestone(team, "2027-02-01", "2027-02-05")
            w.milestone(team, "2027-02-03", "2027-02-10")
            w.milestone(team, "2027-02-04", "2027-02-04")
            return w.view(team)
        }
        val raised = team("2027-02-01" to 2, "2027-02-04" to 3)
        assertEquals(listOf(3, 1), raised.weeks.map { it.maxWip })
        assertEquals(listOf(false, false), raised.weeks.map { it.wipExceeded }, "Wednesday 2 <= 2, Thursday 3 <= 3")
        val lowered = team("2027-02-01" to 3, "2027-02-04" to 2)
        assertEquals(listOf(true, false), lowered.weeks.map { it.wipExceeded }, "Thursday 3 > 2")
        val flat = team("2027-02-01" to 2)
        assertEquals(listOf(true, false), flat.weeks.map { it.wipExceeded })
        val unlimited = team("2027-02-01" to null)
        assertEquals(listOf(3, 1), unlimited.weeks.map { it.maxWip })
        assertEquals(listOf(false, false), unlimited.weeks.map { it.wipExceeded }, "a period without a limit never warns")
    }

    @Test
    fun `the weeks run from the first start's Monday to the last end's Sunday, nothing scheduled has none, and 520 weeks is the cap`() =
        testApplication {
            usePostgresTestcontainer()
            val w = planWorld("tvc")
            val team = w.team()
            w.milestone(team, null, null)
            assertEquals(emptyList(), w.view(team).weeks)
            assertFalse(w.view(team).weeksTruncated)

            w.milestone(team, "2027-02-03", "2027-02-04")
            assertEquals(listOf("2027-02-01"), w.view(team).weeks.map { it.weekStart })

            w.milestone(team, "2037-06-01", "2037-06-04")
            val capped = w.view(team)
            assertTrue(capped.weeksTruncated)
            assertEquals(520, capped.weeks.size)
            assertEquals("2027-02-01", capped.weeks.first().weekStart)
            assertEquals("2037-01-12", capped.weeks.last().weekStart, "519 weeks after the first")
        }

    // --- the links ----------------------------------------------------------------------------------------------------------

    @Test
    fun `dependencies list the links touching the team's milestones, the far end resolved and the violation checked`() = testApplication {
        usePostgresTestcontainer()
        val w = planWorld("tvd", teams = true)
        val t = w.requireTeams()
        val second = secondProject(w)
        val mine = w.milestone(t.teamId, "2027-02-08", "2027-02-12", name = "mine")
        val sibling = w.milestone(t.teamId, "2027-02-15", "2027-02-19", name = "sibling")
        val theirs = TestPlan.milestone(second.projectId, t.otherTeamId, "theirs")
            .also { TestPlan.schedule(it, "2027-02-08", "2027-02-10") }
        val unrelated = TestPlan.milestone(second.projectId, t.otherTeamId, "unrelated")
        // theirs -> mine (FS): mine starts Monday 02-08 but theirs ends Wednesday 02-10, so mine is 3 working days short.
        val violated = TestPlan.dependency(milestoneRef(theirs), milestoneRef(mine))
        val fine = TestPlan.dependency(milestoneRef(mine), milestoneRef(sibling))
        TestPlan.dependency(milestoneRef(theirs), milestoneRef(unrelated))

        val view = w.stranger.view(t.teamId)
        assertEquals(listOf(violated, fine), view.dependencies.map { it.id }, "violated first; the unrelated link is absent")
        val link = view.dependencies.first()
        assertEquals(DependencyStatus.VIOLATED, link.check.status)
        assertEquals(3, link.check.shortfallDays)
        assertEquals(theirs, link.predecessor.id)
        assertEquals(t.otherTeamId, link.predecessor.teamId, "the far end carries its own team")
        assertEquals(second.projectId, link.predecessor.projectId)
        assertTrue(link.predecessor.projectName.isNotBlank())
        assertEquals(DependencyStatus.OK, view.dependencies.last().check.status)
        // can.delete follows the SUCCESSOR's project chain: the world's project owner owns both successors' project.
        assertTrue(w.projectOwner.view(t.teamId).dependencies.all { it.can.delete })
        assertFalse(w.stranger.view(t.teamId).dependencies.any { it.can.delete })
        assertTrue(w.view(t.teamId).dependencies.all { it.can.delete })
    }

    // --- the flags ----------------------------------------------------------------------------------------------------------

    @Test
    fun `the three flags are set exactly where the server lets the real write through - the manager of this team and ADMIN only`() =
        testApplication {
            usePostgresTestcontainer()
            val w = planWorld("tvf", teams = true)
            val t = w.requireTeams()
            val milestone = w.milestone(t.teamId, "2027-02-01", "2027-02-05")
            val everyone = listOf(
                "admin" to w.admin, "stream owner" to w.streamOwner, "program owner" to w.programOwner, "project owner" to w.projectOwner,
                "team manager" to t.manager, "other team's manager" to t.otherManager, "stranger" to w.stranger,
                "personless" to w.personless, "editor" to w.editor,
            )
            fun status(allowed: Boolean, ok: HttpStatusCode) = if (allowed) ok else HttpStatusCode.Forbidden
            for ((index, entry) in everyone.withIndex()) {
                val (label, caller) = entry
                val view = caller.view(t.teamId)
                val expected = label == "admin" || label == "team manager"
                val can = view.team.can
                assertEquals(listOf(expected, expected, expected), listOf(can.schedule, can.editCapacity, can.editOrder), label)

                val row = view.scheduled.single()
                assertEquals(
                    status(can.schedule, HttpStatusCode.OK),
                    caller.client.putJson(
                        "/api/v1/milestones/$milestone/schedule",
                        MilestoneScheduleRequest(view.revision, row.startDate, row.endDate),
                    ).status,
                    "$label: schedule",
                )
                assertEquals(
                    status(can.editCapacity, HttpStatusCode.Created),
                    caller.client.postJson(
                        "/api/v1/teams/${t.teamId}/capacity",
                        CapacityPeriodRequest("2026-01-${(index + 1).toString().padStart(2, '0')}", 5.0, null),
                    ).status,
                    "$label: capacity",
                )
                assertEquals(
                    status(can.editOrder, HttpStatusCode.OK),
                    caller.client.putTeamOrder(t.teamId, caller.view(t.teamId).revision, emptyList()).status,
                    "$label: order",
                )
            }
        }
}
