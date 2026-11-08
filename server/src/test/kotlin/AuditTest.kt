package ch.nokillswit

import ch.nokillswit.auth.LoginRequest
import io.ktor.client.call.body
import ch.nokillswit.users.UserRole
import io.ktor.client.request.delete
import io.ktor.client.request.get
import io.ktor.client.request.post
import io.ktor.client.request.put
import io.ktor.client.request.setBody
import io.ktor.http.ContentType
import io.ktor.http.HttpStatusCode
import io.ktor.http.contentType
import io.ktor.server.testing.testApplication
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNotNull
import kotlin.test.assertTrue

/**
 * The audit trail (audit/Audit.kt): structured SLF4J events on the dedicated
 * `ch.nokillswit.audit` logger, fields as key/values (not message text).
 */
class AuditTest {

    @Test
    fun `successful login emits an audit event with the email as a key-value`() = testApplication {
        usePostgresTestcontainer()
        val email = uniqueEmail("audited")
        TestUsers.seed(email = email, password = "pw")
        withAuditCapture { capture ->
            jsonClient().postJson("/api/v1/login", LoginRequest(email, "pw"))
            val event = capture.awaitEvent { it.message == "login.success" && it.hasKeyValue("email", email) }
            assertNotNull(event, "expected a login.success audit event for $email")
        }
    }

    @Test
    fun `user management mutations emit audit events with deltas`() = testApplication {
        usePostgresTestcontainer()
        val adminEmail = uniqueEmail("useraudit")
        val adminId = TestUsers.seed(email = adminEmail, password = "pw-123456789")
        withAuditCapture { capture ->
            val client = authedClient(adminEmail, "pw-123456789")
            val email = uniqueEmail("audited-user")
            val created = client.post("/api/v1/users") {
                contentType(ContentType.Application.Json)
                setBody(
                    ch.nokillswit.users.UserCreateRequest(
                        name = "Audited One",
                        email = email,
                        password = "initial-pass-123",
                    ),
                )
            }.body<ch.nokillswit.users.UserResponse>()
            client.put("/api/v1/users/${created.id}") {
                contentType(ContentType.Application.Json)
                setBody(
                    ch.nokillswit.users.UserUpdateRequest(
                        name = "Audited Two",
                        email = email,
                        roles = listOf(ch.nokillswit.users.UserRole.ADMIN),
                    ),
                )
            }
            // A route-created user starts with the inverted-default MFA row — clearing it
            // (enabling MFA) is the actual change that must be audited.
            client.put("/api/v1/users/${created.id}/features") {
                contentType(ContentType.Application.Json)
                setBody(ch.nokillswit.users.UserFeaturesUpdateRequest(emptyList()))
            }
            client.delete("/api/v1/users/${created.id}")


            val createdEvent = capture.awaitEvent {
                it.message == "user.created" && it.hasKeyValue("email", email)
            }
            assertNotNull(createdEvent)
            assertTrue(createdEvent.hasKeyValue("byUserId", adminId.toLong()))
            val updatedEvent = capture.awaitEvent {
                it.message == "user.updated" && it.hasKeyValue("targetUserId", created.id.toLong())
            }
            assertNotNull(updatedEvent)
            assertTrue(updatedEvent.hasKeyValue("nameFrom", "Audited One"))
            assertTrue(updatedEvent.hasKeyValue("nameTo", "Audited Two"))
            val rolesEvent = capture.awaitEvent {
                it.message == "user.roles_changed" && it.hasKeyValue("targetUserId", created.id.toLong())
            }
            assertNotNull(rolesEvent)
            assertTrue(rolesEvent.hasKeyValue("rolesFrom", ""))
            assertTrue(rolesEvent.hasKeyValue("rolesTo", "ADMIN"))
            val featuresEvent = capture.awaitEvent {
                it.message == "user.features_changed" && it.hasKeyValue("targetUserId", created.id.toLong())
            }
            assertNotNull(featuresEvent)
            assertTrue(featuresEvent.hasKeyValue("featuresFrom", "MFA"))
            assertTrue(featuresEvent.hasKeyValue("featuresTo", ""))
            assertNotNull(
                capture.awaitEvent {
                    it.message == "user.deleted" && it.hasKeyValue("targetUserId", created.id.toLong())
                },
            )
        }
    }

    @Test
    fun `failed login emits an audit event carrying the failure reason`() = testApplication {
        usePostgresTestcontainer()
        val email = uniqueEmail("failaudit")
        TestUsers.seed(email = email, password = "right-pw")
        withAuditCapture { capture ->
            jsonClient().postJson("/api/v1/login", LoginRequest(email, "wrong-pw"))
            val event = capture.awaitEvent { it.message == "login.failure" && it.hasKeyValue("email", email) }
            assertNotNull(event, "expected a login.failure audit event for $email")
            assertTrue(event.hasKeyValue("reason", "wrong_password"))
        }
    }

    @Test
    fun `a denial audit carries the path without the query string`() = testApplication {
        usePostgresTestcontainer()
        val client = seededClient("denied-audit")
        withAuditCapture { capture ->
            val response = client.post("/api/v1/teams?leak=must-not-be-audited") {
                contentType(ContentType.Application.Json)
                setBody("{}")
            }
            assertEquals(HttpStatusCode.Forbidden, response.status)
            val event = capture.awaitEvent { it.message == "authz.denied" && it.hasKeyValue("path", "/api/v1/teams") }
            assertNotNull(event, "authz.denied carries the bare path (observability.md promises `path`)")
            assertTrue(event.keyValuePairs.none { "must-not-be-audited" in it.value.toString() })
        }
    }

    @Test
    fun `the Flow connection events carry the name and host but never the token, and a denial carries the bare path`() = testApplication {
        configureApp("flow.insecureOrigins" to FLOW_TEST_ORIGIN)
        startApplication()
        val adminEmail = uniqueEmail("flowaudit")
        val adminId = TestUsers.seed(email = adminEmail, password = "pw")
        val admin = authedClient(adminEmail, "pw")
        val user = seededClient("flowaudit-user")
        val token = flowToken('u')
        val flowName = flowUnique("flow-audit")
        try {
            withAuditCapture { capture ->
                val base = "/api/v1/integrations/flow/connections"
                val created = admin.postJson(base, flowRequest(name = flowName, token = token))
                    .body<ch.nokillswit.flow.FlowConnectionResponse>()
                val createdEvent = assertNotNull(capture.awaitEvent { it.message == "flow.connection_created" })
                val host = FLOW_TEST_ORIGIN.substringAfter("://")
                assertTrue(
                    listOf("byUserId" to adminId.toLong(), "connectionId" to created.id.toLong(), "name" to flowName, "host" to host)
                        .all { (key, value) -> createdEvent.hasKeyValue(key, value) },
                    "${createdEvent.keyValuePairs}",
                )
                admin.putJson("$base/${created.id}", flowRequest(name = flowName, token = null))
                assertNotNull(capture.awaitEvent { it.message == "flow.connection_updated" && it.hasKeyValue("tokenRotated", false) })
                assertEquals(HttpStatusCode.Forbidden, user.get("$base/${created.id}?leak=must-not-be-audited").status)
                val denied = capture.awaitEvent { it.message == "authz.denied" && it.hasKeyValue("path", "$base/${created.id}") }
                assertNotNull(denied, "the denial carries the bare path")
                assertEquals(HttpStatusCode.NoContent, admin.delete("$base/${created.id}").status)
                val deleted = assertNotNull(capture.awaitEvent { it.message == "flow.connection_deleted" })
                assertTrue(deleted.hasKeyValue("bindingsUnbound", 0) && deleted.hasKeyValue("runsDeleted", 0))
                assertTrue(
                    capture.events.none { event -> token in event.formattedMessage || event.keyValuePairs.any { token in "${it.value}" } },
                    "no event carries the token",
                )
                assertTrue(capture.events.none { event -> event.keyValuePairs.any { "must-not-be-audited" in "${it.value}" } })
            }
        } finally {
            removeFlowFixtureRows("flow-audit")
        }
    }
}
