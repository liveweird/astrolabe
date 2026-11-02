package ch.nokillswit

import ch.nokillswit.planning.BaselineCreateRequest
import ch.nokillswit.planning.BaselineResponse
import ch.nokillswit.planning.BaselineUpdateRequest
import ch.nokillswit.planning.DependencyResponse
import ch.nokillswit.planning.MilestoneCreateRequest
import ch.nokillswit.planning.MilestoneResponse
import ch.nokillswit.planning.MilestoneScheduleRequest
import ch.nokillswit.planning.MilestoneUpdateRequest
import ch.nokillswit.planning.PlanView
import ch.nokillswit.planning.ProgramCreateRequest
import ch.nokillswit.planning.ProgramResponse
import ch.nokillswit.planning.ProgramUpdateRequest
import ch.nokillswit.planning.ProjectCreateRequest
import ch.nokillswit.planning.ProjectResponse
import ch.nokillswit.planning.ProjectUpdateRequest
import ch.nokillswit.planning.RankingResponse
import ch.nokillswit.planning.RankingUpdateRequest
import ch.nokillswit.planning.TargetWindowRequest
import ch.nokillswit.planning.TeamScheduleBatchItem
import ch.nokillswit.planning.TeamScheduleBatchRequest
import ch.nokillswit.planning.WorkStreamCreateRequest
import ch.nokillswit.planning.WorkStreamResponse
import ch.nokillswit.planning.WorkStreamUpdateRequest
import ch.nokillswit.teams.CapacityPeriodRequest
import ch.nokillswit.teams.CapacityPeriodResponse
import io.ktor.client.call.body
import io.ktor.client.request.delete
import io.ktor.client.request.get
import io.ktor.http.HttpStatusCode
import io.ktor.server.testing.testApplication
import kotlinx.coroutines.async
import kotlinx.coroutines.coroutineScope
import kotlin.test.Test
import kotlin.test.assertEquals
import java.sql.Connection

/**
 * The `plan_state` revision and lock (V12): every plan write bumps the revision by exactly one, a rejected one leaves it alone, a
 * write waits for the lock (deterministic barrier: a raw JDBC session holds `plan_state FOR UPDATE`), and the checks that must be
 * atomic with a write — "count the children, then delete", "the owner is still active" — are, pinned with the same barrier.
 */
class PlanStateTest {

    @Test
    fun `every plan write bumps the revision by one and a rejected or read-only request leaves it alone`() = testApplication {
        usePostgresTestcontainer()
        val w = planWorld("rev")
        val admin = w.admin.client
        val owner = w.streamOwner.personId!!

        suspend fun bumps(expected: Long, label: String, call: suspend () -> HttpStatusCode, status: HttpStatusCode) {
            val before = TestPlan.revision()
            assertEquals(status, call(), label)
            assertEquals(before + expected, TestPlan.revision(), label)
        }

        val streamName = planName("rev")
        var streamId = 0u
        var programId = 0u
        var projectId = 0u
        bumps(1, "create work stream", {
            val response = admin.postJson("/api/v1/work-streams", WorkStreamCreateRequest(streamName, null, owner, "2026-01-01"))
            if (response.status == HttpStatusCode.Created) streamId = response.body<WorkStreamResponse>().id
            response.status
        }, HttpStatusCode.Created)
        bumps(1, "update work stream", {
            admin.putJson("/api/v1/work-streams/$streamId", WorkStreamUpdateRequest(streamName, "d", owner, "2026-01-01")).status
        }, HttpStatusCode.NoContent)
        bumps(1, "create program", {
            val response = admin.postJson("/api/v1/work-streams/$streamId/programs", ProgramCreateRequest(planName("p"), null, owner))
            if (response.status == HttpStatusCode.Created) programId = response.body<ProgramResponse>().id
            response.status
        }, HttpStatusCode.Created)
        bumps(1, "update program", {
            admin.putJson("/api/v1/programs/$programId", ProgramUpdateRequest(planName("p"), null, owner)).status
        }, HttpStatusCode.NoContent)
        bumps(1, "create project", {
            val response = admin.postJson("/api/v1/programs/$programId/projects", ProjectCreateRequest(planName("j"), null, owner))
            if (response.status == HttpStatusCode.Created) projectId = response.body<ProjectResponse>().id
            response.status
        }, HttpStatusCode.Created)
        bumps(1, "update project", {
            admin.putJson("/api/v1/projects/$projectId", ProjectUpdateRequest(planName("j"), null, owner)).status
        }, HttpStatusCode.NoContent)
        bumps(1, "set the target window", {
            admin.putJson("/api/v1/projects/$projectId/target-window", TargetWindowRequest("2026-02-01", "2026-02-28")).status
        }, HttpStatusCode.NoContent)

        // Rejected writes and reads leave the revision untouched.
        bumps(0, "409 on a name clash", {
            admin.postJson("/api/v1/work-streams", WorkStreamCreateRequest(streamName, null, owner, "2026-01-01")).status
        }, HttpStatusCode.Conflict)
        bumps(0, "400 on an inactive owner", {
            admin.putJson("/api/v1/programs/$programId", ProgramUpdateRequest(planName("p"), null, 999999u)).status
        }, HttpStatusCode.BadRequest)
        bumps(0, "403 for a stranger", {
            w.stranger.client.putJson("/api/v1/projects/$projectId/target-window", TargetWindowRequest()).status
        }, HttpStatusCode.Forbidden)
        bumps(0, "404 for an unknown project", {
            admin.putJson("/api/v1/projects/999999/target-window", TargetWindowRequest()).status
        }, HttpStatusCode.NotFound)
        bumps(0, "409 deleting a stream with a program", { admin.delete("/api/v1/work-streams/$streamId").status }, HttpStatusCode.Conflict)
        bumps(0, "the plan view read", { admin.get("/api/v1/views/plan").status }, HttpStatusCode.OK)
        bumps(0, "a project read", { admin.get("/api/v1/projects/$projectId").status }, HttpStatusCode.OK)

        bumps(1, "delete project", { admin.delete("/api/v1/projects/$projectId").status }, HttpStatusCode.NoContent)
        bumps(1, "delete program", { admin.delete("/api/v1/programs/$programId").status }, HttpStatusCode.NoContent)
        bumps(1, "delete work stream", { admin.delete("/api/v1/work-streams/$streamId").status }, HttpStatusCode.NoContent)
        assertEquals(TestPlan.revision(), admin.get("/api/v1/views/plan").body<PlanView>().revision)
    }

    @Test
    fun `every milestone write bumps the revision by one and a rejected or read-only request leaves it alone`() = testApplication {
        usePostgresTestcontainer()
        val w = planWorld("msrev", teams = true)
        val t = w.requireTeams()
        val admin = w.admin.client

        suspend fun bumps(expected: Long, label: String, call: suspend () -> HttpStatusCode, status: HttpStatusCode) {
            val before = TestPlan.revision()
            assertEquals(status, call(), label)
            assertEquals(before + expected, TestPlan.revision(), label)
        }

        var id = 0u
        val name = planName("msrev")
        bumps(1, "create milestone", {
            val response = admin.postJson("/api/v1/projects/${w.projectId}/milestones", MilestoneCreateRequest(name, null, t.teamId, 1.0))
            if (response.status == HttpStatusCode.Created) id = response.body<MilestoneResponse>().id
            response.status
        }, HttpStatusCode.Created)
        bumps(1, "update milestone", {
            admin.putJson("/api/v1/milestones/$id", MilestoneUpdateRequest(name, "d", t.teamId, 2.0)).status
        }, HttpStatusCode.NoContent)
        bumps(1, "schedule", {
            t.manager.client.putJson("/api/v1/milestones/$id/schedule", MilestoneScheduleRequest(TestPlan.revision(), "2026-11-02",
                "2026-11-06")).status
        }, HttpStatusCode.OK)
        bumps(1, "a no-op schedule", {
            t.manager.client.putJson("/api/v1/milestones/$id/schedule", MilestoneScheduleRequest(TestPlan.revision(), "2026-11-02",
                "2026-11-06")).status
        }, HttpStatusCode.OK)

        bumps(0, "409 on a name clash", {
            admin.postJson("/api/v1/projects/${w.projectId}/milestones", MilestoneCreateRequest(name, null, t.teamId, 1.0)).status
        }, HttpStatusCode.Conflict)
        bumps(0, "400 on an unknown team", {
            admin.putJson("/api/v1/milestones/$id", MilestoneUpdateRequest(name, null, 999999u, 1.0)).status
        }, HttpStatusCode.BadRequest)
        bumps(0, "403 for the project owner scheduling", {
            w.projectOwner.client.putJson("/api/v1/milestones/$id/schedule", MilestoneScheduleRequest(TestPlan.revision(), null,
                null)).status
        }, HttpStatusCode.Forbidden)
        bumps(0, "409 on a stale schedule", {
            t.manager.client.putJson("/api/v1/milestones/$id/schedule", MilestoneScheduleRequest(0, "2026-11-09", "2026-11-10")).status
        }, HttpStatusCode.Conflict)
        bumps(0, "400 on a weekend-only schedule", {
            t.manager.client.putJson("/api/v1/milestones/$id/schedule", MilestoneScheduleRequest(TestPlan.revision(), "2026-11-07",
                "2026-11-08")).status
        }, HttpStatusCode.BadRequest)
        bumps(0, "a milestone read", { admin.get("/api/v1/milestones/$id").status }, HttpStatusCode.OK)

        bumps(1, "delete milestone", { admin.delete("/api/v1/milestones/$id").status }, HttpStatusCode.NoContent)
        val other = TestPlan.milestone(w.projectId, t.teamId)
        bumps(1, "delete a project with milestones (one bump for the cascade)", {
            admin.delete("/api/v1/projects/${w.projectId}").status
        }, HttpStatusCode.NoContent)
        assertEquals(HttpStatusCode.NotFound, admin.get("/api/v1/milestones/$other").status)
    }

    @Test
    fun `a batch schedule bumps the revision by one - an all-skipped batch too - and a refused or rejected batch does not`() =
        testApplication {
            usePostgresTestcontainer()
            val w = planWorld("batchrev", teams = true)
            val t = w.requireTeams()
            val id = TestPlan.milestone(w.projectId, t.teamId)
            val path = "/api/v1/teams/${t.teamId}/milestone-schedules"
            fun body(expected: Long, start: String? = "2026-11-02", end: String? = "2026-11-06", milestone: UInt = id) =
                TeamScheduleBatchRequest(expected, listOf(TeamScheduleBatchItem(milestone, start, end)))

            suspend fun bumps(expected: Long, label: String, call: suspend () -> HttpStatusCode, status: HttpStatusCode) {
                val before = TestPlan.revision()
                assertEquals(status, call(), label)
                assertEquals(before + expected, TestPlan.revision(), label)
            }

            bumps(1, "a batch of one", { t.manager.client.postJson(path, body(TestPlan.revision())).status }, HttpStatusCode.OK)
            bumps(1, "a no-op batch", { t.manager.client.postJson(path, body(TestPlan.revision())).status }, HttpStatusCode.OK)
            bumps(1, "an all-skipped batch (an unknown id)", {
                t.manager.client.postJson(path, body(TestPlan.revision(), milestone = 999_999u)).status
            }, HttpStatusCode.OK)
            bumps(0, "403 for the project owner", { w.projectOwner.client.postJson(path, body(TestPlan.revision())).status },
                HttpStatusCode.Forbidden)
            bumps(0, "404 for an unknown team", {
                t.manager.client.postJson("/api/v1/teams/999999/milestone-schedules", body(TestPlan.revision())).status
            }, HttpStatusCode.NotFound)
            bumps(0, "409 for a view from the future", { t.manager.client.postJson(path, body(TestPlan.revision() + 1)).status },
                HttpStatusCode.Conflict)
            bumps(0, "400 for a weekend-only span", {
                t.manager.client.postJson(path, body(TestPlan.revision(), "2026-11-07", "2026-11-08")).status
            }, HttpStatusCode.BadRequest)
            bumps(0, "400 for a malformed scope hash", {
                t.manager.client.postJson(path, body(TestPlan.revision()).copy(scopeHash = "nope")).status
            }, HttpStatusCode.BadRequest)
            bumps(0, "409 for a scope hash that no longer matches (stale-scope)", {
                t.manager.client.postJson(path, body(TestPlan.revision()).copy(scopeHash = "0".repeat(64))).status
            }, HttpStatusCode.Conflict)
        }

    @Test
    fun `a dependency write bumps the revision by one, a refused cycle or duplicate or forbidden write does not`() = testApplication {
        usePostgresTestcontainer()
        val w = planWorld("deprev", teams = true)
        val t = w.requireTeams()
        val b = secondProject(w, "deprev")
        val admin = w.admin.client
        val a1 = milestoneRef(TestPlan.milestone(w.projectId, t.teamId))
        val b1 = milestoneRef(TestPlan.milestone(b.projectId, t.teamId))

        suspend fun bumps(expected: Long, label: String, call: suspend () -> HttpStatusCode, status: HttpStatusCode) {
            val before = TestPlan.revision()
            assertEquals(status, call(), label)
            assertEquals(before + expected, TestPlan.revision(), label)
        }

        var id = 0u
        bumps(1, "create dependency", {
            val response = admin.postDependency(b.projectId, a1, b1)
            if (response.status == HttpStatusCode.Created) id = response.body<DependencyResponse>().id
            response.status
        }, HttpStatusCode.Created)
        bumps(0, "409 on the same ordered pair", { admin.postDependency(b.projectId, a1, b1).status }, HttpStatusCode.Conflict)
        bumps(0, "409 on a cycle", { admin.postDependency(w.projectId, b1, a1).status }, HttpStatusCode.Conflict)
        bumps(0, "403 for the predecessor's owner", {
            w.projectOwner.client.postDependency(b.projectId, a1, projectRef(b.projectId)).status
        }, HttpStatusCode.Forbidden)
        bumps(0, "400 on an unknown predecessor", { admin.postDependency(b.projectId, milestoneRef(999999u), b1).status },
            HttpStatusCode.BadRequest)
        bumps(0, "a dependency read", { admin.get("/api/v1/dependencies/$id").status }, HttpStatusCode.OK)
        bumps(0, "403 deleting as the predecessor's owner", { w.projectOwner.client.delete("/api/v1/dependencies/$id").status },
            HttpStatusCode.Forbidden)
        bumps(1, "delete dependency", { b.owner.client.delete("/api/v1/dependencies/$id").status }, HttpStatusCode.NoContent)
        bumps(0, "404 deleting it twice", { admin.delete("/api/v1/dependencies/$id").status }, HttpStatusCode.NotFound)

        TestPlan.dependency(a1, b1)
        bumps(1, "delete a milestone with links (one bump for the cascade)", {
            admin.delete("/api/v1/milestones/${a1.id}").status
        }, HttpStatusCode.NoContent)
        TestPlan.dependency(projectRef(w.projectId), b1)
        bumps(1, "delete a project with links (one bump for the cascade)", {
            admin.delete("/api/v1/projects/${w.projectId}").status
        }, HttpStatusCode.NoContent)
    }

    @Test
    fun `a capacity write is team data - none of its writes, nor the team delete cascade, bumps the plan revision`() =
        testApplication {
            usePostgresTestcontainer()
            val w = planWorld("caprev", teams = true)
            val t = w.requireTeams()
            val before = TestPlan.revision()
            val collection = "/api/v1/teams/${t.teamId}/capacity"
            val created = t.manager.client.postJson(collection, CapacityPeriodRequest("2027-02-01", 10.0, 2))
            assertEquals(HttpStatusCode.Created, created.status)
            val id = created.body<CapacityPeriodResponse>().id
            val period = "/api/v1/capacity-periods/$id"
            assertEquals(HttpStatusCode.NoContent, t.manager.client.putJson(period, CapacityPeriodRequest("2027-02-02", 11.0)).status)
            assertEquals(HttpStatusCode.Forbidden, t.otherManager.client.putJson(period, CapacityPeriodRequest("2027-02-03", 1.0)).status)
            assertEquals(HttpStatusCode.NoContent, w.admin.client.delete("/api/v1/capacity-periods/$id").status)
            TestPlan.capacityPeriod(t.teamId, "2027-03-01", 5.0)
            assertEquals(HttpStatusCode.NoContent, w.admin.client.delete("/api/v1/teams/${t.teamId}").status)
            assertEquals(before, TestPlan.revision(), "no capacity write bumped the plan revision")
        }

    @Test
    fun `a team order write bumps the revision by one, a stale, forbidden or invalid one does not`() = testApplication {
        usePostgresTestcontainer()
        val w = planWorld("orev", teams = true)
        val t = w.requireTeams()
        val a = TestPlan.milestone(w.projectId, t.teamId)
        val before = TestPlan.revision()
        assertEquals(HttpStatusCode.OK, t.manager.client.putTeamOrder(t.teamId, before, listOf(a)).status)
        assertEquals(before + 1, TestPlan.revision(), "an accepted order PUT is ONE plan write")
        assertEquals(HttpStatusCode.OK, t.manager.client.putTeamOrder(t.teamId, before + 1, emptyList()).status)
        assertEquals(before + 2, TestPlan.revision(), "the reset too")
        assertEquals(HttpStatusCode.Conflict, t.manager.client.putTeamOrder(t.teamId, before, listOf(a)).status)
        assertEquals(HttpStatusCode.Forbidden, t.otherManager.client.putTeamOrder(t.teamId, before + 2, listOf(a)).status)
        assertEquals(HttpStatusCode.BadRequest, t.manager.client.putTeamOrder(t.teamId, before + 2, listOf(a, a)).status)
        assertEquals(HttpStatusCode.NotFound, t.manager.client.putTeamOrder(999999u, before + 2, listOf(a)).status)
        assertEquals(before + 2, TestPlan.revision(), "no rejected request moved it")
    }

    @Test
    fun `a plan write waits for the plan_state lock, then completes and bumps the revision once`() = testApplication {
        usePostgresTestcontainer()
        val w = planWorld("lock")
        val owner = w.streamOwner.personId!!
        val before = TestPlan.revision()
        PostgresTestSupport.connect().use { raw ->
            raw.autoCommit = false
            raw.createStatement().use { it.executeQuery("SELECT revision FROM plan_state WHERE id = 1 FOR UPDATE").close() }
            try {
                coroutineScope {
                    val renaming = async {
                        w.admin.client.putJson(
                            "/api/v1/work-streams/${w.streamId}",
                            WorkStreamUpdateRequest(planName("locked"), null, owner, "2026-01-01"),
                        )
                    }
                    awaitLockWait("plan_state")
                    assertEquals(before, TestPlan.revision(), "the waiting write has changed nothing yet")
                    raw.rollback()
                    assertEquals(HttpStatusCode.NoContent, renaming.await().status)
                }
            } finally {
                raw.rollback()
            }
        }
        assertEquals(before + 1, TestPlan.revision())
    }

    @Test
    fun `deleting a stream counts its programs under the lock - a child created meanwhile is seen, so 409`() = testApplication {
        usePostgresTestcontainer()
        val w = planWorld("race")
        val owner = w.streamOwner.personId!!
        val streamId = TestPlan.workStream(owner)
        PostgresTestSupport.connect().use { raw ->
            raw.autoCommit = false
            raw.createStatement().use { it.executeQuery("SELECT revision FROM plan_state WHERE id = 1 FOR UPDATE").close() }
            try {
                coroutineScope {
                    val deleting = async { w.streamOwner.client.delete("/api/v1/work-streams/$streamId") }
                    awaitLockWait("plan_state")
                    // The concurrent writer that holds the plan lock creates a program under the stream, then commits.
                    raw.prepareStatement(
                        "INSERT INTO programs (work_stream_id, \"name\", owner_person_id, created_at, updated_at) VALUES (?, ?, ?, 1, 1)",
                    ).use { st ->
                        st.setInt(1, streamId.toInt())
                        st.setString(2, planName("raced-program"))
                        st.setInt(3, owner.toInt())
                        st.executeUpdate()
                    }
                    raw.commit()
                    assertEquals(
                        HttpStatusCode.Conflict,
                        deleting.await().status,
                        "the delete counts after the lock: it sees the program that committed first",
                    )
                }
            } finally {
                raw.rollback()
            }
        }
        assertEquals(HttpStatusCode.OK, w.admin.client.get("/api/v1/work-streams/$streamId").status, "the refused delete changed nothing")
    }

    @Test
    fun `creating a node waits for a concurrent person delete and then answers 400 for the deleted owner`() = testApplication {
        usePostgresTestcontainer()
        val w = planWorld("ownerrace")
        val person = TestPeople.seed(planName("Racing Owner"))
        val revision = TestPlan.revision()
        PostgresTestSupport.connect().use { raw ->
            raw.autoCommit = false
            // What PersonService.delete holds while it counts the person's nodes.
            raw.prepareStatement("SELECT id FROM people WHERE id = ? FOR NO KEY UPDATE").use { st ->
                st.setInt(1, person.toInt())
                st.executeQuery().close()
            }
            try {
                coroutineScope {
                    val creating = async {
                        w.admin.client.postJson(
                            "/api/v1/work-streams",
                            WorkStreamCreateRequest(planName("raced"), null, person, "2026-01-01"),
                        )
                    }
                    awaitLockWait("FOR SHARE")
                    raw.prepareStatement("UPDATE people SET marked_as_deleted = TRUE WHERE id = ?").use { st ->
                        st.setInt(1, person.toInt())
                        st.executeUpdate()
                    }
                    raw.commit()
                    assertEquals(HttpStatusCode.BadRequest, creating.await().status, "no active node is left owned by a deleted person")
                }
            } finally {
                raw.rollback()
            }
        }
        assertEquals(revision, TestPlan.revision(), "the rejected create rolled the revision bump back")
    }

    @Test
    fun `deleting a person waits for a concurrent node write that names them and then answers 409`() = testApplication {
        usePostgresTestcontainer()
        val w = planWorld("ownerrace2")
        val person = TestPeople.seed(planName("Assigned Meanwhile"))
        PostgresTestSupport.connect().use { raw ->
            raw.autoCommit = false
            // What a node write holds before its INSERT: the owner's person row FOR SHARE, then the node that names it.
            raw.prepareStatement("SELECT id FROM people WHERE id = ? FOR SHARE").use { st ->
                st.setInt(1, person.toInt())
                st.executeQuery().close()
            }
            raw.prepareStatement(
                "INSERT INTO work_streams (\"name\", owner_person_id, start_date, created_at, updated_at) " +
                    "VALUES (?, ?, DATE '2026-01-01', 1, 1)",
            ).use { st ->
                st.setString(1, planName("raced-stream"))
                st.setInt(2, person.toInt())
                st.executeUpdate()
            }
            try {
                coroutineScope {
                    val deleting = async { w.admin.client.delete("/api/v1/people/$person") }
                    awaitLockWait("FOR NO KEY UPDATE")
                    raw.commit()
                    assertEquals(
                        HttpStatusCode.Conflict,
                        deleting.await().status,
                        "the delete counts the nodes after the write committed: never an active node owned by a deleted person",
                    )
                }
            } finally {
                raw.rollback()
            }
        }
        assertEquals(HttpStatusCode.OK, w.admin.client.get("/api/v1/people/$person").status)
    }

    @Test
    fun `a demoted owner cannot finish a request that passed the outer guard - the chain is re-read under the lock`() = testApplication {
        usePostgresTestcontainer()
        val w = planWorld("regrant")
        val self = w.projectOwner.personId!!
        val revision = TestPlan.revision()
        // ADMIN reassigns the project to the stranger while the owner's request is held open; the owner tries to take it back.
        val response = requestHeldAtPlanLock(
            { w.projectOwner.client.putJson("/api/v1/projects/${w.projectId}", ProjectUpdateRequest(planName("regrant"), null, self)) },
            { it.exec("UPDATE projects SET owner_person_id = ? WHERE id = ?", w.stranger.personId!!.toInt(), w.projectId.toInt()) },
        )
        assertEquals(HttpStatusCode.Forbidden, response.status)
        assertEquals(revision, TestPlan.revision(), "the refused write rolled back: no revision bump")
        val stored = TestPlan.scalar("SELECT owner_person_id FROM projects WHERE id = ${w.projectId}") { it.getInt(1) }
        assertEquals(w.stranger.personId!!.toInt(), stored)
    }

    @Test
    fun `a demoted owner cannot create a child or delete under a held request`() = testApplication {
        usePostgresTestcontainer()
        val w = planWorld("heldchild")
        val revision = TestPlan.revision()
        val demote = { c: Connection ->
            c.exec("UPDATE programs SET owner_person_id = ? WHERE id = ?", w.stranger.personId!!.toInt(), w.programId.toInt())
        }
        // The program owner is demoted while a create-a-project (self-owned) request is held open.
        val created = requestHeldAtPlanLock(
            {
                w.programOwner.client.postJson(
                    "/api/v1/programs/${w.programId}/projects",
                    ProjectCreateRequest(planName("sneak"), null, w.programOwner.personId!!),
                )
            },
            demote,
        )
        assertEquals(HttpStatusCode.Forbidden, created.status)
        assertEquals(revision, TestPlan.revision())
    }

    @Test
    fun `re-linking the caller's person mid-request revokes the owner rights of the held write`() = testApplication {
        usePostgresTestcontainer()
        val w = planWorld("relink")
        val replacement = TestUsers.seed(email = uniqueEmail("relink-new"), password = "pw", role = ch.nokillswit.users.UserRole.USER)
        val revision = TestPlan.revision()
        val response = requestHeldAtPlanLock(
            {
                w.streamOwner.client.putJson(
                    "/api/v1/work-streams/${w.streamId}",
                    WorkStreamUpdateRequest(planName("relinked"), null, w.streamOwner.personId!!, "2026-01-01"),
                )
            },
            { it.exec("UPDATE people SET user_id = ? WHERE id = ?", replacement.toInt(), w.streamOwner.personId!!.toInt()) },
        )
        assertEquals(HttpStatusCode.Forbidden, response.status, "the person is no longer linked to the caller")
        assertEquals(revision, TestPlan.revision())
    }

    @Test
    fun `revoking the roadmap-editor grant mid-request refuses the held target-window write`() = testApplication {
        usePostgresTestcontainer()
        val w = planWorld("revoke")
        val revision = TestPlan.revision()
        val response = requestHeldAtPlanLock(
            { w.editor.client.putJson("/api/v1/projects/${w.projectId}/target-window", TargetWindowRequest("2026-03-01", "2026-03-31")) },
            { it.exec("DELETE FROM user_permissions WHERE user_id = ?", w.editor.userId.toInt()) },
        )
        assertEquals(HttpStatusCode.Forbidden, response.status)
        assertEquals(revision, TestPlan.revision())
        assertEquals(null, w.admin.client.get("/api/v1/projects/${w.projectId}").body<ProjectResponse>().targetStart)
    }

    @Test
    fun `deleting a program counts its projects under the lock - a project created meanwhile is seen, so 409`() = testApplication {
        usePostgresTestcontainer()
        val w = planWorld("race2")
        val owner = w.programOwner.personId!!
        val programId = TestPlan.program(w.streamId, owner)
        PostgresTestSupport.connect().use { raw ->
            raw.autoCommit = false
            raw.createStatement().use { it.executeQuery("SELECT revision FROM plan_state WHERE id = 1 FOR UPDATE").close() }
            try {
                coroutineScope {
                    val deleting = async { w.programOwner.client.delete("/api/v1/programs/$programId") }
                    awaitLockWait("plan_state")
                    raw.prepareStatement(
                        "INSERT INTO projects (program_id, \"name\", owner_person_id, created_at, updated_at) VALUES (?, ?, ?, 1, 1)",
                    ).use { st ->
                        st.setInt(1, programId.toInt())
                        st.setString(2, planName("raced-project"))
                        st.setInt(3, owner.toInt())
                        st.executeUpdate()
                    }
                    raw.commit()
                    assertEquals(HttpStatusCode.Conflict, deleting.await().status)
                }
            } finally {
                raw.rollback()
            }
        }
        assertEquals(HttpStatusCode.OK, w.admin.client.get("/api/v1/programs/$programId").status, "the refused delete changed nothing")
    }

    @Test
    fun `a holiday write is a plan write - it bumps once and stales no schedule, ranking or team order PUT held from before it`() =
        testApplication {
            usePostgresTestcontainer()
            val w = planWorld("holrev", teams = true)
            val t = w.requireTeams()
            val milestoneId = TestPlan.milestone(w.projectId, t.teamId)
            val scheduledAt = TestPlan.schedule(milestoneId, "2026-11-02", "2026-11-06")
            val orderedAt = TestPlan.teamOrder(t.teamId, listOf(milestoneId))
            val rankedAt = w.admin.client.putJson("/api/v1/roadmap/ranking", RankingUpdateRequest(TestPlan.revision(), listOf(w.projectId)))
                .body<RankingResponse>().revision
            val before = TestPlan.revision()

            TestHolidays.with("2084-02-02") {
                assertEquals(before + 1, TestPlan.revision(), "the holiday create bumped the plan revision by one")
                // Every revision below was read BEFORE the holiday write; none of them is stale now.
                val schedule = MilestoneScheduleRequest(scheduledAt, "2026-11-03", "2026-11-06")
                assertEquals(HttpStatusCode.OK, t.manager.client.putJson("/api/v1/milestones/$milestoneId/schedule", schedule).status)
                val ranking = RankingUpdateRequest(rankedAt, listOf(w.projectId))
                assertEquals(HttpStatusCode.OK, w.admin.client.putJson("/api/v1/roadmap/ranking", ranking).status)
                assertEquals(HttpStatusCode.OK, t.manager.client.putTeamOrder(t.teamId, orderedAt, listOf(milestoneId)).status)
            }
            assertEquals(before + 5, TestPlan.revision(), "the create, the three accepted PUTs and the delete: one bump each")
        }

    @Test
    fun `a baseline create, rename and delete each bump the revision by one, a rejected one does not, and none stales a client PUT`() =
        testApplication {
            usePostgresTestcontainer()
            val w = planWorld("blrev", teams = true)
            val t = w.requireTeams()
            val milestoneId = TestPlan.milestone(w.projectId, t.teamId)
            val scheduledAt = TestPlan.schedule(milestoneId, "2026-11-02", "2026-11-06")
            val orderedAt = TestPlan.teamOrder(t.teamId, listOf(milestoneId))
            val before = TestPlan.revision()
            val name = planName("blrev")

            val created = w.admin.client.postJson("/api/v1/baselines", BaselineCreateRequest(name))
            assertEquals(HttpStatusCode.Created, created.status)
            val baseline = created.body<BaselineResponse>()
            val id = baseline.id
            try {
                assertEquals(before + 1, TestPlan.revision(), "the create is ONE plan write")
                assertEquals(before + 1, baseline.planRevision, "and the baseline equals the revision it left")
                assertEquals(HttpStatusCode.Conflict, w.admin.client.postJson("/api/v1/baselines", BaselineCreateRequest(name)).status)
                val renameBody = BaselineUpdateRequest("$name-b")
                assertEquals(HttpStatusCode.NoContent, w.editor.client.putJson("/api/v1/baselines/$id", renameBody).status)
                assertEquals(before + 2, TestPlan.revision(), "a rename bumps once")
                assertEquals(HttpStatusCode.NoContent, w.editor.client.putJson("/api/v1/baselines/$id", renameBody).status)
                assertEquals(before + 3, TestPlan.revision(), "a no-op rename still bumps (the conservative rule)")
                assertEquals(HttpStatusCode.Forbidden, w.stranger.client.delete("/api/v1/baselines/$id").status)
                assertEquals(HttpStatusCode.NotFound, w.admin.client.delete("/api/v1/baselines/999999999").status)
                assertEquals(before + 3, TestPlan.revision(), "a refused or rejected write moved nothing")
                // Revisions read BEFORE the baseline writes are not stale: a baseline touches no schedule, ranking or order revision.
                val schedule = MilestoneScheduleRequest(scheduledAt, "2026-11-03", "2026-11-06")
                assertEquals(HttpStatusCode.OK, t.manager.client.putJson("/api/v1/milestones/$milestoneId/schedule", schedule).status)
                assertEquals(HttpStatusCode.OK, t.manager.client.putTeamOrder(t.teamId, orderedAt, listOf(milestoneId)).status)
                assertEquals(HttpStatusCode.NoContent, w.admin.client.delete("/api/v1/baselines/$id").status)
                assertEquals(before + 6, TestPlan.revision(), "the schedule PUT, the order PUT and the delete: one bump each")
            } finally {
                TestPlan.deleteBaseline(id)
            }
        }
}
