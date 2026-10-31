package ch.nokillswit

import ch.nokillswit.people.PersonCreateRequest
import ch.nokillswit.people.PersonPageResponse
import ch.nokillswit.people.PersonResponse
import ch.nokillswit.people.PersonUpdateRequest
import ch.nokillswit.planning.ProjectUpdateRequest
import ch.nokillswit.plugins.ProblemDetail
import ch.nokillswit.teams.TeamCreateRequest
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
import io.ktor.http.HttpStatusCode
import io.ktor.http.contentType
import io.ktor.server.testing.testApplication
import java.util.UUID
import kotlinx.coroutines.async
import kotlinx.coroutines.coroutineScope
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * The people directory (V10): CRUD, the list filters, the authz split (any authenticated reads, ADMIN writes with
 * guard-before-read), the optional email and login link with their partial-index 409s, the delete 409 while a person
 * manages a team, and the soft-delete semantics. People are SHARED suite state — every test mints UNIQUE names/emails.
 */
class PersonTest {

    private fun name(prefix: String) = "$prefix-${UUID.randomUUID().toString().substring(0, 8)}"

    private suspend fun seedUser(prefix: String): UInt =
        TestUsers.seed(email = uniqueEmail(prefix), password = "pw", role = UserRole.USER)

    @Test
    fun `unauthenticated requests are 401`() = testApplication {
        usePostgresTestcontainer()
        val client = jsonClient()
        assertEquals(HttpStatusCode.Unauthorized, client.get("/api/v1/people").status)
        assertEquals(HttpStatusCode.Unauthorized, client.get("/api/v1/people/1").status)
        assertEquals(HttpStatusCode.Unauthorized, client.post("/api/v1/people").status)
        assertEquals(HttpStatusCode.Unauthorized, client.put("/api/v1/people/1").status)
        assertEquals(HttpStatusCode.Unauthorized, client.delete("/api/v1/people/1").status)
    }

    @Test
    fun `non-admin may read - emails included - but not write, uniformly 403 even on an unknown id`() = testApplication {
        usePostgresTestcontainer()
        val client = seededClient("personuser")
        val email = uniqueEmail("ro")
        val id = TestPeople.seed(name("personro"), email = email)
        assertEquals(HttpStatusCode.OK, client.get("/api/v1/people").status)
        val read = client.get("/api/v1/people/$id")
        assertEquals(HttpStatusCode.OK, read.status)
        assertEquals(email, read.body<PersonResponse>().email, "every signed-in user sees emails")
        assertEquals(HttpStatusCode.Forbidden, client.postJson("/api/v1/people", PersonCreateRequest(name("x"))).status)
        assertEquals(HttpStatusCode.Forbidden, client.putJson("/api/v1/people/999999", PersonUpdateRequest(name("x"))).status)
        assertEquals(HttpStatusCode.Forbidden, client.delete("/api/v1/people/999999").status)
        // The guard runs before the body decodes: a non-admin's malformed body stays 403.
        val malformed = client.post("/api/v1/people") {
            contentType(ContentType.Application.Json)
            setBody("{ not json")
        }
        assertEquals(HttpStatusCode.Forbidden, malformed.status)
    }

    @Test
    fun `admin CRUD round-trips - create, read, list with filters and sort, rename, delete`() = testApplication {
        usePostgresTestcontainer()
        val admin = seededClient("personcrud", UserRole.ADMIN)
        val personName = name("Anna Nowak")
        val email = uniqueEmail("anna")

        val create = admin.postJson(
            "/api/v1/people",
            PersonCreateRequest(name = "  $personName  ", email = "  $email  "),
        )
        assertEquals(HttpStatusCode.Created, create.status)
        assertNotNull(create.headers["Location"])
        val created = create.body<PersonResponse>()
        assertEquals(personName, created.name, "the sanitizer trims")
        assertEquals(email, created.email)
        assertNull(created.userId)
        assertNull(created.userEmail)
        assertEquals(created, admin.get("/api/v1/people/${created.id}").body<PersonResponse>())

        val byName = admin.get("/api/v1/people?name=${personName.lowercase()}&sort=-name").body<PersonPageResponse>()
        assertEquals(1, byName.total)
        assertEquals(created.id, byName.items.single().id)
        val byEmail = admin.get("/api/v1/people?email=${email.uppercase()}").body<PersonPageResponse>()
        assertEquals(created.id, byEmail.items.single().id, "the email filter is case-insensitive")
        assertEquals(HttpStatusCode.BadRequest, admin.get("/api/v1/people?sort=userId").status)

        val renamed = name("Anna Kowalska")
        assertEquals(
            HttpStatusCode.NoContent,
            admin.putJson("/api/v1/people/${created.id}", PersonUpdateRequest(name = renamed)).status,
        )
        val after = admin.get("/api/v1/people/${created.id}").body<PersonResponse>()
        assertEquals(renamed, after.name)
        assertNull(after.email, "PUT is a full replace - an omitted email clears")
        assertTrue(after.updatedAt >= created.updatedAt)

        assertEquals(HttpStatusCode.NoContent, admin.delete("/api/v1/people/${created.id}").status)
        assertEquals(HttpStatusCode.NotFound, admin.get("/api/v1/people/${created.id}").status)
        assertTrue(TestPeople.rawRows().single { it.id == created.id }.markedAsDeleted, "delete must soft-delete")
        assertEquals(HttpStatusCode.NotFound, admin.delete("/api/v1/people/${created.id}").status)
    }

    @Test
    fun `invalid payloads are 400 - name, email shape, control characters, an inactive login`() = testApplication {
        usePostgresTestcontainer()
        val admin = seededClient("personbad", UserRole.ADMIN)
        val gone = seedUser("person-gone")
        TestUsers.softDelete(gone)
        val cases = listOf(
            PersonCreateRequest(name = "   "),
            PersonCreateRequest(name = "x".repeat(101)),
            PersonCreateRequest(name = name("ok"), email = "no-at-sign"),
            PersonCreateRequest(name = name("ok"), email = "a".repeat(250) + "@t.io"),
            PersonCreateRequest(name = "tab\tcontrol"),
            PersonCreateRequest(name = name("ok"), userId = 999999u),
            PersonCreateRequest(name = name("ok"), userId = gone),
        )
        for (case in cases) {
            assertEquals(HttpStatusCode.BadRequest, admin.postJson("/api/v1/people", case).status, "expected 400 for $case")
        }
        val detail = admin.postJson("/api/v1/people", PersonCreateRequest(name = name("ok"), userId = gone)).body<ProblemDetail>().detail
        assertTrue(detail!!.contains("user"))
        assertTrue(TestPeople.rawRows().none { it.userId == gone }, "a rejected create leaves no person behind")

        assertEquals(HttpStatusCode.BadRequest, admin.putJson("/api/v1/people/999999", PersonUpdateRequest(name = "")).status)
        assertEquals(HttpStatusCode.NotFound, admin.putJson("/api/v1/people/999999", PersonUpdateRequest(name = name("nf"))).status)
        val id = TestPeople.seed(name("target"))
        assertEquals(
            HttpStatusCode.BadRequest,
            admin.putJson("/api/v1/people/$id", PersonUpdateRequest(name = name("t"), userId = gone)).status,
        )
        assertNull(admin.get("/api/v1/people/$id").body<PersonResponse>().userId, "a rejected update changes nothing")
        assertEquals(HttpStatusCode.NotFound, admin.get("/api/v1/people/999999").status)
        assertEquals(HttpStatusCode.NotFound, admin.delete("/api/v1/people/999999").status)
    }

    @Test
    fun `names are not unique but an active email clash is 409 case-insensitively and a deleted person frees it`() = testApplication {
        usePostgresTestcontainer()
        val admin = seededClient("personemail", UserRole.ADMIN)
        val shared = name("Twin")
        val first = admin.postJson("/api/v1/people", PersonCreateRequest(name = shared)).body<PersonResponse>()
        val twin = admin.postJson("/api/v1/people", PersonCreateRequest(name = shared))
        assertEquals(HttpStatusCode.Created, twin.status, "two real people may share a name")

        val email = uniqueEmail("clash")
        val owner = admin.postJson("/api/v1/people", PersonCreateRequest(name = name("holder"), email = email))
            .body<PersonResponse>()
        val clash = admin.postJson("/api/v1/people", PersonCreateRequest(name = name("clash"), email = email.uppercase()))
        assertEquals(HttpStatusCode.Conflict, clash.status)
        assertTrue(clash.body<ProblemDetail>().detail!!.contains("person with this email"))
        assertEquals(
            HttpStatusCode.Conflict,
            admin.putJson("/api/v1/people/${first.id}", PersonUpdateRequest(name = shared, email = email)).status,
        )
        // A person with no email never clashes with another one.
        assertEquals(HttpStatusCode.Created, admin.postJson("/api/v1/people", PersonCreateRequest(name(" noemail"))).status)

        assertEquals(HttpStatusCode.NoContent, admin.delete("/api/v1/people/${owner.id}").status)
        assertEquals(
            HttpStatusCode.Created,
            admin.postJson("/api/v1/people", PersonCreateRequest(name = name("heir"), email = email)).status,
            "a soft-deleted person frees its email",
        )
    }

    @Test
    fun `a login links to one active person - 409 on a second link and a deleted person frees it`() = testApplication {
        usePostgresTestcontainer()
        val admin = seededClient("personlink", UserRole.ADMIN)
        val loginEmail = uniqueEmail("login")
        val user = TestUsers.seed(email = loginEmail, password = "pw", role = UserRole.USER)

        val linked = admin.postJson("/api/v1/people", PersonCreateRequest(name = name("linked"), userId = user))
            .body<PersonResponse>()
        assertEquals(user, linked.userId)
        assertEquals(loginEmail, linked.userEmail)
        assertEquals(linked.id, TestPeople.service.activePersonIdOf(user))
        val listed = admin.get("/api/v1/people?name=${linked.name}").body<PersonPageResponse>().items.single()
        assertEquals(loginEmail, listed.userEmail)

        val second = admin.postJson("/api/v1/people", PersonCreateRequest(name = name("second"), userId = user))
        assertEquals(HttpStatusCode.Conflict, second.status)
        assertTrue(second.body<ProblemDetail>().detail!!.contains("already linked"))
        val other = TestPeople.seed(name("other"))
        assertEquals(
            HttpStatusCode.Conflict,
            admin.putJson("/api/v1/people/$other", PersonUpdateRequest(name = name("other"), userId = user)).status,
        )

        assertEquals(HttpStatusCode.NoContent, admin.delete("/api/v1/people/${linked.id}").status)
        assertNull(TestPeople.service.activePersonIdOf(user), "a deleted person is nobody's person")
        assertEquals(
            HttpStatusCode.NoContent,
            admin.putJson("/api/v1/people/$other", PersonUpdateRequest(name = name("other"), userId = user)).status,
            "a soft-deleted person frees the login link",
        )
        assertEquals(other, TestPeople.service.activePersonIdOf(user))
    }

    @Test
    fun `a soft-deleted login reads as unlinked and the person stays`() = testApplication {
        usePostgresTestcontainer()
        val admin = seededClient("personlogindel", UserRole.ADMIN)
        val user = seedUser("login-del")
        val id = TestPeople.seed(name("keeps"), userId = user)
        assertEquals(user, admin.get("/api/v1/people/$id").body<PersonResponse>().userId)

        TestUsers.softDelete(user)

        val read = admin.get("/api/v1/people/$id").body<PersonResponse>()
        assertNull(read.userId)
        assertNull(read.userEmail)
        val listed = admin.get("/api/v1/people?name=${read.name}").body<PersonPageResponse>().items.single()
        assertNull(listed.userId)
        assertNull(listed.userEmail)
    }

    @Test
    fun `deleting a person who manages an active team is 409 until the team is reassigned or deleted`() = testApplication {
        usePostgresTestcontainer()
        val admin = seededClient("persondelmgr", UserRole.ADMIN)
        val manager = TestPeople.seed(name("Busy Manager"))
        val team = admin.postJson("/api/v1/teams", TeamCreateRequest(name = name("owned"), managerPersonId = manager))
            .body<TeamResponse>()

        val blocked = admin.delete("/api/v1/people/$manager")
        assertEquals(HttpStatusCode.Conflict, blocked.status)
        assertTrue(blocked.body<ProblemDetail>().detail!!.contains("owner or a team manager"))
        assertEquals(HttpStatusCode.OK, admin.get("/api/v1/people/$manager").status, "a refused delete changes nothing")

        // Reassigned: the person no longer manages anything.
        assertEquals(
            HttpStatusCode.NoContent,
            admin.putJson("/api/v1/teams/${team.id}", TeamUpdateRequest(name = team.name)).status,
        )
        assertEquals(HttpStatusCode.NoContent, admin.delete("/api/v1/people/$manager").status)

        // A DELETED team does not block either.
        val second = TestPeople.seed(name("Idle Manager"))
        val gone = admin.postJson("/api/v1/teams", TeamCreateRequest(name = name("gone"), managerPersonId = second))
            .body<TeamResponse>()
        assertEquals(HttpStatusCode.NoContent, admin.delete("/api/v1/teams/${gone.id}").status)
        assertEquals(HttpStatusCode.NoContent, admin.delete("/api/v1/people/$second").status)
    }

    @Test
    fun `deleting a person who owns an active work stream, program or project is 409 until the node is reassigned or deleted`() =
        testApplication {
            usePostgresTestcontainer()
            val admin = seededClient("persondelowner", UserRole.ADMIN)
            val streamOwner = TestPeople.seed(name("Stream Owner"))
            val programOwner = TestPeople.seed(name("Program Owner"))
            val projectOwner = TestPeople.seed(name("Project Owner"))
            val other = TestPeople.seed(name("Successor"))
            val stream = TestPlan.workStream(streamOwner)
            val program = TestPlan.program(stream, programOwner)
            val project = TestPlan.project(program, projectOwner)

            for ((label, person) in listOf("work stream" to streamOwner, "program" to programOwner, "project" to projectOwner)) {
                val blocked = admin.delete("/api/v1/people/$person")
                assertEquals(HttpStatusCode.Conflict, blocked.status, "the $label owner")
                assertTrue(blocked.body<ProblemDetail>().detail!!.contains("owner or a team manager"))
                assertEquals(HttpStatusCode.OK, admin.get("/api/v1/people/$person").status, "a refused delete changes nothing")
            }
            // Reassigned: the project owner is free; deleting the project frees the next, and so on up the chain.
            assertEquals(
                HttpStatusCode.NoContent,
                admin.putJson("/api/v1/projects/$project", ProjectUpdateRequest(name("renamed"), null, other)).status,
            )
            assertEquals(HttpStatusCode.NoContent, admin.delete("/api/v1/people/$projectOwner").status)
            assertEquals(HttpStatusCode.NoContent, admin.delete("/api/v1/projects/$project").status)
            assertEquals(HttpStatusCode.NoContent, admin.delete("/api/v1/programs/$program").status)
            assertEquals(HttpStatusCode.NoContent, admin.delete("/api/v1/people/$programOwner").status, "a DELETED program does not block")
            assertEquals(HttpStatusCode.NoContent, admin.delete("/api/v1/work-streams/$stream").status)
            assertEquals(HttpStatusCode.NoContent, admin.delete("/api/v1/people/$streamOwner").status)
        }

    @Test
    fun `assigning a manager waits for a concurrent person write and then sees the committed state`() = testApplication {
        usePostgresTestcontainer()
        val admin = seededClient("personrace", UserRole.ADMIN)
        val person = TestPeople.seed(name("Racing Manager"))
        PostgresTestSupport.connect().use { raw ->
            raw.autoCommit = false
            // What PersonService.delete holds while it counts the person's teams.
            raw.prepareStatement("SELECT id FROM people WHERE id = ? FOR NO KEY UPDATE").use { st ->
                st.setInt(1, person.toInt())
                st.executeQuery().close()
            }
            try {
                coroutineScope {
                    val assigning = async {
                        admin.postJson("/api/v1/teams", TeamCreateRequest(name = name("raced"), managerPersonId = person))
                    }
                    awaitLockWait("FOR SHARE")
                    raw.prepareStatement("UPDATE people SET marked_as_deleted = TRUE WHERE id = ?").use { st ->
                        st.setInt(1, person.toInt())
                        st.executeUpdate()
                    }
                    raw.commit()
                    assertEquals(
                        HttpStatusCode.BadRequest,
                        assigning.await().status,
                        "the assignment re-reads the person after the delete committed: no team left on a deleted person",
                    )
                }
            } finally {
                raw.rollback() // a no-op after the commit; releases the lock if an assertion failed first
            }
        }
    }

    @Test
    fun `deleting a person waits for a concurrent team assignment and then answers 409`() = testApplication {
        usePostgresTestcontainer()
        val admin = seededClient("personrace2", UserRole.ADMIN)
        val person = TestPeople.seed(name("Assigned Meanwhile"))
        PostgresTestSupport.connect().use { raw ->
            raw.autoCommit = false
            // What TeamService.create holds before its INSERT: the person row FOR SHARE, then the team row that names it.
            raw.prepareStatement("SELECT id FROM people WHERE id = ? FOR SHARE").use { st ->
                st.setInt(1, person.toInt())
                st.executeQuery().close()
            }
            raw.prepareStatement(
                "INSERT INTO teams (\"name\", created_at, updated_at, manager_person_id) VALUES (?, 1, 1, ?)",
            ).use { st ->
                st.setString(1, name("raced-team"))
                st.setInt(2, person.toInt())
                st.executeUpdate()
            }
            try {
                coroutineScope {
                    val deleting = async { admin.delete("/api/v1/people/$person") }
                    awaitLockWait("FOR NO KEY UPDATE")
                    raw.commit()
                    assertEquals(
                        HttpStatusCode.Conflict,
                        deleting.await().status,
                        "the delete counts the teams after the assignment committed: never an active team on a deleted person",
                    )
                }
            } finally {
                raw.rollback() // a no-op after the commit; releases the locks if an assertion failed first
            }
        }
        assertEquals(HttpStatusCode.OK, admin.get("/api/v1/people/$person").status)
    }

    @Test
    fun `relinking a person transfers the team-manager grant and audits the link change`() = testApplication {
        usePostgresTestcontainer()
        val admin = seededClient("personrelink", UserRole.ADMIN)
        val userA = seedUser("relink-a")
        val userB = seedUser("relink-b")
        val person = TestPeople.seed(name("Relinked"), userId = userA)
        val teamId = admin.postJson("/api/v1/teams", TeamCreateRequest(name = name("relinked-team"), managerPersonId = person))
            .body<TeamResponse>().id
        assertTrue(TestTeams.service.isActiveManager(teamId, userA))
        assertFalse(TestTeams.service.isActiveManager(teamId, userB))

        withAuditCapture { capture ->
            val personName = admin.get("/api/v1/people/$person").body<PersonResponse>().name
            assertEquals(
                HttpStatusCode.NoContent,
                admin.putJson("/api/v1/people/$person", PersonUpdateRequest(name = personName, userId = userB)).status,
            )
            val changed = capture.awaitEvent { it.message == "person.link_changed" && it.hasKeyValue("personId", person.toLong()) }
            assertNotNull(changed)
            assertTrue(changed.hasKeyValue("userFrom", userA.toLong()))
            assertTrue(changed.hasKeyValue("userTo", userB.toLong()))
        }
        assertFalse(TestTeams.service.isActiveManager(teamId, userA), "the old login loses the grant")
        assertTrue(TestTeams.service.isActiveManager(teamId, userB), "the new login holds it")
    }

    @Test
    fun `mutations audit - the link change only on an actual change - and a failed mutation does not`() = testApplication {
        usePostgresTestcontainer()
        val adminEmail = uniqueEmail("person-audit-admin")
        val adminId = TestUsers.seed(email = adminEmail, password = "pw", role = UserRole.ADMIN)
        val admin = authedClient(adminEmail, "pw")
        val user = seedUser("person-audit-login")
        withAuditCapture { capture ->
            val n = name("audited")
            val created = admin.postJson("/api/v1/people", PersonCreateRequest(name = n, userId = user)).body<PersonResponse>()
            val personId = created.id.toLong()
            val event = capture.awaitEvent { it.message == "person.created" && it.hasKeyValue("personId", personId) }
            assertNotNull(event, "create must audit")
            assertTrue(event.hasKeyValue("name", n))
            assertTrue(event.hasKeyValue("userId", user.toLong()))
            assertTrue(event.hasKeyValue("byUserId", adminId.toLong()))

            // The same link again: person.updated fires, person.link_changed does not.
            admin.putJson("/api/v1/people/${created.id}", PersonUpdateRequest(name = n, userId = user))
            assertNotNull(capture.awaitEvent { it.message == "person.updated" && it.hasKeyValue("personId", personId) })

            // A real change (unlink).
            admin.putJson("/api/v1/people/${created.id}", PersonUpdateRequest(name = n))
            val changed = capture.awaitEvent { it.message == "person.link_changed" && it.hasKeyValue("personId", personId) }
            assertNotNull(changed)
            assertTrue(changed.hasKeyValue("byUserId", adminId.toLong()))
            assertTrue(changed.hasKeyValue("userFrom", user.toLong()))
            assertTrue(changed.hasKeyValue("userTo", null))
            assertEquals(
                1,
                capture.events.count { it.message == "person.link_changed" && it.hasKeyValue("personId", personId) },
                "only the actual change is audited",
            )

            admin.delete("/api/v1/people/${created.id}")
            assertNotNull(capture.awaitEvent { it.message == "person.deleted" && it.hasKeyValue("personId", personId) })

            val before = capture.events.count { it.message == "person.created" }
            assertEquals(HttpStatusCode.BadRequest, admin.postJson("/api/v1/people", PersonCreateRequest("")).status)
            assertEquals(before, capture.events.count { it.message == "person.created" }, "failed create must not audit")
        }
    }
}
