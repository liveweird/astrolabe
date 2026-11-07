package ch.nokillswit

import io.ktor.client.request.get
import io.ktor.client.request.header
import io.ktor.http.HttpHeaders
import io.ktor.http.HttpStatusCode
import io.ktor.server.netty.EngineMain
import io.ktor.server.testing.ApplicationTestBuilder
import io.ktor.server.testing.testApplication
import java.io.BufferedReader
import java.io.InputStreamReader
import java.net.Socket
import java.util.UUID
import kotlinx.coroutines.runBlocking
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNotNull
import kotlin.test.assertTrue

/**
 * Production-mode proxy-header hardening (plugins/Http.kt), behind `http.behindProxy` (ported
 * from Toadie's ProductionHttpTest): only the canonical X-Forwarded-Host/X-Forwarded-Proto may
 * steer the HTTPS redirect — the alias headers Ktor trusts by default (X-Forwarded-Server,
 * X-Forwarded-SSL) must not, since a proxy that sets just the canonical ones passes them through
 * from the client untouched (security.md's "Reverse proxy" paragraph). Also covers the
 * fewer-hops-than-configured X-Forwarded-For fallback and the X-Forwarded-Port safety fix
 * (ForwardedHeadersTest/RawForwardedForLinesTest cover the rate-limit key itself).
 */
class ProductionHttpTest {

    private suspend fun ApplicationTestBuilder.bootProductionBehindProxy() {
        configureApp(
            "bootstrap.adminInitialPassword" to "rotated-${UUID.randomUUID()}",
            "jwt.secret" to strongJwtSecret(),
            "security.encryption.key" to strongEncryptionKey(),
            "mail.transport" to "disabled",
            "http.behindProxy" to "true",
        )
        serverConfig { developmentMode = false }
        startApplication()
    }

    @Test
    fun `X-Forwarded-Server does not steer the redirect target, and X-Forwarded-SSL does not suppress it`() =
        testApplication {
            withSeedRestored {
                bootProductionBehindProxy()
                val client = createClient { followRedirects = false }

                val spoofed = client.get("/api/v1/health") {
                    header("X-Forwarded-Server", "evil.example")
                }
                assertEquals(HttpStatusCode.MovedPermanently, spoofed.status)
                val location = assertNotNull(spoofed.headers[HttpHeaders.Location])
                assertFalse("evil.example" in location, "X-Forwarded-Server must not steer the redirect: $location")

                val sslSpoofed = client.get("/api/v1/health") {
                    header("X-Forwarded-SSL", "on")
                }
                assertEquals(
                    HttpStatusCode.MovedPermanently,
                    sslSpoofed.status,
                    "X-Forwarded-SSL must not mark an otherwise-plain request as already secure",
                )
            }
        }

    @Test
    fun `fewer X-Forwarded-For hops than proxyHops falls back safely, never 500s`() = testApplication {
        withSeedRestored {
            configureApp(
                "bootstrap.adminInitialPassword" to "rotated-${UUID.randomUUID()}",
                "jwt.secret" to strongJwtSecret(),
                "security.encryption.key" to strongEncryptionKey(),
                "mail.transport" to "disabled",
                "http.behindProxy" to "true",
                "http.proxyHops" to "3",
            )
            serverConfig { developmentMode = false }
            startApplication()
            val client = createClient { followRedirects = false }
            // Only ONE hop present though proxyHops=3 is configured — resolveForwardedForOrigin
            // must fall back to the last available value rather than indexing out of bounds.
            val response = client.get("/api/v1/health") {
                header(HttpHeaders.XForwardedFor, "203.0.113.5")
                header(HttpHeaders.XForwardedProto, "https")
            }
            assertEquals(HttpStatusCode.OK, response.status)
        }
    }

    @Test
    fun `a non-numeric X-Forwarded-Port never 500s`() = testApplication {
        withSeedRestored {
            configureApp(
                "bootstrap.adminInitialPassword" to "rotated-${UUID.randomUUID()}",
                "jwt.secret" to strongJwtSecret(),
                "security.encryption.key" to strongEncryptionKey(),
                "mail.transport" to "disabled",
                "http.behindProxy" to "true",
            )
            serverConfig { developmentMode = false }
            startApplication()
            val client = createClient { followRedirects = false }
            val response = client.get("/api/v1/health") {
                header(HttpHeaders.XForwardedProto, "https")
                header("X-Forwarded-Port", "not-a-number")
            }
            assertEquals(HttpStatusCode.OK, response.status)
        }
    }

    // The HTTPS redirect (installed before configureSecurityHeaders) completes the call; the security-headers
    // interceptor used to run on that committed response and throw UnsupportedOperationException ("Headers can no longer
    // be set because response was already completed"), logged as "Unhandled exception while processing ..." on EVERY
    // plain-HTTP request (load-balancer port-80 traffic). testApplication's engine does not enforce header commit, so this
    // runs against the REAL Netty engine (like RawForwardedForLinesTest), over a raw socket.
    @Test
    fun `a plain-HTTP request is redirected to https without logging an unhandled exception`() {
        val server = EngineMain.createServer(
            arrayOf(
                "-port=0",
                "-P:ktor.development=false",
                "-P:postgres.jdbcUrl=${PostgresTestSupport.jdbcUrl}",
                "-P:postgres.r2dbcUrl=${PostgresTestSupport.r2dbcUrl}",
                "-P:postgres.user=${PostgresTestSupport.user}",
                "-P:postgres.password=${PostgresTestSupport.password}",
                "-P:security.csrf.enabled=false",
                "-P:telemetry.enabled=false",
                "-P:sync.scheduler.enabled=false",
                "-P:bootstrap.adminInitialPassword=rotated-${UUID.randomUUID()}",
                "-P:jwt.secret=${strongJwtSecret()}",
                "-P:security.encryption.key=${strongEncryptionKey()}",
                "-P:mail.transport=disabled",
            ),
        )
        val log = LogCapture(org.slf4j.Logger.ROOT_LOGGER_NAME)
        try {
            server.start(wait = false)
            val port = runBlocking { server.engine.resolvedConnectors().first().port }

            val health = rawRequest(port, "GET", "/api/v1/health")
            val login = rawRequest(port, "POST", "/api/v1/login", """{"email":"nobody@example.test","password":"x"}""")
            for (response in listOf(health, login)) {
                assertEquals(301, response.status)
                assertTrue(response.location?.startsWith("https://") == true, "redirect must target https: ${response.location}")
            }
            // The failure surfaced AFTER the client already had its 301 (the pipeline continues past the response),
            // so give a late log line a moment to land before asserting its absence.
            Thread.sleep(500)
            val offending = log.events.filter {
                it.formattedMessage.contains("Unhandled exception") ||
                    it.throwableProxy?.className == UnsupportedOperationException::class.java.name
            }
            assertTrue(offending.isEmpty(), "no unhandled exception may be logged: ${offending.map { it.formattedMessage }}")
        } finally {
            log.detach()
            server.stop(gracePeriodMillis = 100, timeoutMillis = 1_000)
            runBlocking { TestSeedState.restoreSeedAccounts() }
        }
    }

    private class RawResponse(val status: Int, val location: String?)

    /** One plain-HTTP/1.1 exchange over a raw socket: no X-Forwarded-Proto, so the request is as a port-80 hit. */
    private fun rawRequest(port: Int, method: String, path: String, body: String? = null): RawResponse =
        Socket("127.0.0.1", port).use { socket ->
            val bytes = body?.toByteArray()
            val request = buildString {
                append("$method $path HTTP/1.1\r\n")
                append("Host: 127.0.0.1:$port\r\n")
                if (bytes != null) {
                    append("Content-Type: application/json\r\n")
                    append("Content-Length: ${bytes.size}\r\n")
                }
                append("Connection: close\r\n\r\n")
                if (body != null) append(body)
            }
            socket.soTimeout = 10_000
            socket.getOutputStream().write(request.toByteArray(Charsets.US_ASCII))
            socket.getOutputStream().flush()
            val reader = BufferedReader(InputStreamReader(socket.getInputStream()))
            val status = (reader.readLine() ?: error("no response from the server")).split(" ")[1].toInt()
            val headers = generateSequence { reader.readLine() }.takeWhile { it.isNotEmpty() }.toList()
            RawResponse(status, headers.firstOrNull { it.startsWith("Location:", ignoreCase = true) }?.substringAfter(':')?.trim())
        }
}
