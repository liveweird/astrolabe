package ch.nokillswit

import ch.nokillswit.users.Permission
import ch.nokillswit.users.UserPageResponse
import ch.nokillswit.users.UserPermissionsUpdateRequest
import ch.nokillswit.users.UserResponse
import ch.nokillswit.users.UserRole
import io.ktor.client.HttpClient
import io.ktor.client.call.body
import io.ktor.client.request.delete
import io.ktor.client.request.get
import io.ktor.client.request.parameter
import io.ktor.client.request.put
import io.ktor.client.request.setBody
import io.ktor.http.ContentType
import io.ktor.http.HttpStatusCode
import io.ktor.http.contentType
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
 * Per-user permissions (V11) end to end: the `PUT /users/{id}/permissions` matrix (ADMIN-only, wholesale,
 * idempotent), `UserResponse.permissions` on GET and list, the per-request database read behind
 * `UserService.hasPermission` (a grant and a revoke apply at once, nothing rides the token) and the
 * `user.permissions_changed` audit event (only on an actual change).
 */
class UserPermissionsTest {

    private suspend fun HttpClient.setPermissions(userId: UInt, vararg permissions: Permission) =
        putJson("/api/v1/users/$userId/permissions", UserPermissionsUpdateRequest(permissions.toList()))

    private suspend fun HttpClient.permissionsOf(userId: UInt): List<Permission> =
        get("/api/v1/users/$userId").body<UserResponse>().permissions

    @Test
    fun `changing permissions without a token is 401`() = testApplication {
        usePostgresTestcontainer()
        val response = jsonClient().putJson("/api/v1/users/1/permissions", UserPermissionsUpdateRequest(emptyList()))
        assertEquals(HttpStatusCode.Unauthorized, response.status)
    }

    @Test
    fun `a new user holds no permission`() = testApplication {
        usePostgresTestcontainer()
        val admin = seededClient("perm-admin0", role = UserRole.ADMIN)
        val targetId = TestUsers.seed(email = uniqueEmail("perm-fresh"), password = "pw-123456789")
        assertEquals(emptyList(), admin.permissionsOf(targetId))
        assertFalse(TestUsers.service.hasPermission(targetId, Permission.ROADMAP_EDITOR))
    }

    @Test
    fun `admin replaces, reads back and clears a user's granted set - idempotent wholesale PUT`() = testApplication {
        usePostgresTestcontainer()
        val admin = seededClient("perm-admin", role = UserRole.ADMIN)
        val targetId = TestUsers.seed(email = uniqueEmail("perm-target"), password = "pw-123456789")

        assertEquals(HttpStatusCode.NoContent, admin.setPermissions(targetId, Permission.ROADMAP_EDITOR).status)
        assertEquals(listOf(Permission.ROADMAP_EDITOR), admin.permissionsOf(targetId))
        // A repeated name collapses into the set; a same-set re-PUT is 204 again, not a 409 transition.
        assertEquals(
            HttpStatusCode.NoContent,
            admin.setPermissions(targetId, Permission.ROADMAP_EDITOR, Permission.ROADMAP_EDITOR).status,
        )
        assertEquals(listOf(Permission.ROADMAP_EDITOR), admin.permissionsOf(targetId))
        // An empty array revokes everything.
        assertEquals(HttpStatusCode.NoContent, admin.setPermissions(targetId).status)
        assertEquals(emptyList(), admin.permissionsOf(targetId))
    }

    @Test
    fun `the users list carries each user's permissions`() = testApplication {
        usePostgresTestcontainer()
        val admin = seededClient("perm-admin2", role = UserRole.ADMIN)
        val prefix = "PERM-${UUID.randomUUID()}"
        val grantedId = TestUsers.seed(email = uniqueEmail("perm-yes"), password = "pw-123456789", name = "$prefix Yes")
        val plainId = TestUsers.seed(email = uniqueEmail("perm-no"), password = "pw-123456789", name = "$prefix No")
        assertEquals(HttpStatusCode.NoContent, admin.setPermissions(grantedId, Permission.ROADMAP_EDITOR).status)

        val page = admin.get("/api/v1/users") { parameter("name", prefix) }.body<UserPageResponse>()
        assertEquals(
            mapOf(grantedId to listOf(Permission.ROADMAP_EDITOR), plainId to emptyList()),
            page.items.associate { it.id to it.permissions },
        )
    }

    @Test
    fun `changing permissions is ADMIN-only - even for an unknown id or a malformed body - and self-change is allowed`() =
        testApplication {
            usePostgresTestcontainer()
            val adminEmail = uniqueEmail("perm-admin3")
            val adminId = TestUsers.seed(email = adminEmail, password = "pw")
            val admin = authedClient(adminEmail, "pw")
            val plainEmail = uniqueEmail("perm-plain")
            val plainId = TestUsers.seed(email = plainEmail, password = "pw", role = UserRole.USER)
            val plain = authedClient(plainEmail, "pw")

            // A regular user cannot grant themselves anything; the guard runs before the id lookup and the body.
            assertEquals(HttpStatusCode.Forbidden, plain.setPermissions(plainId, Permission.ROADMAP_EDITOR).status)
            assertEquals(HttpStatusCode.Forbidden, plain.setPermissions(999_999_999u, Permission.ROADMAP_EDITOR).status)
            val malformed = plain.put("/api/v1/users/$plainId/permissions") {
                contentType(ContentType.Application.Json)
                setBody("""{"permissions":["WIZARDRY"]}""")
            }
            assertEquals(HttpStatusCode.Forbidden, malformed.status)
            assertFalse(TestUsers.service.hasPermission(plainId, Permission.ROADMAP_EDITOR))

            // The admin's own set may be edited (the features precedent).
            assertEquals(HttpStatusCode.NoContent, admin.setPermissions(adminId, Permission.ROADMAP_EDITOR).status)
            assertEquals(listOf(Permission.ROADMAP_EDITOR), admin.permissionsOf(adminId))
            assertEquals(HttpStatusCode.NoContent, admin.setPermissions(adminId).status)
        }

    @Test
    fun `an unknown or soft-deleted target is 404 and an unknown permission name is 400`() = testApplication {
        usePostgresTestcontainer()
        val admin = seededClient("perm-admin4", role = UserRole.ADMIN)
        assertEquals(HttpStatusCode.NotFound, admin.setPermissions(999_999_999u, Permission.ROADMAP_EDITOR).status)
        val goneId = TestUsers.seed(email = uniqueEmail("perm-gone"), password = "pw-123456789")
        assertEquals(HttpStatusCode.NoContent, admin.delete("/api/v1/users/$goneId").status)
        assertEquals(HttpStatusCode.NotFound, admin.setPermissions(goneId, Permission.ROADMAP_EDITOR).status)

        val targetId = TestUsers.seed(email = uniqueEmail("perm-junk"), password = "pw-123456789")
        val junk = admin.put("/api/v1/users/$targetId/permissions") {
            contentType(ContentType.Application.Json)
            setBody("""{"permissions":["WIZARDRY"]}""")
        }
        assertEquals(HttpStatusCode.BadRequest, junk.status)
        val missing = admin.put("/api/v1/users/$targetId/permissions") {
            contentType(ContentType.Application.Json)
            setBody("{}")
        }
        assertEquals(HttpStatusCode.BadRequest, missing.status)
        assertEquals(emptyList(), admin.permissionsOf(targetId))
    }

    @Test
    fun `a grant and a revoke apply to the very next lookup - nothing rides the token`() = testApplication {
        usePostgresTestcontainer()
        val admin = seededClient("perm-admin5", role = UserRole.ADMIN)
        val email = uniqueEmail("perm-live")
        val userId = TestUsers.seed(email = email, password = "pw-123456789", role = UserRole.USER)
        // The grantee's session predates the grant and is never refreshed.
        val grantee = authedClient(email, "pw-123456789")

        assertFalse(TestUsers.service.hasPermission(userId, Permission.ROADMAP_EDITOR))
        assertEquals(HttpStatusCode.NoContent, admin.setPermissions(userId, Permission.ROADMAP_EDITOR).status)
        assertTrue(TestUsers.service.hasPermission(userId, Permission.ROADMAP_EDITOR))
        // The pre-grant access token still authenticates (the grant is not a claim, so no 401 roles_changed either).
        assertEquals(HttpStatusCode.OK, grantee.get("/api/v1/users/$userId").status)
        assertEquals(listOf(Permission.ROADMAP_EDITOR), grantee.permissionsOf(userId))

        assertEquals(HttpStatusCode.NoContent, admin.setPermissions(userId).status)
        assertFalse(TestUsers.service.hasPermission(userId, Permission.ROADMAP_EDITOR))
        assertEquals(emptyList(), grantee.permissionsOf(userId))
    }

    @Test
    fun `user_permissions_changed is audited with both sets, only on an actual change`() = testApplication {
        usePostgresTestcontainer()
        val adminEmail = uniqueEmail("perm-audit")
        val adminId = TestUsers.seed(email = adminEmail, password = "pw-123456789")
        val admin = authedClient(adminEmail, "pw-123456789")
        val targetId = TestUsers.seed(email = uniqueEmail("perm-audited"), password = "pw-123456789")
        withAuditCapture { capture ->
            fun changes() = capture.events.filter {
                it.message == "user.permissions_changed" && it.hasKeyValue("targetUserId", targetId.toLong())
            }

            assertEquals(HttpStatusCode.NoContent, admin.setPermissions(targetId, Permission.ROADMAP_EDITOR).status)
            val granted = changes().single()
            assertTrue(granted.hasKeyValue("byUserId", adminId.toLong()))
            assertTrue(granted.hasKeyValue("permissionsFrom", ""))
            assertTrue(granted.hasKeyValue("permissionsTo", "ROADMAP_EDITOR"))

            // The same set again is a no-op replace: no second event.
            assertEquals(HttpStatusCode.NoContent, admin.setPermissions(targetId, Permission.ROADMAP_EDITOR).status)
            assertEquals(1, changes().size)

            assertEquals(HttpStatusCode.NoContent, admin.setPermissions(targetId).status)
            val revoked = changes().last()
            assertEquals(2, changes().size)
            assertNotNull(revoked)
            assertTrue(revoked.hasKeyValue("permissionsFrom", "ROADMAP_EDITOR"))
            assertTrue(revoked.hasKeyValue("permissionsTo", ""))
        }
    }

    @Test
    fun `a denied attempt audits authz_denied and changes nothing`() = testApplication {
        usePostgresTestcontainer()
        val plain = seededClient("perm-denied", role = UserRole.USER)
        val targetId = TestUsers.seed(email = uniqueEmail("perm-victim"), password = "pw-123456789")
        withAuditCapture { capture ->
            assertEquals(HttpStatusCode.Forbidden, plain.setPermissions(targetId, Permission.ROADMAP_EDITOR).status)
            assertNotNull(
                capture.awaitEvent { it.message == "authz.denied" && it.hasKeyValue("path", "/api/v1/users/$targetId/permissions") },
            )
            assertTrue(
                capture.events.none { it.message == "user.permissions_changed" && it.hasKeyValue("targetUserId", targetId.toLong()) },
            )
        }
        assertFalse(TestUsers.service.hasPermission(targetId, Permission.ROADMAP_EDITOR))
    }

    @Test
    fun `a PUT waits for a concurrent writer of the same user and then replaces the set it committed`() = testApplication {
        usePostgresTestcontainer()
        val admin = seededClient("perm-race", role = UserRole.ADMIN)
        val targetId = TestUsers.seed(email = uniqueEmail("perm-raced"), password = "pw-123456789")
        withAuditCapture { capture ->
            PostgresTestSupport.connect().use { raw ->
                raw.autoCommit = false
                // What a concurrent replacePermissions holds: the user row FOR NO KEY UPDATE, then its rows.
                raw.prepareStatement("SELECT id FROM users WHERE id = ? FOR NO KEY UPDATE").use { st ->
                    st.setLong(1, targetId.toLong())
                    st.executeQuery().close()
                }
                raw.prepareStatement("INSERT INTO user_permissions (user_id, permission) VALUES (?, 'ROADMAP_EDITOR')").use { st ->
                    st.setLong(1, targetId.toLong())
                    st.executeUpdate()
                }
                try {
                    coroutineScope {
                        val clearing = async { admin.setPermissions(targetId) }
                        awaitLockWait("FOR NO KEY UPDATE")
                        raw.commit()
                        assertEquals(HttpStatusCode.NoContent, clearing.await().status)
                    }
                } finally {
                    raw.rollback() // a no-op after the commit; releases the locks if an assertion failed first
                }
            }
            // Serialized: the PUT saw the committed grant as the set it replaced (unlocked, it would have read "").
            val event = capture.awaitEvent {
                it.message == "user.permissions_changed" && it.hasKeyValue("targetUserId", targetId.toLong())
            }
            assertNotNull(event)
            assertTrue(event.hasKeyValue("permissionsFrom", "ROADMAP_EDITOR"))
            assertTrue(event.hasKeyValue("permissionsTo", ""))
        }
        assertEquals(emptyList(), admin.permissionsOf(targetId))
    }
}
