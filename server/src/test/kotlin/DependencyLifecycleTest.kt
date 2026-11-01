package ch.nokillswit

import ch.nokillswit.planning.DependencyResponse
import ch.nokillswit.planning.DependencyType
import ch.nokillswit.planning.MilestoneResponse
import ch.nokillswit.planning.MilestoneScheduleRequest
import ch.nokillswit.planning.MilestoneUpdateRequest
import ch.nokillswit.planning.ProjectMoveRequest
import io.ktor.client.call.body
import io.ktor.client.request.delete
import io.ktor.client.request.get
import io.ktor.http.HttpStatusCode
import io.ktor.server.testing.testApplication
import java.sql.SQLException
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * What happens to a dependency around it (V15): the cascades of a milestone and a project delete (both ends, counted in the audit), the
 * links surviving a project move, a team change and an unschedule, the guard re-run under the plan lock against re-read chains (a
 * request held open while the world changes), the audit trail, and the V15 constraints that back the service rules. The create / read /
 * delete matrix, the 400s and the 409s are in [DependencyTest].
 */
class DependencyLifecycleTest {
    private fun linkState(id: UInt): Boolean =
        TestPlan.scalar("SELECT marked_as_deleted FROM dependencies WHERE id = $id") { it.getBoolean(1) }

    private fun joined(ids: Collection<UInt>) = ids.sorted().joinToString(",")

    private fun links(where: String): Int =
        TestPlan.scalar("SELECT count(*) FROM dependencies WHERE NOT marked_as_deleted AND ($where)") { it.getInt(1) }

    @Test
    fun `deleting a milestone soft-deletes its links on both ends and counts them in the audit`() = testApplication {
        usePostgresTestcontainer()
        val w = planWorld("dcm", teams = true)
        val t = w.requireTeams()
        val b = secondProject(w, "dcm")
        val a1 = milestoneRef(TestPlan.milestone(w.projectId, t.teamId))
        val b1 = milestoneRef(TestPlan.milestone(b.projectId, t.teamId))
        val b2 = milestoneRef(TestPlan.milestone(b.projectId, t.teamId))
        val b3 = milestoneRef(TestPlan.milestone(b.projectId, t.teamId))
        val asPredecessor = TestPlan.dependency(a1, b1)
        val asSuccessor = TestPlan.dependency(b2, a1)
        val unrelated = TestPlan.dependency(b2, b3)
        withAuditCapture { capture ->
            assertEquals(HttpStatusCode.NoContent, w.projectOwner.client.delete("/api/v1/milestones/${a1.id}").status)
            val event = capture.awaitEvent { it.message == "milestone.deleted" && it.hasKeyValue("milestoneId", a1.id.toLong()) }
            assertNotNull(event)
            assertTrue(event.hasKeyValue("dependencyCount", 2), "both the link it led and the link it waited on")
            assertTrue(event.hasKeyValue("dependencyIds", joined(listOf(asPredecessor, asSuccessor))), "the cascaded link ids")
            assertTrue(
                event.hasKeyValue("successorProjectIds", joined(listOf(w.projectId, b.projectId))),
                "the projects of both successors: b1 in b, a1 in its own",
            )
        }
        assertEquals(HttpStatusCode.NotFound, w.admin.client.get("/api/v1/dependencies/$asPredecessor").status)
        assertEquals(HttpStatusCode.NotFound, w.admin.client.get("/api/v1/dependencies/$asSuccessor").status)
        assertEquals(HttpStatusCode.OK, w.admin.client.get("/api/v1/dependencies/$unrelated").status, "other links stay")
        assertTrue(linkState(asPredecessor) && linkState(asSuccessor) && !linkState(unrelated))
        // The count is per delete: b3 carried the unrelated link as its successor, b1 had only the link that already went with a1.
        withAuditCapture { capture ->
            assertEquals(HttpStatusCode.NoContent, w.admin.client.delete("/api/v1/milestones/${b3.id}").status)
            val event = capture.awaitEvent { it.message == "milestone.deleted" && it.hasKeyValue("milestoneId", b3.id.toLong()) }
            assertNotNull(event)
            assertTrue(event.hasKeyValue("dependencyCount", 1), "b3 was the unrelated link's successor")
            assertTrue(event.hasKeyValue("dependencyIds", joined(listOf(unrelated))))
            assertTrue(event.hasKeyValue("successorProjectIds", joined(listOf(b.projectId))))
            assertEquals(HttpStatusCode.NoContent, w.admin.client.delete("/api/v1/milestones/${b1.id}").status)
            val none = capture.awaitEvent { it.message == "milestone.deleted" && it.hasKeyValue("milestoneId", b1.id.toLong()) }
            assertNotNull(none)
            assertTrue(none.hasKeyValue("dependencyCount", 0), "b1's only link went with a1")
            assertTrue(none.hasKeyValue("dependencyIds", ""), "nothing cascaded: empty id list")
            assertTrue(none.hasKeyValue("successorProjectIds", ""), "nothing cascaded: empty project list")
        }
    }

    @Test
    fun `deleting a project soft-deletes its own links and its milestones' links, both ends, and counts them`() = testApplication {
        usePostgresTestcontainer()
        val w = planWorld("dcp", teams = true)
        val t = w.requireTeams()
        val b = secondProject(w, "dcp")
        val a1 = milestoneRef(TestPlan.milestone(w.projectId, t.teamId))
        val a2 = milestoneRef(TestPlan.milestone(w.projectId, t.teamId))
        val others = List(6) { milestoneRef(TestPlan.milestone(b.projectId, t.teamId)) }
        val milestoneAsPredecessor = TestPlan.dependency(a1, others[0])
        val milestoneAsSuccessor = TestPlan.dependency(others[1], a2)
        val projectAsPredecessor = TestPlan.dependency(projectRef(w.projectId), others[2])
        val projectAsSuccessor = TestPlan.dependency(others[3], projectRef(w.projectId))
        val unrelated = TestPlan.dependency(others[4], others[5])
        withAuditCapture { capture ->
            assertEquals(HttpStatusCode.NoContent, w.projectOwner.client.delete("/api/v1/projects/${w.projectId}").status)
            val event = capture.awaitEvent { it.message == "project.deleted" && it.hasKeyValue("projectId", w.projectId.toLong()) }
            assertNotNull(event)
            assertTrue(event.hasKeyValue("milestoneCount", 2))
            assertTrue(event.hasKeyValue("dependencyCount", 4), "the project's own two and its milestones' two, either end")
            assertTrue(
                event.hasKeyValue(
                    "dependencyIds",
                    joined(listOf(milestoneAsPredecessor, milestoneAsSuccessor, projectAsPredecessor, projectAsSuccessor)),
                ),
                "the cascaded link ids",
            )
            assertTrue(
                event.hasKeyValue("successorProjectIds", joined(listOf(w.projectId, b.projectId))),
                "the projects whose plan lost a constraint, the deleted project's own included",
            )
        }
        for (id in listOf(milestoneAsPredecessor, milestoneAsSuccessor, projectAsPredecessor, projectAsSuccessor)) {
            assertEquals(HttpStatusCode.NotFound, w.admin.client.get("/api/v1/dependencies/$id").status)
            assertTrue(linkState(id), "link $id is soft-deleted")
        }
        assertEquals(HttpStatusCode.OK, w.admin.client.get("/api/v1/dependencies/$unrelated").status, "a link elsewhere stays")
        assertEquals(0, links("pred_project_id = ${w.projectId} OR succ_project_id = ${w.projectId}"))
    }

    @Test
    fun `a project move, a team change and an unschedule keep the links`() = testApplication {
        usePostgresTestcontainer()
        val w = planWorld("dcs", teams = true)
        val t = w.requireTeams()
        val b = secondProject(w, "dcs")
        val admin = w.admin.client
        val a1 = TestPlan.milestone(w.projectId, t.teamId)
        val b1 = TestPlan.milestone(b.projectId, t.teamId)
        TestPlan.schedule(a1, "2027-02-01", "2027-02-05")
        val link = TestPlan.dependency(milestoneRef(a1), milestoneRef(b1))
        val projectLink = TestPlan.dependency(projectRef(w.projectId), milestoneRef(b1), lag = 2)

        val otherProgram = TestPlan.program(w.streamId, w.programOwner.personId!!)
        val move = admin.postJson("/api/v1/projects/${w.projectId}/move", ProjectMoveRequest(otherProgram))
        assertEquals(HttpStatusCode.NoContent, move.status)
        assertEquals(HttpStatusCode.OK, admin.get("/api/v1/dependencies/$link").status, "a move changes no id")
        assertEquals(HttpStatusCode.OK, admin.get("/api/v1/dependencies/$projectLink").status)

        val name = admin.get("/api/v1/milestones/$a1").body<MilestoneResponse>().name
        val teamChange = admin.putJson("/api/v1/milestones/$a1", MilestoneUpdateRequest(name, null, t.otherTeamId, 2.0))
        assertEquals(HttpStatusCode.NoContent, teamChange.status)
        val afterTeamChange = admin.get("/api/v1/dependencies/$link").body<DependencyResponse>()
        assertEquals(t.otherTeamId, afterTeamChange.predecessor.teamId, "links never involve teams, the endpoint reads the new one")

        val unschedule = MilestoneScheduleRequest(TestPlan.revision(), null, null)
        assertEquals(HttpStatusCode.OK, t.otherManager.client.putJson("/api/v1/milestones/$a1/schedule", unschedule).status)
        val afterUnschedule = admin.get("/api/v1/dependencies/$link").body<DependencyResponse>()
        assertNull(afterUnschedule.predecessor.startDate, "unscheduled endpoints keep the link")
        assertNull(afterUnschedule.predecessor.endDate)
        val afterSpanEmptied = admin.get("/api/v1/dependencies/$projectLink").body<DependencyResponse>()
        assertNull(afterSpanEmptied.predecessor.startDate, "the project's span emptied")
    }

    @Test
    fun `a create held open is re-guarded under the lock, the owner re-assigned meanwhile is 403 and writes nothing`() = testApplication {
        usePostgresTestcontainer()
        val w = planWorld("dgo", teams = true)
        val t = w.requireTeams()
        val b = secondProject(w, "dgo")
        val a1 = milestoneRef(TestPlan.milestone(w.projectId, t.teamId))
        val b1 = milestoneRef(TestPlan.milestone(b.projectId, t.teamId))
        val revision = TestPlan.revision()
        val response = requestHeldAtPlanLock(
            { b.owner.client.postDependency(b.projectId, a1, b1) },
            { it.exec("UPDATE projects SET owner_person_id = ? WHERE id = ?", w.stranger.personId!!.toInt(), b.projectId.toInt()) },
        )
        assertEquals(HttpStatusCode.Forbidden, response.status, "the guard runs on the chain re-read under the lock")
        assertEquals(revision, TestPlan.revision(), "no bump")
        assertEquals(0, links("succ_milestone_id = ${b1.id}"))
    }

    @Test
    fun `a create held open sees its ends change, an end deleted meanwhile is 400 and writes nothing`() = testApplication {
        usePostgresTestcontainer()
        val w = planWorld("dgm", teams = true)
        val t = w.requireTeams()
        val b = secondProject(w, "dgm")
        val a1 = milestoneRef(TestPlan.milestone(w.projectId, t.teamId))
        val b1 = milestoneRef(TestPlan.milestone(b.projectId, t.teamId))
        val c1 = milestoneRef(TestPlan.milestone(b.projectId, t.teamId))
        val revision = TestPlan.revision()
        val successorGone = requestHeldAtPlanLock(
            { w.admin.client.postDependency(b.projectId, a1, b1) },
            { it.exec("UPDATE milestones SET marked_as_deleted = TRUE WHERE id = ?", b1.id.toInt()) },
        )
        assertEquals(HttpStatusCode.BadRequest, successorGone.status, "the successor is re-resolved under the lock")
        val predecessorGone = requestHeldAtPlanLock(
            { w.admin.client.postDependency(b.projectId, a1, c1) },
            { it.exec("UPDATE milestones SET marked_as_deleted = TRUE WHERE id = ?", a1.id.toInt()) },
        )
        assertEquals(HttpStatusCode.BadRequest, predecessorGone.status, "the predecessor is re-resolved under the lock")
        assertEquals(revision, TestPlan.revision(), "both refused writes rolled back: no bump")
        assertEquals(0, links("pred_milestone_id = ${a1.id} OR succ_milestone_id = ${b1.id}"))
    }

    @Test
    fun `a delete held open is re-guarded under the plan lock, and a link deleted meanwhile is 404`() = testApplication {
        usePostgresTestcontainer()
        val w = planWorld("dgd", teams = true)
        val t = w.requireTeams()
        val b = secondProject(w, "dgd")
        val a1 = milestoneRef(TestPlan.milestone(w.projectId, t.teamId))
        val b1 = milestoneRef(TestPlan.milestone(b.projectId, t.teamId))
        val link = TestPlan.dependency(a1, b1)
        val revision = TestPlan.revision()
        val demoted = requestHeldAtPlanLock(
            { b.owner.client.delete("/api/v1/dependencies/$link") },
            { it.exec("UPDATE projects SET owner_person_id = ? WHERE id = ?", w.stranger.personId!!.toInt(), b.projectId.toInt()) },
        )
        assertEquals(HttpStatusCode.Forbidden, demoted.status)
        assertEquals(revision, TestPlan.revision(), "no bump")
        assertEquals(false, linkState(link), "the link is still active")
        val vanished = requestHeldAtPlanLock(
            { w.admin.client.delete("/api/v1/dependencies/$link") },
            { it.exec("UPDATE dependencies SET marked_as_deleted = TRUE WHERE id = ?", link.toInt()) },
        )
        assertEquals(HttpStatusCode.NotFound, vanished.status, "the chain is re-read under the lock")
    }

    @Test
    fun `dependency mutations audit their events and a rejected one emits nothing`() = testApplication {
        usePostgresTestcontainer()
        val w = planWorld("dau", teams = true)
        val t = w.requireTeams()
        val b = secondProject(w, "dau")
        val a1 = TestPlan.milestone(w.projectId, t.teamId)
        val b1 = TestPlan.milestone(b.projectId, t.teamId)
        withAuditCapture { capture ->
            val created = w.admin.client.postDependency(b.projectId, milestoneRef(a1), milestoneRef(b1), DependencyType.SS, 3)
            val id = created.body<DependencyResponse>().id.toLong()
            val event = capture.awaitEvent { it.message == "dependency.created" && it.hasKeyValue("dependencyId", id) }
            assertNotNull(event)
            assertTrue(event.hasKeyValue("byUserId", w.admin.userId.toLong()))
            assertTrue(event.hasKeyValue("projectId", b.projectId.toLong()))
            assertTrue(event.hasKeyValue("predKind", "MILESTONE"))
            assertTrue(event.hasKeyValue("predId", a1.toLong()))
            assertTrue(event.hasKeyValue("succKind", "MILESTONE"))
            assertTrue(event.hasKeyValue("succId", b1.toLong()))
            assertTrue(event.hasKeyValue("type", "SS"))
            assertTrue(event.hasKeyValue("lagDays", 3))

            // Rejected writes emit nothing of their own; a 403 is the central denial.
            val before = capture.events.count { it.message?.startsWith("dependency.") == true }
            w.admin.client.postDependency(b.projectId, milestoneRef(a1), milestoneRef(b1)) // duplicate pair
            w.admin.client.postDependency(w.projectId, milestoneRef(b1), milestoneRef(a1)) // a cycle
            w.admin.client.postDependency(b.projectId, milestoneRef(a1), milestoneRef(b1), lagDays = 999) // 400
            w.stranger.client.postDependency(b.projectId, milestoneRef(a1), projectRef(b.projectId)) // 403
            w.stranger.client.delete("/api/v1/dependencies/$id") // 403
            assertEquals(before, capture.events.count { it.message?.startsWith("dependency.") == true })
            assertNotNull(capture.awaitEvent { it.message == "authz.denied" && it.hasKeyValue("byUserId", w.stranger.userId.toLong()) })

            assertEquals(HttpStatusCode.NoContent, b.owner.client.delete("/api/v1/dependencies/$id").status)
            val deleted = capture.awaitEvent { it.message == "dependency.deleted" && it.hasKeyValue("dependencyId", id) }
            assertNotNull(deleted)
            assertTrue(deleted.hasKeyValue("byUserId", b.owner.userId.toLong()))
            assertTrue(deleted.hasKeyValue("predKind", "MILESTONE"))
            assertTrue(deleted.hasKeyValue("predId", a1.toLong()))
            assertTrue(deleted.hasKeyValue("succKind", "MILESTONE"))
            assertTrue(deleted.hasKeyValue("succId", b1.toLong()))
        }
    }

    @Test
    fun `the V15 constraints refuse what the service never writes, and the active-pair index frees on a soft delete`() = testApplication {
        usePostgresTestcontainer()
        val w = planWorld("dck", teams = true)
        val t = w.requireTeams()
        val b = secondProject(w, "dck")
        val m1 = TestPlan.milestone(w.projectId, t.teamId)
        val m2 = TestPlan.milestone(w.projectId, t.teamId)
        val p = b.projectId
        val check = "23514"
        val unique = "23505"
        val foreignKey = "23503"

        fun insert(
            predMilestone: Any?, predProject: Any?, succMilestone: Any?, succProject: Any?, type: String = "FS", lag: Int = 0,
        ): String? =
            PostgresTestSupport.connect().use { c ->
                try {
                    c.createStatement().use {
                        it.executeUpdate(
                            "INSERT INTO dependencies (pred_milestone_id, pred_project_id, succ_milestone_id, succ_project_id, \"type\", " +
                                "lag_days, created_at, updated_at) VALUES ($predMilestone, $predProject, $succMilestone, $succProject, " +
                                "'$type', $lag, 0, 0)",
                        )
                    }
                    null
                } catch (e: SQLException) {
                    e.sqlState
                }
            }

        fun softDeleteAll() = PostgresTestSupport.connect().use { c ->
            c.createStatement().use {
                it.executeUpdate(
                    "UPDATE dependencies SET marked_as_deleted = TRUE WHERE pred_milestone_id IN ($m1, $m2) OR " +
                        "succ_milestone_id IN ($m1, $m2) OR pred_project_id = $p OR succ_project_id = $p",
                )
            }
        }
        try {
            assertEquals(check, insert(null, null, m2, null), "a predecessor with no end")
            assertEquals(check, insert(m1, p, m2, null), "a predecessor with two ends")
            assertEquals(check, insert(m1, null, null, null), "a successor with no end")
            assertEquals(check, insert(m1, null, m2, p), "a successor with two ends")
            assertEquals(check, insert(m1, null, m1, null), "a milestone linked to itself")
            assertEquals(check, insert(null, p, null, p), "a project linked to itself")
            assertEquals(check, insert(m1, null, m2, null, type = "XX"), "an unknown type")
            assertEquals(check, insert(m1, null, m2, null, lag = 366), "a lag above the range")
            assertEquals(check, insert(m1, null, m2, null, lag = -366), "a lag below the range")
            assertEquals(foreignKey, insert(m1, null, 999_999, null), "a successor milestone that does not exist")
            assertNull(insert(m1, null, null, p), "a milestone linked to a project passes the self-link check")
            assertEquals(unique, insert(m1, null, null, p, type = "SS"), "NULLS NOT DISTINCT: the unused columns of each side collide")
            softDeleteAll()
            assertNull(insert(m1, null, m2, null), "the first of a pair")
            assertEquals(unique, insert(m1, null, m2, null, type = "FF", lag = 5), "one ACTIVE link per ordered pair, whatever the type")
            assertNull(insert(m2, null, m1, null), "the reverse pair is another ordered pair for the index (the service refuses it)")
            softDeleteAll()
            assertNull(insert(m1, null, m2, null), "a soft-deleted link frees the pair")
        } finally {
            softDeleteAll()
        }
    }
}
