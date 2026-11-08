package ch.nokillswit

import ch.nokillswit.flow.FlowConnectionServiceKey
import ch.nokillswit.flow.FlowConnectorKey
import ch.nokillswit.flow.FlowHttpClientKey
import ch.nokillswit.flow.FlowOriginsKey
import ch.nokillswit.infra.fetch.FetchException
import ch.nokillswit.infra.outbound.BlockedHostException
import io.ktor.client.HttpClient
import io.ktor.client.request.get
import io.ktor.client.request.header
import io.ktor.http.HttpHeaders
import io.ktor.server.plugins.BadRequestException
import io.ktor.server.testing.testApplication
import kotlinx.coroutines.isActive
import org.junit.BeforeClass
import java.util.UUID
import kotlin.test.AfterTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertFalse
import kotlin.test.assertNotNull
import kotlin.test.assertTrue

/**
 * `configureFlow`'s fail-closed boot and its wiring (`flow/Flow.kt`): production refuses an insecure origin, every setting is bound and
 * named in its refusal (never the value), the client is closed with the application, the client the application publishes enforces the
 * operator's origin rule (a listed TLS host, the development stub's exact origin, nothing else), and the registry judges a connection's
 * base URL by that same rule.
 */
class FlowBootTest {
    @AfterTest
    fun cleanUp() {
        removeFlowFixtureRows(PREFIX)
    }

    private fun messagesOf(failure: Throwable): String =
        generateSequence(failure) { it.cause }.mapNotNull { it.message }.joinToString(" | ")

    private fun productionOverrides() = arrayOf(
        "bootstrap.adminInitialPassword" to "rotated-${UUID.randomUUID()}",
        "jwt.secret" to strongJwtSecret(),
        "security.encryption.key" to strongEncryptionKey(),
        "mail.transport" to "disabled",
    )

    // --- fail-closed boot ---

    @Test
    fun `production refuses a non-blank flow insecureOrigins at boot, naming the key and never the value`() = testApplication {
        configureApp(*productionOverrides(), "flow.insecureOrigins" to "http://flow-stub:8080")
        serverConfig { developmentMode = false }
        withSeedRestored {
            val failure = runCatching { startApplication() }.exceptionOrNull()
            assertNotNull(failure, "must refuse")
            val messages = messagesOf(failure)
            assertTrue("flow.insecureOrigins" in messages, messages)
            assertFalse("flow-stub" in messages, "the value is never echoed: $messages")
        }
    }

    @Test
    fun `production boots with a TLS host list and no insecure origin`() = testApplication {
        configureApp(*productionOverrides(), "flow.allowedHosts" to "flow.corp.example", "flow.allowedCidrs" to "10.20.0.0/16")
        serverConfig { developmentMode = false }
        withSeedRestored {
            startApplication()
            val origins = application.attributes[FlowOriginsKey]
            assertTrue(origins.baseUrlAllowed("https://flow.corp.example"))
            assertFalse(origins.baseUrlAllowed("http://flow-stub:8080"))
        }
    }

    @Test
    fun `a malformed list refuses to start in development, naming the key and never the value`() {
        val bad = listOf(
            "flow.insecureOrigins" to "http://user:s3cret-pw@flow-stub:8080",
            "flow.insecureOrigins" to "https://flow-stub:8080",
            "flow.insecureOrigins" to "http://flow-stub:8080/path",
            "flow.insecureOrigins" to "http://10.0.0.5:8080",
            "flow.allowedHosts" to "https://flow.corp.example",
            "flow.allowedHosts" to "user:s3cret-pw@flow.corp.example",
            "flow.allowedHosts" to "10.0.0.5",
            "flow.allowedHosts" to "*.corp.example",
            "flow.allowedCidrs" to "10.20.0.0/16", // CIDRs without a listed host
        )
        for ((key, value) in bad) {
            testApplication {
                configureApp(key to value)
                val failure = runCatching { startApplication() }.exceptionOrNull()
                assertNotNull(failure, "must refuse: $key")
                val messages = messagesOf(failure)
                assertTrue(key in messages, "the key is named: $messages")
                assertFalse("s3cret-pw" in messages, "the value (it may carry credentials) is never echoed: $messages")
            }
        }
    }

    @Test
    fun `a CIDR over a forbidden range, and an unreadable CA bundle, refuse to start`() {
        testApplication {
            configureApp("flow.allowedHosts" to "flow.corp.example", "flow.allowedCidrs" to "127.0.0.0/8")
            assertStartupFails("flow.allowedCidrs") { startApplication() }
        }
        testApplication {
            configureApp("flow.allowedHosts" to "flow.corp.example", "flow.caBundle" to "/nonexistent/ca-bundle.pem")
            assertStartupFails("flow.caBundle") { startApplication() }
        }
    }

    @Test
    fun `every setting is bound - an out-of-range or non-numeric value refuses to start naming its key`() {
        val bad = listOf(
            "flow.requestTimeoutSeconds" to "4", "flow.requestTimeoutSeconds" to "121",
            "flow.requestDeadlineSeconds" to "9", "flow.requestDeadlineSeconds" to "601",
            "flow.maxResponseBytes" to "1024", "flow.maxResponseBytes" to "1048577",
            "flow.maxConcurrentRequests" to "0", "flow.maxConcurrentRequests" to "3",
            "flow.maxRetries" to "-1", "flow.maxRetries" to "9",
            "flow.sprintsSinceDays" to "29", "flow.sprintsSinceDays" to "1096",
        )
        for ((key, value) in bad) {
            testApplication {
                configureApp(key to value)
                assertStartupFails("Config \"$key\"") { startApplication() }
            }
        }
        testApplication {
            configureApp("flow.maxRetries" to "many")
            assertStartupFails("flow.maxRetries") { startApplication() }
        }
    }

    // --- the wiring ---

    @Test
    fun `the defaults boot with nothing reachable, and the connector carries the configured window`() = testApplication {
        configureApp("flow.sprintsSinceDays" to "90")
        startApplication()
        assertEquals(90, application.attributes[FlowConnectorKey].sprintsSinceDays)
        val origins = application.attributes[FlowOriginsKey]
        assertFalse(origins.hostAllowed("flow-stub"), "nothing is listed by default")
        assertFalse(origins.baseUrlAllowed("http://flow-stub:8080"))
    }

    @Test
    fun `the shared Flow HttpClient is closed on ApplicationStopped`() {
        lateinit var client: HttpClient
        testApplication {
            usePostgresTestcontainer()
            client = application.attributes[FlowHttpClientKey]
            assertTrue(client.isActive, "the client is live while the application runs")
        }
        assertFalse(client.isActive, "the client must be closed once the application has stopped")
    }

    @Test
    fun `the client the application publishes refuses an IP-literal, a foreign port, plain http and a Host header`() = testApplication {
        configureApp("flow.allowedHosts" to "flow.corp.example")
        startApplication()
        val client = application.attributes[FlowHttpClientKey]
        withAuditCapture { audit ->
            for (url in listOf(
                "https://10.20.1.5/api/v1/integration/me", "https://127.0.0.1/x", "https://169.254.169.254/latest/meta-data/",
                "https://[::1]/x", "https://flow.corp.example:8443/x", "http://flow.corp.example/x", "https://evil.example.com/x",
            )) {
                assertFailsWith<BlockedHostException>(url) { client.get(url) }
            }
            assertFailsWith<BlockedHostException> {
                client.get("https://flow.corp.example/x") { headers.append("Host", "evil.example.com") }
            }
            assertEquals(8, audit.events.count { it.message == "outbound.blocked" }, "each refusal is audited")
        }
    }

    @Test
    fun `with the stub listed only its exact origin is reachable on the loopback`() = testApplication {
        val stubUrl = FlowStubFixture.warm()
        configureApp("flow.insecureOrigins" to stubUrl)
        startApplication()
        val client = application.attributes[FlowHttpClientKey]
        val port = stubUrl.substringAfterLast(':').trimEnd('/').toInt()
        val answer = client.get("$stubUrl${FlowStubServer.mePath}") { header(HttpHeaders.Authorization, FlowStubServer.authorization) }
        assertEquals(200, answer.status.value)
        for (url in listOf("http://127.0.0.1:$port/x", "http://localhost:${port + 1}/x", "https://localhost:$port/x")) {
            assertFailsWith<BlockedHostException>(url) { client.get(url) }
        }
    }

    @Test
    fun `in production no loopback host is reachable, the stub's included, even when listed as a TLS host`() = testApplication {
        val stubUrl = FlowStubFixture.warm()
        val port = stubUrl.substringAfterLast(':').trimEnd('/').toInt()
        configureApp(*productionOverrides(), "flow.allowedHosts" to "localhost:$port")
        serverConfig { developmentMode = false }
        withSeedRestored {
            startApplication()
            val client = application.attributes[FlowHttpClientKey]
            assertFailsWith<BlockedHostException>("plain http to the stub") { client.get("$stubUrl${FlowStubServer.mePath}") }
            assertFailsWith<BlockedHostException>("a listed host that resolves to loopback") { client.get("https://localhost:$port/x") }
        }
    }

    @Test
    fun `the registry judges a base URL by the operator's list - listed is accepted, anything else is a 400`() = testApplication {
        configureApp("flow.insecureOrigins" to "http://flow-wired.test:8080", "flow.allowedHosts" to "flow.corp.example")
        startApplication()
        val service = application.attributes[FlowConnectionServiceKey]
        for (url in listOf("http://flow-wired.test:8080", "https://flow.corp.example")) {
            assertTrue(service.create(flowRequest(name = flowUnique(PREFIX)).copy(baseUrl = url)) > 0u, url)
        }
        for (url in listOf("http://flow-wired.test:8081", "https://flow-wired.test:8080", "https://evil.example", FLOW_TEST_ORIGIN)) {
            assertFailsWith<BadRequestException>(url) { service.create(flowRequest(name = flowUnique(PREFIX)).copy(baseUrl = url)) }
        }
        val canonical = assertFailsWith<BadRequestException> {
            service.create(flowRequest(name = flowUnique(PREFIX)).copy(baseUrl = "HTTPS://FLOW.corp.example:443"))
        }
        assertTrue("lowercase origin without the default port" in canonical.message.orEmpty(), canonical.message)
    }

    @Test
    fun `the connector's transport is the guarded client - the listed stub answers, a loopback literal is BLOCKED_HOST, one audit`() =
        testApplication {
            val stubUrl = FlowStubFixture.warm()
            configureApp("flow.insecureOrigins" to stubUrl)
            startApplication()
            val connector = application.attributes[FlowConnectorKey]
            val port = stubUrl.substringAfterLast(':').trimEnd('/').toInt()
            assertEquals("astrolabe", connector.client(stubUrl, FlowStubServer.token).me().name)
            withAuditCapture { audit ->
                val error = assertFailsWith<FetchException> { connector.client("http://127.0.0.1:$port", FlowStubServer.token).me() }
                assertEquals("BLOCKED_HOST", error.code)
                // The default flow.maxRetries is 2: a refusal is never retried, so it is audited once.
                assertEquals(1, audit.events.count { it.message == "outbound.blocked" }, "exactly one audit, no retry")
            }
        }

    @Test
    fun `a stored base URL delisted by a later config change is BLOCKED_HOST through the connector, with one audit`() {
        val delisted = "http://flow-delisted.test:8080"
        var id: UInt? = null
        testApplication {
            configureApp("flow.insecureOrigins" to delisted)
            startApplication()
            id = application.attributes[FlowConnectionServiceKey].create(flowRequest(name = flowUnique(PREFIX)).copy(baseUrl = delisted))
        }
        testApplication {
            configureApp("flow.insecureOrigins" to "http://flow-other.test:8080")
            startApplication()
            val target = assertNotNull(application.attributes[FlowConnectionServiceKey].readForRun(assertNotNull(id)))
            assertEquals(delisted, target.baseUrl, "the row still names the origin that was listed when it was written")
            val connector = application.attributes[FlowConnectorKey]
            withAuditCapture { audit ->
                val error = assertFailsWith<FetchException> { connector.client(target.baseUrl, assertNotNull(target.apiToken)).me() }
                assertEquals("BLOCKED_HOST", error.code, "refused by the host check, before any DNS lookup")
                assertEquals(1, audit.events.count { it.message == "outbound.blocked" }, "exactly one audit despite flow.maxRetries = 2")
            }
        }
    }

    companion object {
        private const val PREFIX = "flow-boot"

        @JvmStatic
        @BeforeClass
        fun warmStub() {
            FlowStubFixture.warm()
        }
    }
}
