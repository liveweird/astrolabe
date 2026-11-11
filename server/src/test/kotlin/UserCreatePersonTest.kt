package ch.nokillswit

import ch.nokillswit.auth.LoginRequest
import ch.nokillswit.people.PersonCreateRequest
import ch.nokillswit.people.PersonListItem
import ch.nokillswit.people.PersonPageResponse
import ch.nokillswit.people.PersonResponse
import ch.nokillswit.plugins.ProblemDetail
import ch.nokillswit.users.UserCreateRequest
import ch.nokillswit.users.UserPageResponse
import ch.nokillswit.users.UserResponse
import ch.nokillswit.users.UserRole
import io.ktor.client.HttpClient
import io.ktor.client.call.body
import io.ktor.client.request.get
import io.ktor.http.HttpStatusCode
import io.ktor.server.testing.testApplication
import java.util.UUID
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * `POST /users` with `alsoCreatePerson`: the login and its linked person commit together or not at all. People are
 * SHARED suite state - every test mints UNIQUE names and emails.
 */
class UserCreatePersonTest {

    private fun request(email: String, name: String, alsoCreatePerson: Boolean?) = UserCreateRequest(
        name = name,
        email = email,
        password = "initial-pass-123",
        alsoCreatePerson = alsoCreatePerson,
    )

    private fun name(prefix: String) = "$prefix-${UUID.randomUUID().toString().substring(0, 8)}"

    private suspend fun HttpClient.peopleWithEmail(email: String): List<PersonListItem> =
        get("/api/v1/people") { url.parameters.append("email", email) }.body<PersonPageResponse>().items

    private suspend fun HttpClient.usersWithEmail(email: String): List<UserResponse> =
        get("/api/v1/users") { url.parameters.append("email", email) }.body<UserPageResponse>().items

    @Test
    fun `true creates the person with the login's name and email, linked, and answers personId`() = testApplication {
        usePostgresTestcontainer()
        val admin = seededClient("alsoperson-admin", UserRole.ADMIN)
        val email = uniqueEmail("alsoperson")
        val n = name("Linked Owner")

        val response = admin.postJson("/api/v1/users", request(email, n, alsoCreatePerson = true))
        assertEquals(HttpStatusCode.Created, response.status)
        val user = response.body<UserResponse>()
        val personId = assertNotNull(user.personId, "the response names the person it created")

        val person = admin.get("/api/v1/people/$personId").body<PersonResponse>()
        assertEquals(n, person.name)
        assertEquals(email, person.email)
        assertEquals(user.id, person.userId, "linked to the new login")
        assertEquals(email, person.userEmail)
        // The detail and the list carry the linked ACTIVE person's id too.
        assertEquals(personId, admin.get("/api/v1/users/${user.id}").body<UserResponse>().personId)
        assertEquals(personId, admin.usersWithEmail(email).single().personId)
    }

    @Test
    fun `reads answer the linked active person's id, and null for a login without one or with a deleted one`() =
        testApplication {
            usePostgresTestcontainer()
            val admin = seededClient("alsoperson-admin", UserRole.ADMIN)
            val bare = admin.postJson("/api/v1/users", request(uniqueEmail("bare"), name("Bare"), null)).body<UserResponse>()
            val linkedEmail = uniqueEmail("linked")
            val linked = admin.postJson("/api/v1/users", request(linkedEmail, name("Linked"), true)).body<UserResponse>()
            val linkedPerson = assertNotNull(linked.personId)
            // A person linked through the People route (not the switch) counts the same.
            val manualEmail = uniqueEmail("manual")
            val manual = admin.postJson("/api/v1/users", request(manualEmail, name("Manual"), false)).body<UserResponse>()
            val manualPerson = admin.postJson("/api/v1/people", PersonCreateRequest(name("Manual P"), userId = manual.id))
                .body<PersonResponse>().id

            assertNull(admin.get("/api/v1/users/${bare.id}").body<UserResponse>().personId)
            assertEquals(manualPerson, admin.get("/api/v1/users/${manual.id}").body<UserResponse>().personId)
            assertEquals(manualPerson, admin.usersWithEmail(manualEmail).single().personId)
            assertEquals(linkedPerson, admin.usersWithEmail(linkedEmail).single().personId)

            TestPeople.softDelete(linkedPerson)
            assertNull(admin.get("/api/v1/users/${linked.id}").body<UserResponse>().personId, "a deleted person does not count")
            assertNull(admin.usersWithEmail(linkedEmail).single().personId)
        }

    @Test
    fun `false and absent create the login alone`() = testApplication {
        usePostgresTestcontainer()
        val admin = seededClient("alsoperson-admin", UserRole.ADMIN)
        for ((label, flag) in listOf("false" to false, "absent" to null)) {
            val email = uniqueEmail("noperson-$label")
            val user = admin.postJson("/api/v1/users", request(email, name("Login Only"), alsoCreatePerson = flag))
                .also { assertEquals(HttpStatusCode.Created, it.status) }
                .body<UserResponse>()
            assertNull(user.personId, label)
            assertEquals(emptyList(), admin.peopleWithEmail(email), "no person for $label")
            assertNull(admin.usersWithEmail(email).single().personId, label)
        }
    }

    @Test
    fun `a person email clash fails the whole request with the people route's status and creates no login`() =
        testApplication {
            usePostgresTestcontainer()
            val admin = seededClient("alsoperson-admin", UserRole.ADMIN)
            val email = uniqueEmail("clash")
            TestPeople.seed(name("Existing"), email = email)

            // The people route's own answer for the same clash.
            val peopleAnswer = admin.postJson("/api/v1/people", PersonCreateRequest(name("Other"), email = email))
            assertEquals(HttpStatusCode.Conflict, peopleAnswer.status)
            val expected = peopleAnswer.body<ProblemDetail>()

            val response = admin.postJson("/api/v1/users", request(email, name("Clashing"), alsoCreatePerson = true))
            assertEquals(HttpStatusCode.Conflict, response.status)
            val problem = response.body<ProblemDetail>()
            assertEquals(expected.type, problem.type)
            assertEquals(expected.detail, problem.detail)

            assertEquals(emptyList(), admin.usersWithEmail(email), "the login was rolled back")
            assertEquals(
                HttpStatusCode.Unauthorized,
                jsonClient().postJson("/api/v1/login", LoginRequest(email, "initial-pass-123")).status,
            )
            assertEquals(1, admin.peopleWithEmail(email).size, "only the pre-existing person remains")

            // The same email without the switch still creates the login: the clash was the person's alone.
            val loginOnly = admin.postJson("/api/v1/users", request(email, name("Clashing"), alsoCreatePerson = false))
            assertEquals(HttpStatusCode.Created, loginOnly.status)
        }

    @Test
    fun `a duplicate login email is still the user 409 and leaves no person`() = testApplication {
        usePostgresTestcontainer()
        val admin = seededClient("alsoperson-admin", UserRole.ADMIN)
        val email = uniqueEmail("dupuser")
        assertEquals(HttpStatusCode.Created, admin.postJson("/api/v1/users", request(email, name("First"), null)).status)

        val second = admin.postJson("/api/v1/users", request(email, name("Second"), alsoCreatePerson = true))
        assertEquals(HttpStatusCode.Conflict, second.status)
        assertEquals("A user with this email already exists", second.body<ProblemDetail>().detail)
        assertEquals(emptyList(), admin.peopleWithEmail(email), "the person was rolled back with the refused login")
    }

    @Test
    fun `a non-admin is 403 and creates neither the login nor the person`() = testApplication {
        usePostgresTestcontainer()
        val user = seededClient("alsoperson-user")
        val admin = seededClient("alsoperson-admin", UserRole.ADMIN)
        val email = uniqueEmail("denied")

        val response = user.postJson("/api/v1/users", request(email, name("Denied"), alsoCreatePerson = true))
        assertEquals(HttpStatusCode.Forbidden, response.status)
        assertEquals(emptyList(), admin.usersWithEmail(email))
        assertEquals(emptyList(), admin.peopleWithEmail(email))
    }

    @Test
    fun `the create audits user created and person created with the new ids`() = testApplication {
        usePostgresTestcontainer()
        val adminEmail = uniqueEmail("alsoperson-audit-admin")
        val adminId = TestUsers.seed(email = adminEmail, password = "pw", role = UserRole.ADMIN)
        val admin = authedClient(adminEmail, "pw")
        val email = uniqueEmail("audited")
        val n = name("Audited Owner")
        withAuditCapture { capture ->
            val user = admin.postJson("/api/v1/users", request(email, n, alsoCreatePerson = true)).body<UserResponse>()
            val personId = assertNotNull(user.personId).toLong()

            assertNotNull(capture.awaitEvent { it.message == "user.created" && it.hasKeyValue("email", email) })
            val event = capture.awaitEvent { it.message == "person.created" && it.hasKeyValue("personId", personId) }
            assertNotNull(event, "the person creation emits the people route's own event")
            assertTrue(event.hasKeyValue("byUserId", adminId.toLong()))
            assertTrue(event.hasKeyValue("userId", user.id.toLong()))
            assertTrue(event.hasKeyValue("name", n))
        }
    }
}
