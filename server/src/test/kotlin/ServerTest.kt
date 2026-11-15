package ch.nokillswit

import io.ktor.client.request.get
import io.ktor.client.request.options
import io.ktor.client.request.header
import io.ktor.client.request.post
import io.ktor.client.call.body
import ch.nokillswit.plugins.ProblemDetail
import io.ktor.client.statement.bodyAsText
import io.ktor.http.HttpHeaders
import io.ktor.http.HttpStatusCode
import io.ktor.server.testing.testApplication
import java.nio.file.Files
import java.util.UUID
import kotlin.io.path.writeText
import kotlin.test.*

class ServerTest {

    @Test
    fun `unauthenticated API request returns a 401 problem+json body`() = testApplication {
        usePostgresTestcontainer()
        val response = jsonClient().post("/api/v1/logout?secret=must-not-be-reflected")
        assertEquals(HttpStatusCode.Unauthorized, response.status)
        assertTrue(
            response.headers["Content-Type"]?.startsWith("application/problem+json") == true,
            "401 challenge must be RFC 7807 problem+json",
        )
        assertContains(response.bodyAsText(), "\"status\":401")
        assertEquals("/api/v1/logout", response.body<ProblemDetail>().instance)
        assertFalse(response.bodyAsText().contains("must-not-be-reflected"))
    }

    @Test
    fun `security headers are set on responses`() = testApplication {
        usePostgresTestcontainer()
        val response = jsonClient().post("/api/v1/logout")
        assertEquals("nosniff", response.headers["X-Content-Type-Options"])
        assertEquals("DENY", response.headers["X-Frame-Options"])
        assertEquals("no-referrer", response.headers["Referrer-Policy"])
        val csp = response.headers["Content-Security-Policy"]
        assertNotNull(csp, "Content-Security-Policy header should be present")
        // Pinned EXACTLY: a loosened directive (script-src, connect-src, …) must be a deliberate test edit.
        assertEquals(FULL_CSP, csp)
        assertEquals(PERMISSIONS_POLICY, response.headers["Permissions-Policy"])
        // HSTS is production-only: a plain-HTTP development answer must not carry it.
        assertNull(response.headers["Strict-Transport-Security"])
    }

    @Test
    fun `production mode answers over https with HSTS and the full hardening set`() = testApplication {
        withSeedRestored {
            configureApp(
                "bootstrap.adminInitialPassword" to "rotated-${UUID.randomUUID()}",
                "jwt.secret" to strongJwtSecret(),
                "security.encryption.key" to strongEncryptionKey(),
                "mail.transport" to "disabled",
                // The TLS-terminating proxy's header: without it production answers a 301 to https instead.
                "http.behindProxy" to "true",
            )
            serverConfig { developmentMode = false }
            startApplication()
            val response = createClient { followRedirects = false }.get("/api/v1/health") {
                header(HttpHeaders.XForwardedProto, "https")
            }
            assertEquals(HttpStatusCode.OK, response.status)
            // Ktor's HSTS default max-age is one year; includeSubDomains is configured in plugins/Http.kt.
            assertEquals("max-age=31536000; includeSubDomains", response.headers[HttpHeaders.StrictTransportSecurity])
            assertEquals(PERMISSIONS_POLICY, response.headers["Permissions-Policy"])
            assertEquals(FULL_CSP, response.headers["Content-Security-Policy"])
            assertEquals("nosniff", response.headers["X-Content-Type-Options"])
        }
    }

    @Test
    fun `the Server header does not disclose the framework or its version`() = testApplication {
        usePostgresTestcontainer()
        val server = jsonClient().get("/api/v1/health").headers[HttpHeaders.Server]
        assertEquals("astrolabe", server)
        assertFalse(server.orEmpty().contains("Ktor", ignoreCase = true), "no framework/version in Server")
    }

    @Test
    fun `API JSON and problem+json responses are no-store`() = testApplication {
        usePostgresTestcontainer()
        val ok = jsonClient().get("/api/v1/health")
        assertEquals(HttpStatusCode.OK, ok.status)
        assertEquals("no-store", ok.headers[HttpHeaders.CacheControl], "a 200 application/json API answer")
        val problem = jsonClient().post("/api/v1/logout")
        assertEquals(HttpStatusCode.Unauthorized, problem.status)
        assertTrue(problem.headers["Content-Type"]?.startsWith("application/problem+json") == true)
        assertEquals("no-store", problem.headers[HttpHeaders.CacheControl], "a problem+json API answer")
    }

    @Test
    fun `a validated view answer carries exactly one no-store, on the 200 and on the 304`() = testApplication {
        usePostgresTestcontainer()
        val client = seededClient("server-test-view")
        val ok = client.get("/api/v1/views/team-load")
        assertEquals(HttpStatusCode.OK, ok.status)
        assertEquals(listOf("no-store"), ok.headers.getAll(HttpHeaders.CacheControl), "a validated 200: one Cache-Control, not two")
        val etag = assertNotNull(ok.headers[HttpHeaders.ETag])
        val notModified = client.get("/api/v1/views/team-load") { header(HttpHeaders.IfNoneMatch, etag) }
        // The status is pinned by ViewValidatorsTest (another test may have moved the document between the reads); the header, always.
        assertEquals(listOf("no-store"), notModified.headers.getAll(HttpHeaders.CacheControl), "a validated 304 (or re-sent 200): one")
    }

    @Test
    fun `static SPA assets keep their caching - hashed css and js cached a day, index html always revalidated`() = testApplication {
        val staticDir = Files.createTempDirectory("server-test-static")
        try {
            staticDir.resolve("index.html").writeText("<html>spa</html>")
            staticDir.resolve("app.js").writeText("console.log(1)")
            staticDir.resolve("app.css").writeText("body{}")
            configureApp("web.staticDir" to staticDir.toString())
            startApplication()
            // The default client on purpose: non-/api/ paths are not in the OpenAPI spec.
            assertEquals("max-age=86400", client.get("/app.js").headers[HttpHeaders.CacheControl])
            assertEquals("max-age=86400", client.get("/app.css").headers[HttpHeaders.CacheControl])
            val index = client.get("/")
            assertEquals(HttpStatusCode.OK, index.status)
            // The un-hashed entry point must pick up new asset names on deploy: revalidate, never max-age/no-store.
            assertEquals("no-cache", index.headers[HttpHeaders.CacheControl], "index.html")
            val deepLink = client.get("/some/spa/route")
            assertEquals(HttpStatusCode.OK, deepLink.status)
            assertEquals("no-cache", deepLink.headers[HttpHeaders.CacheControl], "an SPA deep link is answered with index.html")
        } finally {
            staticDir.toFile().deleteRecursively()
        }
    }

    @Test
    fun `unknown api paths answer 404 problem+json even with the SPA catch-all, which still serves everything else`() = testApplication {
        val staticDir = Files.createTempDirectory("server-test-api-404")
        try {
            staticDir.resolve("index.html").writeText("<html>spa</html>")
            staticDir.resolve("app.js").writeText("console.log(1)")
            configureApp("web.staticDir" to staticDir.toString())
            startApplication()
            // The default client on purpose: an undeclared /api/ path would be flagged by the OpenAPI
            // conformance plugin that jsonClient() installs — the 404 is exactly what is under test.
            listOf("/api/v1/nope", "/api/nope", "/api/v1/users/1/nope", "/api/", "/api").forEach { path ->
                val response = client.get(path)
                assertEquals(HttpStatusCode.NotFound, response.status, "GET $path")
                assertTrue(
                    response.headers["Content-Type"]?.startsWith("application/problem+json") == true,
                    "problem+json on $path, was ${response.headers["Content-Type"]}",
                )
                assertTrue("spa" !in response.bodyAsText(), "no index.html body on $path")
            }
            assertEquals(HttpStatusCode.NotFound, client.post("/api/v1/nope").status, "any method")
            // A look-alike is not the API namespace; the SPA and its assets are unaffected.
            assertEquals("<html>spa</html>", client.get("/").bodyAsText())
            assertEquals("<html>spa</html>", client.get("/some/spa/route").bodyAsText())
            assertEquals("<html>spa</html>", client.get("/apix").bodyAsText())
            assertEquals("console.log(1)", client.get("/app.js").bodyAsText())
            // A declared route still wins over the tail-card.
            assertEquals(HttpStatusCode.OK, client.get("/api/v1/health").status)
        } finally {
            staticDir.toFile().deleteRecursively()
        }
    }

    @Test
    fun `swagger UI is excluded from the strict CSP but still hardened`() = testApplication {
        usePostgresTestcontainer()
        val response = client.get("/openapi")
        // The strict app CSP must not cover the Swagger UI (it needs inline script/style)...
        assertNull(response.headers["Content-Security-Policy"])
        // ...but the non-CSP hardening headers still apply.
        assertEquals("nosniff", response.headers["X-Content-Type-Options"])
    }

    @Test
    fun `with the swagger UI mounted only openapi and its subtree are CSP-exempt`() = testApplication {
        configureApp("http.exposeOpenApi" to "true")
        startApplication()
        assertNull(client.get("/openapi").headers["Content-Security-Policy"])
        assertNull(client.get("/openapi/documentation.yaml").headers["Content-Security-Policy"])
        // A look-alike path is not the Swagger UI — it keeps the strict CSP.
        assertEquals(FULL_CSP, client.get("/openapiX").headers["Content-Security-Policy"])
    }

    @Test
    fun `with the swagger UI not mounted every openapi path carries the full CSP - the SPA catch-all serves it`() = testApplication {
        val staticDir = Files.createTempDirectory("server-test-openapi-csp")
        try {
            staticDir.resolve("index.html").writeText("<html>spa</html>")
            configureApp("http.exposeOpenApi" to "false", "web.staticDir" to staticDir.toString())
            startApplication()
            listOf("/openapi", "/openapi/x", "/openapi/documentation.yaml", "/openapiX").forEach { path ->
                val response = client.get(path)
                assertEquals(FULL_CSP, response.headers["Content-Security-Policy"], "CSP on $path (${response.status})")
            }
            assertEquals(HttpStatusCode.OK, client.get("/openapi").status, "the SPA catch-all answers /openapi with index.html")
        } finally {
            staticDir.toFile().deleteRecursively()
        }
    }

    @Test
    fun `configured corsHosts installs CORS and answers preflight`() = testApplication {
        configureApp("http.corsHosts" to "app.example.com")
        startApplication()
        val response = client.options("/api/v1/login") {
            header(HttpHeaders.Origin, "https://app.example.com")
            header(HttpHeaders.AccessControlRequestMethod, "POST")
        }
        assertEquals(HttpStatusCode.OK, response.status)
        assertEquals("https://app.example.com", response.headers[HttpHeaders.AccessControlAllowOrigin])
    }

    @Test
    fun `a configured CORS preflight allows If-None-Match and a cross-origin answer exposes ETag - both or neither`() = testApplication {
        configureApp("http.corsHosts" to "app.example.com")
        startApplication()
        val preflight = client.options("/api/v1/views/team-load") {
            header(HttpHeaders.Origin, "https://app.example.com")
            header(HttpHeaders.AccessControlRequestMethod, "GET")
            header(HttpHeaders.AccessControlRequestHeaders, "If-None-Match")
        }
        assertEquals(HttpStatusCode.OK, preflight.status)
        val allowed = preflight.headers[HttpHeaders.AccessControlAllowHeaders].orEmpty().split(',').map { it.trim().lowercase() }
        assertTrue("if-none-match" in allowed, "If-None-Match is allowed: $allowed")
        // A view GET from the allowed origin: the tag is exposed to its script (the 401 of an anonymous call carries no tag to expose).
        val client = seededClient("server-test-cors")
        val answer = client.get("/api/v1/views/team-load") { header(HttpHeaders.Origin, "https://app.example.com") }
        assertEquals(HttpStatusCode.OK, answer.status)
        val exposed = answer.headers[HttpHeaders.AccessControlExposeHeaders].orEmpty().split(',').map { it.trim().lowercase() }
        assertTrue("etag" in exposed, "ETag is exposed: $exposed")
    }

    @Test
    fun `an origin outside the CORS allow-list gets neither If-None-Match allowed nor ETag exposed`() = testApplication {
        configureApp("http.corsHosts" to "app.example.com")
        startApplication()
        val stranger = "https://other.example.com"
        val preflight = client.options("/api/v1/views/team-load") {
            header(HttpHeaders.Origin, stranger)
            header(HttpHeaders.AccessControlRequestMethod, "GET")
            header(HttpHeaders.AccessControlRequestHeaders, "If-None-Match")
        }
        assertNull(preflight.headers[HttpHeaders.AccessControlAllowOrigin])
        assertNull(preflight.headers[HttpHeaders.AccessControlAllowHeaders], "the header is allowed to no stranger")
        // The plain test client (no OpenAPI conformance: the CORS plugin's own 403 is no documented answer) - the plugin refuses the
        // stranger's call before authentication, whatever the bearer.
        val answer = client.get("/api/v1/views/team-load") { header(HttpHeaders.Origin, stranger) }
        assertNull(answer.headers[HttpHeaders.AccessControlAllowOrigin])
        assertNull(answer.headers[HttpHeaders.ETag])
        assertNull(answer.headers[HttpHeaders.AccessControlExposeHeaders], "nothing is exposed to a stranger's script")
    }

    @Test
    fun `unknown route returns 404 when no SPA staticDir is configured`() = testApplication {
        usePostgresTestcontainer()
        val response = client.get("/definitely-not-a-route")
        assertEquals(HttpStatusCode.NotFound, response.status)
    }

    private companion object {
        /** `plugins/SecurityHeaders.kt`'s APP_CSP, verbatim — any loosening must be a deliberate test edit. */
        const val FULL_CSP = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; " +
            "font-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self'; " +
            "frame-ancestors 'none'"

        /** `plugins/SecurityHeaders.kt`'s Permissions-Policy, verbatim (checkup 3, D7-4). */
        const val PERMISSIONS_POLICY = "geolocation=(), camera=(), microphone=(), payment=()"
    }
}
