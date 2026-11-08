package ch.nokillswit

import ch.nokillswit.infra.outbound.BlockedHostException
import ch.nokillswit.infra.outbound.Origin
import ch.nokillswit.infra.outbound.isAllowedJiraOrigin
import ch.nokillswit.jira.JiraConnectorKey
import ch.nokillswit.jira.JiraHttpClientKey
import io.ktor.client.HttpClient
import io.ktor.client.request.get
import io.ktor.server.testing.testApplication
import kotlinx.coroutines.isActive
import org.junit.BeforeClass
import java.util.UUID
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertFalse
import kotlin.test.assertNotNull
import kotlin.test.assertTrue

/**
 * `configureJira`'s fail-closed boot and its wiring (`jira/Jira.kt`): production refuses a stub, every setting is bound and named in its
 * refusal, the client is closed with the application, and the client the application publishes enforces the origin rule (the
 * transport-level
 * twin of the host allow-list) in development with a stub and in production without one.
 */
class JiraBootTest {
    private val stub = Origin("http", "jira-stub", 8096)

    private fun allowed(scheme: String, host: String, port: Int, devStub: Origin? = null, dev: Boolean = false) =
        isAllowedJiraOrigin(scheme, host, port, devStub, dev)

    @Test
    fun `production refuses a non-blank jira stubBaseUrl at boot`() = testApplication {
        val newPassword = "rotated-${UUID.randomUUID()}"
        configureApp(
            "bootstrap.adminInitialPassword" to newPassword,
            "jwt.secret" to strongJwtSecret(),
            "security.encryption.key" to strongEncryptionKey(),
            "mail.transport" to "disabled",
            "jira.stubBaseUrl" to "http://jira-stub:8096",
        )
        serverConfig { developmentMode = false }
        withSeedRestored {
            assertStartupFails("jira.stubBaseUrl") { startApplication() }
        }
    }

    @Test
    fun `a malformed stubBaseUrl refuses to start in development, naming the key and never the value`() {
        for (bad in listOf(
            "ftp://jira-stub:8096", "jira-stub:8096", "http://user:pass@jira-stub:8096", "http://jira-stub:8096/path",
            "http://jira-stub:8096?x=1", "http://jira-stub:8096#frag", "http:///x", "not a url",
        )) {
            testApplication {
                configureApp("jira.stubBaseUrl" to bad)
                val failure = runCatching { startApplication() }.exceptionOrNull()
                assertNotNull(failure, "must refuse: $bad")
                val messages = generateSequence(failure) { it.cause }.mapNotNull { it.message }.joinToString(" | ")
                assertTrue("jira.stubBaseUrl" in messages, "the key is named: $messages")
                assertFalse("pass" in messages, "the value (it may carry credentials) is never echoed: $messages")
            }
        }
    }

    @Test
    fun `an IPv6, non-canonical or never-admitted IP-literal stubBaseUrl refuses to start, a loopback or private quad boots`() {
        val never = listOf(
            "http://169.254.169.254:80", "http://0.0.0.0:8096", "http://0.250.250.254:8096", "http://224.0.0.1:8096",
            "http://[fe80::1]:8096", "http://[::1]:8096", "http://[fe80::1%25eth0]:8096",
            // Numeric forms the JDK and OkHttp both dial as 169.254.169.254 / 10.0.0.1: only a canonical dotted quad is judged.
            "http://2852039166:8096", "http://0169.254.169.254:8096", "http://010.0.0.1:8096",
        )
        for (bad in never) {
            testApplication {
                configureApp("jira.stubBaseUrl" to bad)
                val failure = runCatching { startApplication() }.exceptionOrNull()
                assertNotNull(failure, "must refuse: $bad")
                val messages = generateSequence(failure) { it.cause }.mapNotNull { it.message }.joinToString(" | ")
                assertTrue("jira.stubBaseUrl" in messages, "the key is named: $messages")
            }
        }
        for (good in listOf("http://127.0.0.1:8096", "http://172.18.0.3:8080", "http://10.0.0.1:8096")) {
            testApplication {
                configureApp("jira.stubBaseUrl" to good)
                startApplication()
                assertNotNull(application.attributes[JiraConnectorKey], "boots with $good")
            }
        }
    }

    @Test
    fun `every setting is bound - an out-of-range or non-numeric value refuses to start naming its key`() {
        val bad = listOf(
            "jira.requestTimeoutSeconds" to "4",
            "jira.requestDeadlineSeconds" to "601",
            "jira.maxResponseBytes" to "1024",
            "jira.maxConcurrentRequests" to "0",
            "jira.maxRetries" to "9",
            "jira.pageSize" to "501",
            "jira.incrementalOverlapMinutes" to "1441",
            "jira.censusHours" to "0",
            "jira.censusHours" to "169",
        )
        for ((key, value) in bad) {
            testApplication {
                configureApp(key to value)
                assertStartupFails(key) { startApplication() }
            }
        }
        testApplication {
            configureApp("jira.pageSize" to "many")
            assertStartupFails("jira.pageSize") { startApplication() }
        }
    }

    @Test
    fun `the defaults boot, and the connector carries the configured page size and overlap`() = testApplication {
        configureApp("jira.pageSize" to "250", "jira.incrementalOverlapMinutes" to "30", "jira.censusHours" to "48")
        startApplication()
        val connector = application.attributes[JiraConnectorKey]
        assertEquals(250, connector.pageSize)
        assertEquals(30L, connector.incrementalOverlapMinutes)
        assertEquals(48, connector.censusHours)
    }

    @Test
    fun `the shared Jira HttpClient is closed on ApplicationStopped`() {
        lateinit var client: HttpClient
        testApplication {
            usePostgresTestcontainer()
            client = application.attributes[JiraHttpClientKey]
            assertTrue(client.isActive, "the client is live while the application runs")
        }
        assertFalse(client.isActive, "the client must be closed once the application has stopped")
    }

    @Test
    fun `https 443 to the gateway or a genuine tenant is allowed, nothing else is`() {
        assertTrue(allowed("https", "api.atlassian.com", 443))
        assertTrue(allowed("https", "acme-corp.atlassian.net", 443))
        assertFalse(allowed("https", "api.atlassian.com", 8443), "another port")
        assertFalse(allowed("http", "api.atlassian.com", 80), "plain http")
        assertFalse(allowed("http", "api.atlassian.com", 443), "http on 443")
        assertFalse(allowed("https", "api.atlassian.net", 443), "a reserved label")
        assertFalse(allowed("https", "evil.example.com", 443))
    }

    @Test
    fun `an IP-literal origin is refused, whatever its address`() {
        for (host in listOf("10.20.1.5", "127.0.0.1", "169.254.169.254", "203.0.113.10", "[::1]", "::1", "2130706433")) {
            assertFalse(allowed("https", host, 443), host)
            assertFalse(allowed("https", host, 443, devStub = stub, dev = true), "$host, even in development")
        }
    }

    @Test
    fun `the stub origin is allowed in development only, and only itself`() {
        assertTrue(allowed("http", "jira-stub", 8096, devStub = stub, dev = true))
        assertTrue(allowed("http", "JIRA-STUB", 8096, devStub = stub, dev = true))
        assertFalse(allowed("http", "jira-stub", 8096, devStub = stub, dev = false), "production never honours the stub")
        assertFalse(allowed("http", "jira-stub", 8097, devStub = stub, dev = true), "another port")
        assertFalse(allowed("https", "jira-stub", 8096, devStub = stub, dev = true), "another scheme")
        assertFalse(allowed("http", "other-host", 8096, devStub = stub, dev = true))
        assertFalse(allowed("http", "jira-stub", 8096, devStub = null, dev = true), "no stub configured")
    }

    @Test
    fun `the client the application publishes refuses an IP-literal, a foreign port, plain http and a Host header`() = testApplication {
        usePostgresTestcontainer()
        val client = application.attributes[JiraHttpClientKey]
        withAuditCapture { audit ->
            for (url in listOf(
                "https://10.20.1.5/rest/api", "https://127.0.0.1/x", "https://169.254.169.254/latest/meta-data/",
                "https://[::1]/x", "https://acme.atlassian.net:8443/x", "http://acme.atlassian.net/x", "https://evil.example.com/x",
            )) {
                assertFailsWith<BlockedHostException>(url) { client.get(url) }
            }
            assertFailsWith<BlockedHostException> {
                client.get("https://api.atlassian.com/x") { headers.append("Host", "evil.example.com") }
            }
            assertEquals(8, audit.events.count { it.message == "outbound.blocked" }, "each refusal is audited")
        }
    }

    @Test
    fun `with a stub configured only the stub's exact origin is reachable on the loopback`() = testApplication {
        val stubUrl = JiraStubFixture.warm()
        configureApp("jira.stubBaseUrl" to stubUrl)
        startApplication()
        val client = application.attributes[JiraHttpClientKey]
        val port = stubUrl.substringAfterLast(':').trimEnd('/').toInt()
        assertEquals(200, client.get("$stubUrl/_edge/tenant_info").status.value)
        for (url in listOf("http://127.0.0.1:$port/_edge/tenant_info", "http://localhost:${port + 1}/x", "https://localhost:$port/x")) {
            assertFailsWith<BlockedHostException>(url) { client.get(url) }
        }
    }

    @Test
    fun `in production no loopback host is reachable, the stub's included`() = testApplication {
        val stubUrl = JiraStubFixture.warm()
        configureApp(
            "bootstrap.adminInitialPassword" to "rotated-${UUID.randomUUID()}",
            "jwt.secret" to strongJwtSecret(),
            "security.encryption.key" to strongEncryptionKey(),
            "mail.transport" to "disabled",
        )
        serverConfig { developmentMode = false }
        withSeedRestored {
            startApplication()
            val client = application.attributes[JiraHttpClientKey]
            assertFailsWith<BlockedHostException> { client.get("$stubUrl/_edge/tenant_info") }
        }
    }

    companion object {
        @JvmStatic
        @BeforeClass
        fun warmStub() {
            JiraStubFixture.warm()
        }
    }
}
