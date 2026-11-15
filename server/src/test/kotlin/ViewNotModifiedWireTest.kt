package ch.nokillswit

import ch.nokillswit.users.UserRole
import io.ktor.server.netty.EngineMain
import java.io.BufferedReader
import java.io.InputStreamReader
import java.net.Socket
import java.net.URI
import java.net.http.HttpClient
import java.net.http.HttpRequest
import java.net.http.HttpResponse
import kotlinx.coroutines.runBlocking
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNotNull
import kotlin.test.assertTrue

private const val STAMP_RACE_RETRIES = 3

private const val VIEW = "/api/v1/views/team-load"

/**
 * What the REAL Netty engine puts on the wire for a view `304` (Flow's `ReportNotModifiedWireTest` ported). RFC 9110 section 8.6
 * allows a `304` `Content-Length` only with the value the `200` would have; Ktor sends `0`, a known deviation pinned below. The engine
 * test host used elsewhere does not go through Netty, so this boots the server like `RawForwardedForLinesTest` and reads the raw
 * response by hand.
 */
class ViewNotModifiedWireTest {
    @Test
    fun `a view 304 over Netty has no body and no framing but the engine's zero length, and keeps the security headers`() {
        val server = EngineMain.createServer(
            arrayOf(
                "-port=0",
                "-P:ktor.development=true",
                "-P:postgres.jdbcUrl=${PostgresTestSupport.jdbcUrl}",
                "-P:postgres.r2dbcUrl=${PostgresTestSupport.r2dbcUrl}",
                "-P:postgres.user=${PostgresTestSupport.user}",
                "-P:postgres.password=${PostgresTestSupport.password}",
                "-P:security.csrf.enabled=false",
                // Without these a live sampler and scheduler would run against the SHARED container (configureApp sets the same two).
                "-P:telemetry.enabled=false",
                "-P:sync.scheduler.enabled=false",
            ),
        )
        var userId: UInt? = null
        try {
            server.start(wait = false)
            val port = runBlocking { server.engine.resolvedConnectors().first().port }
            val email = uniqueEmail("wire-304")
            userId = runBlocking { TestUsers.seed(email, "pw", role = UserRole.USER) }

            val http = HttpClient.newHttpClient()
            val login = http.send(
                HttpRequest.newBuilder(URI("http://127.0.0.1:$port/api/v1/login"))
                    .header("Content-Type", "application/json")
                    .POST(HttpRequest.BodyPublishers.ofString("""{"email":"$email","password":"pw"}"""))
                    .build(),
                HttpResponse.BodyHandlers.ofString(),
            )
            assertEquals(200, login.statusCode(), login.body())
            val token = assertNotNull(Regex("\"token\"\\s*:\\s*\"([^\"]+)\"").find(login.body())?.groupValues?.get(1))
            val view = http.send(
                HttpRequest.newBuilder(URI("http://127.0.0.1:$port$VIEW")).header("Authorization", "Bearer $token").GET().build(),
                HttpResponse.BodyHandlers.ofString(),
            )
            assertEquals(200, view.statusCode())
            var etag = assertNotNull(view.headers().firstValue("ETag").orElse(null))

            fun raw(method: String, extra: String = ""): String = Socket("127.0.0.1", port).use { socket ->
                socket.soTimeout = 10_000
                val request = "$method $VIEW HTTP/1.1\r\nHost: 127.0.0.1:$port\r\nAuthorization: Bearer $token\r\n" +
                    extra + "Connection: close\r\n\r\n"
                socket.getOutputStream().write(request.toByteArray(Charsets.US_ASCII))
                socket.getOutputStream().flush()
                BufferedReader(InputStreamReader(socket.getInputStream(), Charsets.ISO_8859_1)).readText()
            }
            // The tag hashes the document, which another test in this fork may move between the fetch and the replay: a 200 carrying a
            // DIFFERENT tag is that race and is replayed with the new tag; a 200 carrying the SAME tag is the bug pinned here.
            var raw = raw("GET", "If-None-Match: $etag\r\n")
            var tries = 0
            while (tries++ < STAMP_RACE_RETRIES) {
                val answered = Regex("(?im)^ETag:\\s*(\\S+)").find(raw.substringBefore("\r\n\r\n"))?.groupValues?.get(1)
                // Done: a 304, or an answer with no tag, or the SAME tag again (that last one is the bug; the assertions below fail it).
                if (" 304" in raw.substringBefore("\r\n") || answered == null || answered == etag) break
                etag = answered
                raw = raw("GET", "If-None-Match: $etag\r\n")
            }
            // A HEAD (the spec declares no HEAD operation, so the conformance-checked client cannot send one) carries the same posture.
            val headLines = raw("HEAD").substringBefore("\r\n\r\n").lines()
            assertTrue(headLines.first().contains(" 200"), headLines.first())

            fun headerValues(lines: List<String>, name: String) =
                lines.drop(1).filter { it.substringBefore(':').equals(name, ignoreCase = true) }.map { it.substringAfter(':').trim() }
            // The validator ran on the HEAD too: its ETag, ONE Cache-Control (never the blanket AND the validator), no Vary.
            assertEquals(listOf("no-store"), headerValues(headLines, "Cache-Control"), "HEAD: $headLines")
            assertTrue(headerValues(headLines, "ETag").single().startsWith("W/\""), "HEAD: $headLines")
            assertTrue(headerValues(headLines, "Vary").isEmpty(), "HEAD carries no Vary; the head was: $headLines")

            val head = raw.substringBefore("\r\n\r\n").lines()
            assertTrue(head.first().contains(" 304"), head.first())
            assertEquals(listOf("no-store"), headerValues(head, "Cache-Control"), "304: $head")
            val names = head.drop(1).associate { it.substringBefore(':').lowercase() to it.substringAfter(':').trim() }
            assertEquals("", raw.substringAfter("\r\n\r\n"), "a 304 has no body")
            // KNOWN DEVIATION (Flow's recorded one, `security.md` "Caching"): Ktor's `BaseApplicationResponse.commitHeaders` appends
            // `Content-Length: 0` to every NoContent answer, a 304 included, and no route-level hook can remove it. A 304 is bodiless by
            // definition (and, with no-store, nothing is refreshed from it), so it is harmless; the pin is that nothing OTHER than that
            // exact value ever appears (no body length, no chunking).
            assertTrue(names["content-length"] in setOf(null, "0"), "a 304 may carry only Content-Length: 0 here; the head was: $head")
            assertFalse("transfer-encoding" in names, "no chunked framing on a 304; the head was: $head")
            assertEquals(etag, names["etag"])
            assertEquals("nosniff", names["x-content-type-options"])
            assertNotNull(names["content-security-policy"], "the security headers ride a 304 too")
        } finally {
            server.stop(gracePeriodMillis = 100, timeoutMillis = 1_000)
            userId?.let { runBlocking { TestUsers.softDelete(it) } }
        }
    }
}
