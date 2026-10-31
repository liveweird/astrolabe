package ch.nokillswit

import ch.nokillswit.planning.MilestoneCreateRequest
import ch.nokillswit.plugins.ProblemDetail
import ch.nokillswit.teams.TeamCreateRequest
import ch.nokillswit.teams.TeamPageResponse
import ch.nokillswit.teams.TeamResponse
import ch.nokillswit.teams.TeamUpdateRequest
import ch.nokillswit.users.UserRole
import io.ktor.client.call.body
import io.ktor.client.request.delete
import io.ktor.client.request.get
import io.ktor.client.request.post
import io.ktor.client.request.put
import io.ktor.client.request.setBody
import io.ktor.http.ContentType
import io.ktor.http.contentType
import io.ktor.http.HttpStatusCode
import io.ktor.server.testing.testApplication
import kotlinx.coroutines.async
import kotlinx.coroutines.coroutineScope
import java.util.UUID
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNotNull
import kotlin.test.assertTrue

/**
 * The flat-teams surface (V6): CRUD, the manager (a person since V10), the list filters, the authz split (any
 * authenticated reads, ADMIN writes with guard-before-read), and the soft-delete/partial-index
 * semantics. Teams are SHARED suite state — every test mints UNIQUE names.
 */
class TeamTest {

    private fun name(prefix: String) = "$prefix-${UUID.randomUUID().toString().substring(0, 8)}"

    @Test
    fun `unauthenticated requests are 401`() = testApplication {
        usePostgresTestcontainer()
        val client = jsonClient()
        assertEquals(HttpStatusCode.Unauthorized, client.get("/api/v1/teams").status)
        assertEquals(HttpStatusCode.Unauthorized, client.get("/api/v1/teams/1").status)
        assertEquals(HttpStatusCode.Unauthorized, client.post("/api/v1/teams").status)
        assertEquals(HttpStatusCode.Unauthorized, client.put("/api/v1/teams/1").status)
        assertEquals(HttpStatusCode.Unauthorized, client.delete("/api/v1/teams/1").status)
    }

    @Test
    fun `non-admin may read but not write - uniformly 403 even on an unknown id`() = testApplication {
        usePostgresTestcontainer()
        val client = seededClient("teamuser")
        val id = TestTeams.seed(name("teamro"))
        assertEquals(HttpStatusCode.OK, client.get("/api/v1/teams").status)
        assertEquals(HttpStatusCode.OK, client.get("/api/v1/teams/$id").status)
        assertEquals(HttpStatusCode.Forbidden, client.postJson("/api/v1/teams", TeamCreateRequest(name("x"))).status)
        assertEquals(HttpStatusCode.Forbidden, client.putJson("/api/v1/teams/999999", TeamUpdateRequest(name("x"))).status)
        assertEquals(HttpStatusCode.Forbidden, client.delete("/api/v1/teams/999999").status)
        // The guard runs before the body decodes: a non-admin's malformed body stays 403.
        val malformed = client.post("/api/v1/teams") {
            contentType(ContentType.Application.Json)
            setBody("{ not json")
        }
        assertEquals(HttpStatusCode.Forbidden, malformed.status)
    }

    @Test
    fun `admin CRUD round-trips - create, read, list, rename, delete`() = testApplication {
        usePostgresTestcontainer()
        val admin = seededClient("teamcrud", UserRole.ADMIN)
        val teamName = name("Payments")

        val create = admin.postJson(
            "/api/v1/teams",
            TeamCreateRequest(name = "  $teamName  ", description = "  Money movers  "),
        )
        assertEquals(HttpStatusCode.Created, create.status)
        assertNotNull(create.headers["Location"])
        val created = create.body<TeamResponse>()
        assertEquals(teamName, created.name, "the sanitizer trims")
        assertEquals("Money movers", created.description)

        val read = admin.get("/api/v1/teams/${created.id}").body<TeamResponse>()
        assertEquals(created, read)

        val page = admin.get("/api/v1/teams?name=${teamName.lowercase()}&sort=-name").body<TeamPageResponse>()
        assertEquals(1, page.total)
        assertEquals(created.id, page.items.single().id)
        assertEquals(HttpStatusCode.BadRequest, admin.get("/api/v1/teams?sort=description").status)

        val renamed = name("Treasury")
        assertEquals(
            HttpStatusCode.NoContent,
            admin.putJson("/api/v1/teams/${created.id}", TeamUpdateRequest(name = renamed, description = null)).status,
        )
        val afterRename = admin.get("/api/v1/teams/${created.id}").body<TeamResponse>()
        assertEquals(renamed, afterRename.name)
        assertEquals(null, afterRename.description, "PUT is a full replace — an omitted description clears")
        assertTrue(afterRename.updatedAt >= created.updatedAt)

        assertEquals(HttpStatusCode.NoContent, admin.delete("/api/v1/teams/${created.id}").status)
        assertEquals(HttpStatusCode.NotFound, admin.get("/api/v1/teams/${created.id}").status)
        assertTrue(TestTeams.rawRows().single { it.id == created.id }.markedAsDeleted, "delete must soft-delete")
    }

    @Test
    fun `invalid payloads are 400 - blank name, overlong fields, control characters`() = testApplication {
        usePostgresTestcontainer()
        val admin = seededClient("teambad", UserRole.ADMIN)
        val cases = listOf(
            TeamCreateRequest(name = "   "),
            TeamCreateRequest(name = "x".repeat(101)),
            TeamCreateRequest(name = name("ok"), description = "d".repeat(501)),
            TeamCreateRequest(name = "tab\tcontrol"),
        )
        for (case in cases) {
            assertEquals(HttpStatusCode.BadRequest, admin.postJson("/api/v1/teams", case).status, "expected 400 for $case")
        }
        assertEquals(HttpStatusCode.BadRequest, admin.putJson("/api/v1/teams/999999", TeamUpdateRequest(name = "")).status)
        assertEquals(HttpStatusCode.NotFound, admin.putJson("/api/v1/teams/999999", TeamUpdateRequest(name = name("nf"))).status)
        assertEquals(HttpStatusCode.NotFound, admin.delete("/api/v1/teams/999999").status)
    }

    @Test
    fun `an active name clash is 409 case-insensitively and a soft-deleted team frees its name`() = testApplication {
        usePostgresTestcontainer()
        val admin = seededClient("teamdup", UserRole.ADMIN)
        val n = name("Dup")
        val first = admin.postJson("/api/v1/teams", TeamCreateRequest(n)).body<TeamResponse>()
        val clash = admin.postJson("/api/v1/teams", TeamCreateRequest(n.uppercase()))
        assertEquals(HttpStatusCode.Conflict, clash.status)
        assertTrue(clash.body<ProblemDetail>().detail!!.contains("team with this name"))
        val other = admin.postJson("/api/v1/teams", TeamCreateRequest(name("other"))).body<TeamResponse>()
        assertEquals(HttpStatusCode.Conflict, admin.putJson("/api/v1/teams/${other.id}", TeamUpdateRequest(n)).status)
        assertEquals(HttpStatusCode.NoContent, admin.delete("/api/v1/teams/${first.id}").status)
        val second = admin.postJson("/api/v1/teams", TeamCreateRequest(n))
        assertEquals(HttpStatusCode.Created, second.status)
        assertTrue(second.body<TeamResponse>().id != first.id)
    }

    @Test
    fun `mutations audit and a failed mutation does not`() = testApplication {
        usePostgresTestcontainer()
        val admin = seededClient("teamaudit", UserRole.ADMIN)
        withAuditCapture { capture ->
            val n = name("audited")
            val created = admin.postJson("/api/v1/teams", TeamCreateRequest(n)).body<TeamResponse>()
            val event = capture.awaitEvent { it.message == "team.created" && it.hasKeyValue("teamId", created.id.toLong()) }
            assertNotNull(event, "create must audit")
            assertTrue(event.hasKeyValue("name", n))

            admin.putJson("/api/v1/teams/${created.id}", TeamUpdateRequest(name("renamed")))
            assertNotNull(capture.awaitEvent { it.message == "team.updated" && it.hasKeyValue("teamId", created.id.toLong()) })
            admin.delete("/api/v1/teams/${created.id}")
            assertNotNull(capture.awaitEvent { it.message == "team.deleted" && it.hasKeyValue("teamId", created.id.toLong()) })

            val before = capture.events.count { it.message == "team.created" }
            assertEquals(HttpStatusCode.BadRequest, admin.postJson("/api/v1/teams", TeamCreateRequest("")).status)
            assertEquals(before, capture.events.count { it.message == "team.created" }, "failed create must not audit")
        }
    }

    @Test
    fun `a manager round-trips on create, read and list and a PUT replaces or clears it`() = testApplication {
        usePostgresTestcontainer()
        val admin = seededClient("teammgr", UserRole.ADMIN)
        val ann = TestPeople.seed("Ann Manager")
        val bob = TestPeople.seed("Bob Manager")
        val teamName = name("managed")

        val created = admin.postJson("/api/v1/teams", TeamCreateRequest(name = teamName, managerPersonId = ann))
            .body<TeamResponse>()
        assertEquals(ann, created.managerPersonId)
        assertEquals("Ann Manager", created.managerName)
        assertEquals(created, admin.get("/api/v1/teams/${created.id}").body<TeamResponse>())
        val listed = admin.get("/api/v1/teams?name=$teamName").body<TeamPageResponse>().items.single()
        assertEquals(ann, listed.managerPersonId)
        assertEquals("Ann Manager", listed.managerName)

        // One person may manage several teams.
        val second = admin.postJson("/api/v1/teams", TeamCreateRequest(name = name("managed2"), managerPersonId = ann))
            .body<TeamResponse>()
        assertEquals(ann, second.managerPersonId)

        assertEquals(
            HttpStatusCode.NoContent,
            admin.putJson("/api/v1/teams/${created.id}", TeamUpdateRequest(name = teamName, managerPersonId = bob)).status,
        )
        val replaced = admin.get("/api/v1/teams/${created.id}").body<TeamResponse>()
        assertEquals(bob, replaced.managerPersonId)
        assertEquals("Bob Manager", replaced.managerName)

        // PUT is a full replace: an omitted managerPersonId clears it.
        assertEquals(HttpStatusCode.NoContent, admin.putJson("/api/v1/teams/${created.id}", TeamUpdateRequest(name = teamName)).status)
        val cleared = admin.get("/api/v1/teams/${created.id}").body<TeamResponse>()
        assertEquals(null, cleared.managerPersonId)
        assertEquals(null, cleared.managerName)
        val clearedListed = admin.get("/api/v1/teams?name=$teamName").body<TeamPageResponse>().items.single()
        assertEquals(null, clearedListed.managerPersonId)
    }

    @Test
    fun `an unknown or soft-deleted manager is 400 on create and on update and changes nothing`() = testApplication {
        usePostgresTestcontainer()
        val admin = seededClient("teammgrbad", UserRole.ADMIN)
        val gone = TestPeople.seed("Gone Manager")
        TestPeople.softDelete(gone)
        val good = TestPeople.seed("Good Manager")
        val teamName = name("mgrbad")

        for (bad in listOf(999999u, gone)) {
            val create = admin.postJson("/api/v1/teams", TeamCreateRequest(name = teamName, managerPersonId = bad))
            assertEquals(HttpStatusCode.BadRequest, create.status, "create with manager $bad")
            assertTrue(create.body<ProblemDetail>().detail!!.contains("manager"))
        }
        assertTrue(TestTeams.rawRows().none { it.name == teamName }, "a rejected create leaves no team behind")

        val id = admin.postJson("/api/v1/teams", TeamCreateRequest(name = teamName, managerPersonId = good)).body<TeamResponse>().id
        for (bad in listOf(999999u, gone)) {
            assertEquals(
                HttpStatusCode.BadRequest,
                admin.putJson("/api/v1/teams/$id", TeamUpdateRequest(name = name("renamed"), managerPersonId = bad)).status,
                "update with manager $bad",
            )
        }
        val after = admin.get("/api/v1/teams/$id").body<TeamResponse>()
        assertEquals(good, after.managerPersonId, "a rejected update changes nothing")
        assertEquals(teamName, after.name)
    }

    @Test
    fun `a soft-deleted manager person reads as no manager and stops being the active manager`() = testApplication {
        usePostgresTestcontainer()
        val admin = seededClient("teammgrdel", UserRole.ADMIN)
        val user = TestUsers.seed(email = uniqueEmail("mgr-del"), password = "pw", role = UserRole.USER)
        val person = TestPeople.seed("Soon Gone", userId = user)
        val teamName = name("mgrdel")
        val id = admin.postJson("/api/v1/teams", TeamCreateRequest(name = teamName, managerPersonId = person))
            .body<TeamResponse>().id
        assertTrue(TestTeams.service.isActiveManager(id, user))

        TestPeople.softDelete(person)

        val read = admin.get("/api/v1/teams/$id").body<TeamResponse>()
        assertEquals(null, read.managerPersonId)
        assertEquals(null, read.managerName)
        val listed = admin.get("/api/v1/teams?name=$teamName").body<TeamPageResponse>().items.single()
        assertEquals(null, listed.managerPersonId)
        assertEquals(null, listed.managerName)
        assertFalse(TestTeams.service.isActiveManager(id, user), "a deleted manager person holds no rights")
    }

    @Test
    fun `a soft-deleted login stops being the active manager while the person and the link stay`() = testApplication {
        usePostgresTestcontainer()
        val admin = seededClient("teammgrlogin", UserRole.ADMIN)
        val user = TestUsers.seed(email = uniqueEmail("mgr-login"), password = "pw", role = UserRole.USER)
        val person = TestPeople.seed("Login Gone Manager", userId = user)
        val teamId = admin.postJson("/api/v1/teams", TeamCreateRequest(name = name("logindel"), managerPersonId = person))
            .body<TeamResponse>().id
        assertTrue(TestTeams.service.isActiveManager(teamId, user))

        TestUsers.softDelete(user)

        assertFalse(TestTeams.service.isActiveManager(teamId, user), "the user-active predicate is the second line behind the access check")
        val read = admin.get("/api/v1/teams/$teamId").body<TeamResponse>()
        assertEquals(person, read.managerPersonId, "the person stays the manager")
        assertTrue(TestPeople.rawRows().single { it.id == person }.userId == user, "the inert link is kept")
    }

    @Test
    fun `isActiveManager is true only for the login of the active manager person of an active team`() = testApplication {
        usePostgresTestcontainer()
        val admin = seededClient("teammgrchk", UserRole.ADMIN)
        val user = TestUsers.seed(email = uniqueEmail("mgr-chk"), password = "pw", role = UserRole.USER)
        val other = TestUsers.seed(email = uniqueEmail("mgr-oth"), password = "pw", role = UserRole.USER)
        val person = TestPeople.seed("Checked Manager", userId = user)
        val loginless = TestPeople.seed("No Login Manager")
        val managed = admin.postJson("/api/v1/teams", TeamCreateRequest(name = name("chk"), managerPersonId = person))
            .body<TeamResponse>().id
        val withoutLogin = admin.postJson("/api/v1/teams", TeamCreateRequest(name = name("chk-nl"), managerPersonId = loginless))
            .body<TeamResponse>().id
        val unmanaged = TestTeams.seed(name("chk-none"))

        assertTrue(TestTeams.service.isActiveManager(managed, user))
        assertFalse(TestTeams.service.isActiveManager(managed, other), "somebody else")
        assertFalse(TestTeams.service.isActiveManager(withoutLogin, user), "a team managed by a person with no login")
        assertFalse(TestTeams.service.isActiveManager(unmanaged, user), "a team they do not manage")
        assertFalse(TestTeams.service.isActiveManager(999999u, user), "a missing team")
        assertEquals(HttpStatusCode.NoContent, admin.delete("/api/v1/teams/$managed").status)
        assertFalse(TestTeams.service.isActiveManager(managed, user), "a deleted team")
    }

    @Test
    fun `being a team's manager grants no write on the team itself`() = testApplication {
        usePostgresTestcontainer()
        val admin = seededClient("teammgrrw", UserRole.ADMIN)
        val email = uniqueEmail("mgr-rw")
        val user = TestUsers.seed(email = email, password = "pw", role = UserRole.USER)
        val manager = TestPeople.seed("Write Manager", userId = user)
        val id = admin.postJson("/api/v1/teams", TeamCreateRequest(name = name("rw"), managerPersonId = manager))
            .body<TeamResponse>().id
        val client = authedClient(email, "pw")
        assertEquals(HttpStatusCode.OK, client.get("/api/v1/teams/$id").status)
        assertEquals(
            HttpStatusCode.Forbidden,
            client.putJson("/api/v1/teams/$id", TeamUpdateRequest(name = name("hijack"), managerPersonId = manager)).status,
        )
        assertEquals(HttpStatusCode.Forbidden, client.delete("/api/v1/teams/$id").status)
    }

    @Test
    fun `team manager_changed is audited on an actual change and not on a same-id re-PUT`() = testApplication {
        usePostgresTestcontainer()
        val adminEmail = uniqueEmail("mgr-audit-admin")
        val adminId = TestUsers.seed(email = adminEmail, password = "pw", role = UserRole.ADMIN)
        val admin = authedClient(adminEmail, "pw")
        val ann = TestPeople.seed("Audited Manager")
        withAuditCapture { capture ->
            val teamName = name("mgraudit")
            val created = admin.postJson("/api/v1/teams", TeamCreateRequest(name = teamName, managerPersonId = ann))
                .body<TeamResponse>()
            val teamId = created.id.toLong()
            val createdEvent = capture.awaitEvent { it.message == "team.created" && it.hasKeyValue("teamId", teamId) }
            assertNotNull(createdEvent)
            assertTrue(createdEvent.hasKeyValue("managerPersonId", ann.toLong()))

            // Same manager again: team.updated fires, team.manager_changed does not.
            admin.putJson("/api/v1/teams/${created.id}", TeamUpdateRequest(name = teamName, managerPersonId = ann))
            assertNotNull(capture.awaitEvent { it.message == "team.updated" && it.hasKeyValue("teamId", teamId) })

            // A real change (clear) — and only now does the trail carry a manager line.
            admin.putJson("/api/v1/teams/${created.id}", TeamUpdateRequest(name = teamName))
            val changed = capture.awaitEvent { it.message == "team.manager_changed" && it.hasKeyValue("teamId", teamId) }
            assertNotNull(changed)
            assertTrue(changed.hasKeyValue("byUserId", adminId.toLong()))
            assertTrue(changed.hasKeyValue("managerFrom", ann.toLong()))
            assertTrue(changed.hasKeyValue("managerTo", null))
            assertEquals(
                1,
                capture.events.count { it.message == "team.manager_changed" && it.hasKeyValue("teamId", teamId) },
                "only the actual change is audited",
            )
        }
    }

    @Test
    fun `a team that an active milestone names cannot be deleted - 409 until the milestone is deleted or moved`() = testApplication {
        usePostgresTestcontainer()
        val w = planWorld("teamms", teams = true)
        val t = w.requireTeams()
        val milestone = TestPlan.milestone(w.projectId, t.teamId)
        val response = w.admin.client.delete("/api/v1/teams/${t.teamId}")
        assertEquals(HttpStatusCode.Conflict, response.status)
        assertEquals("Team still has milestones", response.body<ProblemDetail>().detail)
        assertEquals(HttpStatusCode.OK, w.admin.client.get("/api/v1/teams/${t.teamId}").status, "the refused delete changed nothing")
        // Moving the milestone to another team frees the first team; deleting the milestone frees the second.
        val moved = ch.nokillswit.planning.MilestoneUpdateRequest(planName("moved"), null, t.otherTeamId, 1.0)
        assertEquals(HttpStatusCode.NoContent, w.admin.client.putJson("/api/v1/milestones/$milestone", moved).status)
        assertEquals(HttpStatusCode.NoContent, w.admin.client.delete("/api/v1/teams/${t.teamId}").status)
        assertEquals(HttpStatusCode.Conflict, w.admin.client.delete("/api/v1/teams/${t.otherTeamId}").status)
        assertEquals(HttpStatusCode.NoContent, w.admin.client.delete("/api/v1/milestones/$milestone").status)
        assertEquals(HttpStatusCode.NoContent, w.admin.client.delete("/api/v1/teams/${t.otherTeamId}").status,
            "a deleted milestone no longer counts")
    }

    @Test
    fun `a team delete waits for a concurrent milestone write that locked the team and then answers 409`() = testApplication {
        usePostgresTestcontainer()
        val w = planWorld("teamrace1", teams = true)
        val t = w.requireTeams()
        PostgresTestSupport.connect().use { raw ->
            raw.autoCommit = false
            // What a milestone write holds before its INSERT: the team row FOR SHARE (MilestoneService.requireActiveTeam).
            raw.prepareStatement("SELECT id FROM teams WHERE id = ? FOR SHARE").use { st ->
                st.setInt(1, t.teamId.toInt())
                st.executeQuery().close()
            }
            raw.prepareStatement(
                "INSERT INTO milestones (project_id, team_id, \"name\", estimate_md, schedule_revision, created_at, updated_at) " +
                    "VALUES (?, ?, ?, 1, 0, 1, 1)",
            ).use { st ->
                st.setInt(1, w.projectId.toInt())
                st.setInt(2, t.teamId.toInt())
                st.setString(3, planName("raced-milestone"))
                st.executeUpdate()
            }
            try {
                coroutineScope {
                    val deleting = async { w.admin.client.delete("/api/v1/teams/${t.teamId}") }
                    awaitLockWait("FOR NO KEY UPDATE")
                    raw.commit()
                    assertEquals(
                        HttpStatusCode.Conflict,
                        deleting.await().status,
                        "the delete counts after the milestone committed: never an active milestone on a deleted team",
                    )
                }
            } finally {
                raw.rollback()
            }
        }
        assertEquals(HttpStatusCode.OK, w.admin.client.get("/api/v1/teams/${t.teamId}").status)
    }

    @Test
    fun `a milestone create waits for a concurrent team delete and then answers 400 for the deleted team`() = testApplication {
        usePostgresTestcontainer()
        val w = planWorld("teamrace2", teams = true)
        val t = w.requireTeams()
        val revision = TestPlan.revision()
        PostgresTestSupport.connect().use { raw ->
            raw.autoCommit = false
            // What TeamService.delete holds while it counts the team's milestones.
            raw.prepareStatement("SELECT id FROM teams WHERE id = ? FOR NO KEY UPDATE").use { st ->
                st.setInt(1, t.teamId.toInt())
                st.executeQuery().close()
            }
            try {
                coroutineScope {
                    val creating = async {
                        w.admin.client.postJson(
                            "/api/v1/projects/${w.projectId}/milestones",
                            MilestoneCreateRequest(planName("raced"), null, t.teamId, 1.0),
                        )
                    }
                    awaitLockWait("FOR SHARE")
                    raw.exec("UPDATE teams SET marked_as_deleted = TRUE WHERE id = ?", t.teamId.toInt())
                    raw.commit()
                    assertEquals(HttpStatusCode.BadRequest, creating.await().status, "no active milestone is left on a deleted team")
                }
            } finally {
                raw.rollback()
            }
        }
        assertEquals(revision, TestPlan.revision(), "the rejected create rolled the revision bump back")
    }
}
