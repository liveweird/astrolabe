package ch.nokillswit

import ch.nokillswit.plugins.IfNoneMatch
import ch.nokillswit.plugins.ProblemJson
import ch.nokillswit.plugins.bodyEtag
import ch.nokillswit.plugins.configureErrorHandling
import ch.nokillswit.plugins.configureHttp
import ch.nokillswit.plugins.configureSerialization
import ch.nokillswit.plugins.ifNoneMatch
import ch.nokillswit.plugins.offerValidator
import ch.nokillswit.plugins.respondRevalidated
import io.ktor.client.request.get
import io.ktor.client.request.header
import io.ktor.client.statement.bodyAsBytes
import io.ktor.client.statement.bodyAsText
import io.ktor.http.ContentType
import io.ktor.http.HttpHeaders
import io.ktor.http.HttpStatusCode
import io.ktor.http.content.TextContent
import io.ktor.http.contentType
import io.ktor.server.config.MapApplicationConfig
import io.ktor.server.plugins.BadRequestException
import io.ktor.server.response.respond
import io.ktor.server.routing.get
import io.ktor.server.routing.routing
import io.ktor.server.testing.testApplication
import kotlinx.serialization.Serializable
import kotlin.test.Test
import kotlin.test.assertContentEquals
import kotlin.test.assertEquals
import kotlin.test.assertNotEquals
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * The view validators (1.22): Flow's `ReportValidatorsTest` ported, with the tag a hash of the ANSWER (the caller's user id and the
 * rendered document) instead of a stamp of inputs. The pure pieces; the sweep over every `/views/` operation of the spec (a new view
 * either joins the validators or is on [LEFT_OUT] with its reason); the ordering against authentication, validation and the view's own
 * `404`/`400`; one login's tag against another's; the probe routes (headers on a problem answer, the helper's `200` equal to
 * `call.respond`'s). Documents the shared database moves are re-read (`assertRevalidates`); the input-by-input cases are
 * `ViewValidatorInputsTest`'s, the real Netty wire `ViewNotModifiedWireTest`'s.
 */
class ViewValidatorsTest {
    // ---- the pure pieces ----------------------------------------------------------------------------------

    @Test
    fun `the etag is a weak sha256 base64url validator over the user and the text`() {
        val etag = bodyEtag(7u, """{"a":1}""")
        assertTrue(Regex("W/\"[A-Za-z0-9_-]{43}\"").matches(etag), etag)
        assertEquals(etag, bodyEtag(7u, """{"a":1}"""), "deterministic")
        assertNotEquals(etag, bodyEtag(8u, """{"a":1}"""), "the same text under two user ids gives two tags")
        assertNotEquals(etag, bodyEtag(7u, """{"a":2}"""), "another text, another tag")
        assertNotEquals(bodyEtag(1u, "23\n"), bodyEtag(12u, "3\n"), "the user id cannot blur into the text")
    }

    @Test
    fun `If-None-Match follows RFC 9110 weak comparison`() {
        val etag = "W/\"abc\""
        assertEquals(IfNoneMatch.TAG_MATCH, ifNoneMatch(listOf("W/\"abc\""), etag), "same weak tag")
        assertEquals(IfNoneMatch.TAG_MATCH, ifNoneMatch(listOf("\"abc\""), etag), "strong form of the same opaque tag matches weakly")
        assertEquals(IfNoneMatch.TAG_MATCH, ifNoneMatch(listOf("W/\"x\", W/\"abc\" , \"y\""), etag), "a list")
        assertEquals(IfNoneMatch.TAG_MATCH, ifNoneMatch(listOf("\"x\"", "W/\"abc\""), etag), "several header lines")
        assertEquals(IfNoneMatch.NO_MATCH, ifNoneMatch(listOf("W/\"abd\""), etag), "another tag")
        assertEquals(IfNoneMatch.NO_MATCH, ifNoneMatch(listOf("abc"), etag), "an unquoted token is no entity-tag")
        assertEquals(IfNoneMatch.NO_MATCH, ifNoneMatch(listOf("w/\"abc\""), etag), "a lower-case w/ is no weak prefix")
        assertEquals(IfNoneMatch.NO_MATCH, ifNoneMatch(listOf("\"a,*,b\""), etag), "a star inside one quoted tag is no wildcard")
        assertEquals(IfNoneMatch.TAG_MATCH, ifNoneMatch(listOf("\"a,b\", W/\"abc\""), etag), "a comma inside a quoted tag splits nothing")
        assertEquals(IfNoneMatch.ANY, ifNoneMatch(listOf("\"x\", *"), etag), "a star member after a quoted tag")
        assertEquals(IfNoneMatch.NO_MATCH, ifNoneMatch(listOf("garbage, , W/"), etag), "garbage")
        assertEquals(IfNoneMatch.NO_MATCH, ifNoneMatch(emptyList(), etag))
        assertEquals(IfNoneMatch.NO_MATCH, ifNoneMatch(null, etag))
        assertEquals(IfNoneMatch.ANY, ifNoneMatch(listOf("*"), etag))
        assertEquals(IfNoneMatch.ANY, ifNoneMatch(listOf(" * "), etag))
        assertEquals(IfNoneMatch.TAG_MATCH, ifNoneMatch(listOf("*, W/\"abc\""), etag), "a listed match wins over the wildcard")
    }

    // ---- the sweep ------------------------------------------------------------------------------------------

    @Test
    fun `every view operation of the spec answers 200 with an ETag and 304 on a match, or is on the left-out list`() = testApplication {
        usePostgresTestcontainer()
        val w = planWorld("vsweep", teams = true)
        val t = w.requireTeams()
        TestPlan.milestone(w.projectId, t.teamId)
        val baselineId = TestPlan.baseline(planName("vsweep"))
        try {
            val urls = mapOf(
                "/api/v1/views/plan" to "/api/v1/views/plan",
                "/api/v1/views/home" to "/api/v1/views/home",
                "/api/v1/views/team-load" to "/api/v1/views/team-load",
                "/api/v1/views/dependencies" to "/api/v1/views/dependencies",
                "/api/v1/views/project/{id}" to "/api/v1/views/project/${w.projectId}",
                "/api/v1/views/team/{id}" to "/api/v1/views/team/${t.teamId}",
                "/api/v1/views/programs" to "/api/v1/views/programs",
                "/api/v1/views/roadmap" to "/api/v1/views/roadmap",
                "/api/v1/views/jira-links" to "/api/v1/views/jira-links",
                "/api/v1/views/baseline/{id}" to "/api/v1/views/baseline/$baselineId",
            )
            val spec = String(checkNotNull(ViewValidatorsTest::class.java.getResourceAsStream("/openapi/documentation.yaml")).readBytes())
            val declared = Regex("(?m)^  (/api/v1/views/[^:]+):$").findAll(spec).map { it.groupValues[1] }.toSet()
            assertEquals(declared, urls.keys + LEFT_OUT.keys, "a new view operation must join the validators and this sweep, or LEFT_OUT")
            urls.keys.forEach { assertTrue(specSegment(spec, it).contains("'304'"), "$it declares 304") }
            LEFT_OUT.keys.forEach { assertTrue(!specSegment(spec, it).contains("'304'"), "$it is left out and declares no 304") }

            val client = w.stranger.client
            urls.forEach { (operation, url) -> client.assertRevalidates(url, operation) }
            // The query parameters change the document, not the contract.
            client.assertRevalidates("/api/v1/views/project/${w.projectId}?baseline=$baselineId", "project?baseline")
            client.assertRevalidates("/api/v1/views/team/${t.teamId}?baseline=$baselineId", "team?baseline")
            client.assertRevalidates("/api/v1/views/team/${t.teamId}?criticalChain=true", "team?criticalChain")
            val both = "baseline=$baselineId&criticalPath=${w.projectId}"
            client.assertRevalidates("/api/v1/views/roadmap?$both", "roadmap?baseline&criticalPath")
            client.assertRevalidates("/api/v1/views/programs?$both", "programs?baseline&criticalPath")

            // The reads left out stay full answers: no tag, the blanket no-store.
            LEFT_OUT.keys.forEach { path ->
                val response = w.admin.client.get(path)
                assertEquals(HttpStatusCode.OK, response.status, path)
                assertNull(response.headers[HttpHeaders.ETag], "$path: left out, so no validator")
                assertEquals(listOf("no-store"), response.headers.getAll(HttpHeaders.CacheControl), path)
            }
        } finally {
            TestPlan.deleteBaseline(baselineId)
        }
    }

    // ---- HTTP: authentication, matching rules and the ordering against validation ---------------------------

    @Test
    fun `an unauthenticated request is 401 whatever If-None-Match says, and carries no tag`() = testApplication {
        usePostgresTestcontainer()
        val anonymous = jsonClient()
        listOf("*", "W/\"anything\"").forEach { validator ->
            listOf("/api/v1/views/plan", "/api/v1/views/team-load", "/api/v1/views/jira-links").forEach { url ->
                val response = anonymous.conditional(url, validator)
                assertEquals(HttpStatusCode.Unauthorized, response.status, "$url $validator")
                assertNull(response.headers[HttpHeaders.ETag], "$url: a 401 carries no validator")
                assertEquals(listOf("no-store"), response.headers.getAll(HttpHeaders.CacheControl), url)
            }
        }
    }

    @Test
    fun `If-None-Match matching rules - the strong spelling, a list, a stale tag and the wildcard`() = testApplication {
        usePostgresTestcontainer()
        val client = seededClient("vmatch")
        val url = "/api/v1/views/team-load"
        val etag = client.assertRevalidates(url)
        client.assertNotModified(url, etag, "the strong spelling matches weakly") { it.removePrefix("W/") }
        client.assertNotModified(url, etag, "a list holding it") { "W/\"nope\", $it" }
        val other = client.conditional(url, "W/\"nope\"")
        assertEquals(HttpStatusCode.OK, other.status, "a non-matching tag answers the document")
        val current = assertNotNull(other.headers[HttpHeaders.ETag], "with the tag it has")
        assertTrue(other.bodyAsText().isNotEmpty())
        client.assertNotModified(url, current, "the tag the 200 carried")
        val wildcard = client.conditional(url, "*")
        assertEquals(HttpStatusCode.NotModified, wildcard.status, "`*`: a representation exists")
        assertEquals("", wildcard.bodyAsText())
        assertTrue(wildcard.headers[HttpHeaders.ETag].orEmpty().startsWith("W/\""), "and it carries the tag")
        // A quoted tag holding a comma and a star is ONE entity-tag, never a wildcard; a lower-case `w/` is no weak prefix.
        assertEquals(HttpStatusCode.OK, client.conditional(url, "\"a,*,b\"").status, "no wildcard inside a quoted tag")
        assertEquals(HttpStatusCode.OK, client.conditional(url, "w/${current.removePrefix("W/")}").status, "w/ is case-sensitive")
    }

    @Test
    fun `a 404 and a 400 beat a matching tag and carry none`() = testApplication {
        usePostgresTestcontainer()
        val w = planWorld("vorder", teams = true)
        val t = w.requireTeams()
        val client = w.stranger.client
        val baselineId = TestPlan.baseline(planName("vorder"))
        val otherBaselineId = TestPlan.baseline(planName("vorder2"))
        try {
            val tag = client.assertRevalidates("/api/v1/views/team-load")
            // The unknown resources: 404 for every caller, with `*` and with a tag that matches ANOTHER read.
            listOf("/api/v1/views/project/999999", "/api/v1/views/team/999999", "/api/v1/views/baseline/999999").forEach { url ->
                listOf("*", tag).forEach { validator ->
                    val response = client.conditional(url, validator)
                    assertEquals(HttpStatusCode.NotFound, response.status, "$url $validator")
                    assertNull(response.headers[HttpHeaders.ETag], "$url: a 404 carries no validator")
                    assertEquals(ProblemJson.toString(), response.contentType()?.withoutParameters()?.toString(), url)
                }
            }
            // The malformed parameters: 400 (the view's typed ones included), even with `*`.
            listOf(
                "/api/v1/views/project/${w.projectId}?baseline=x",
                "/api/v1/views/team/${t.teamId}?baseline=x",
                "/api/v1/views/team/${t.teamId}?criticalChain=x",
                "/api/v1/views/roadmap?baseline=x",
                "/api/v1/views/roadmap?criticalPath=x",
                "/api/v1/views/programs?baseline=x",
                "/api/v1/views/programs?criticalPath=x",
                "/api/v1/views/baseline/$baselineId?against=$baselineId",
                "/api/v1/views/baseline/$baselineId?against=999999",
                "/api/v1/views/baseline/$baselineId?against=x",
                "/api/v1/views/project/${w.projectId}?baseline=999999",
            ).forEach { url ->
                val response = client.conditional(url, "*")
                assertEquals(HttpStatusCode.BadRequest, response.status, url)
                assertNull(response.headers[HttpHeaders.ETag], "$url: a 400 carries no validator")
            }
            // The addressed baseline of a comparison that does succeed is a normal tagged read.
            client.assertRevalidates("/api/v1/views/baseline/$baselineId?against=$otherBaselineId", "baseline?against")
        } finally {
            TestPlan.deleteBaseline(baselineId)
            TestPlan.deleteBaseline(otherBaselineId)
        }
    }

    @Test
    fun `a tag means nothing to another login - the same document under two logins has two tags`() = testApplication {
        usePostgresTestcontainer()
        val a = seededClient("vlogin-a")
        val b = seededClient("vlogin-b")
        // Team load is the same document for every caller: only the user id in the hash tells the two tags apart.
        val url = "/api/v1/views/team-load"
        val tagA = a.assertRevalidates(url)
        val fromB = b.conditional(url, tagA)
        assertEquals(HttpStatusCode.OK, fromB.status, "B sending A's tag gets the document, not a 304")
        val tagB = fromB.headers[HttpHeaders.ETag]
        assertTrue(tagB != null && tagB != tagA, "B's own tag, not A's: $tagB vs $tagA")
        b.assertNotModified(url, tagB, "B's own tag")
        a.assertNotModified(url, tagA, "and A's still matches for A")
    }

    // ---- the probe routes: the helper's 200 is call.respond's, headers only on a 200/304 ------------------------

    @Serializable
    private data class Probe(val name: String, val count: Int = 3, val note: String? = null, val items: List<Item> = emptyList())

    @Serializable
    private data class Item(val id: UInt, val label: String, val flag: Boolean = false)

    private val probe = Probe("Zażółć gęślą jaźń \"quoted\" <tag>", 0, null, listOf(Item(1u, "a"), Item(4_000_000_000u, "b\nc", true)))

    private data class Unserializable(val x: String)

    @Test
    fun `the helper's 200 equals call respond's in status, content type and bytes`() = testApplication {
        environment {
            config = MapApplicationConfig("ktor.development" to "true", "ktor.deployment.requestReadTimeoutSeconds" to "0")
        }
        application {
            configureHttp()
            configureSerialization()
            configureErrorHandling()
            routing {
                get("/api/probe-validated") { call.respondRevalidated(5u, probe) }
                get("/api/probe-plain") { call.respond(HttpStatusCode.OK, probe) }
                get("/api/probe-list-validated") { call.respondRevalidated(5u, listOf(probe, probe.copy(note = "n"))) }
                get("/api/probe-list-plain") { call.respond(HttpStatusCode.OK, listOf(probe, probe.copy(note = "n"))) }
            }
        }
        val pairs = listOf("/api/probe-validated" to "/api/probe-plain", "/api/probe-list-validated" to "/api/probe-list-plain")
        for ((validated, plain) in pairs) {
            val a = client.get(validated)
            val b = client.get(plain)
            assertEquals(b.status, a.status, validated)
            assertEquals(b.headers[HttpHeaders.ContentType], a.headers[HttpHeaders.ContentType], "$validated: the very Content-Type")
            assertContentEquals(b.bodyAsBytes(), a.bodyAsBytes(), "$validated: byte for byte")
            assertEquals(listOf("no-store"), a.headers.getAll(HttpHeaders.CacheControl))
            assertEquals(listOf("no-store"), b.headers.getAll(HttpHeaders.CacheControl))
            assertNull(b.headers[HttpHeaders.ETag], "plain answers carry no validator")
            val tag = a.headers[HttpHeaders.ETag]
            assertEquals(bodyEtag(5u, a.bodyAsText()), tag, "the tag is the hash of the very text sent")
            assertEquals(HttpStatusCode.NotModified, client.get(validated) { header(HttpHeaders.IfNoneMatch, tag!!) }.status)
        }
        // The one deliberate difference from call.respond: no content negotiation. JSON is UTF-8 (RFC 8259), whatever Accept-Charset says
        // (the plain path would have answered ISO-8859-1 bytes with a charset parameter), so the tag hashes the bytes that travel.
        val latin = client.get("/api/probe-validated") { header(HttpHeaders.AcceptCharset, "iso-8859-1") }
        assertEquals(HttpStatusCode.OK, latin.status)
        assertEquals("application/json", latin.headers[HttpHeaders.ContentType], "UTF-8 application/json, no charset parameter")
        assertContentEquals(client.get("/api/probe-validated").bodyAsBytes(), latin.bodyAsBytes(), "the same UTF-8 bytes")
        assertTrue(latin.bodyAsText(Charsets.UTF_8).contains("Zażółć gęślą jaźń"), "the non-ASCII name survives")
    }

    @Test
    fun `only a 200 or 304 carries the validator headers, a problem response never does`() = testApplication {
        environment {
            config = MapApplicationConfig("ktor.development" to "true", "ktor.deployment.requestReadTimeoutSeconds" to "0")
        }
        application {
            configureHttp()
            configureSerialization()
            configureErrorHandling()
            routing {
                get("/api/probe-ok") {
                    call.offerValidator("W/\"probe\"")
                    call.respond(mapOf("ok" to true))
                }
                get("/api/probe-304") {
                    call.offerValidator("W/\"probe\"")
                    call.respond(HttpStatusCode.NotModified)
                }
                get("/api/probe-500") {
                    call.offerValidator("W/\"probe\"")
                    error("boom after the offer")
                }
                get("/api/probe-400") {
                    call.offerValidator("W/\"probe\"")
                    throw BadRequestException("nope")
                }
                get("/api/probe-unserializable") {
                    call.offerValidator("W/\"probe\"")
                    // A body no registered converter can render, found AFTER the route offered its tag: the 500 must carry no validator.
                    call.respond(Unserializable("x"))
                }
                get("/api/probe-helper-unserializable") { call.respondRevalidated(1u, Unserializable("x")) }
                get("/api/probe-own-202") {
                    call.offerValidator("W/\"probe\"")
                    call.respond(TextContent("{}", ContentType.Application.Json, HttpStatusCode.Accepted))
                }
                get("/api/probe-own-200") {
                    call.offerValidator("W/\"probe\"")
                    call.respond(TextContent("{}", ContentType.Application.Json, HttpStatusCode.OK))
                }
                get("/api/other") { call.respond(mapOf("ok" to true)) }
            }
        }
        val ok = client.get("/api/probe-ok")
        assertEquals(HttpStatusCode.OK, ok.status)
        assertEquals("W/\"probe\"", ok.headers[HttpHeaders.ETag])
        assertEquals(listOf("no-store"), ok.headers.getAll(HttpHeaders.CacheControl))
        assertNull(ok.headers[HttpHeaders.Vary])

        val notModified = client.get("/api/probe-304")
        assertEquals(HttpStatusCode.NotModified, notModified.status)
        assertEquals("W/\"probe\"", notModified.headers[HttpHeaders.ETag])
        assertEquals(listOf("no-store"), notModified.headers.getAll(HttpHeaders.CacheControl))

        val failures = listOf(
            "/api/probe-500" to HttpStatusCode.InternalServerError,
            "/api/probe-400" to HttpStatusCode.BadRequest,
            "/api/probe-unserializable" to HttpStatusCode.InternalServerError,
            "/api/probe-helper-unserializable" to HttpStatusCode.InternalServerError,
        )
        failures.forEach { (path, status) ->
            val problem = client.get(path)
            assertEquals(status, problem.status, path)
            assertEquals(ProblemJson.toString(), problem.contentType()?.withoutParameters()?.toString(), path)
            assertNull(problem.headers[HttpHeaders.ETag], "$path: a problem response carries no validator")
            assertEquals(listOf("no-store"), problem.headers.getAll(HttpHeaders.CacheControl), "$path stays no-store")
        }
        // The status that decides is the CONTENT's own, for the tag and for the blanket no-store alike (one expression, `validatorFor`):
        // content carrying a non-200 status gets no tag and keeps exactly one no-store; one carrying 200 gets the tag and exactly one.
        val own202 = client.get("/api/probe-own-202")
        assertEquals(HttpStatusCode.Accepted, own202.status)
        assertNull(own202.headers[HttpHeaders.ETag])
        assertEquals(listOf("no-store"), own202.headers.getAll(HttpHeaders.CacheControl))
        val own200 = client.get("/api/probe-own-200")
        assertEquals("W/\"probe\"", own200.headers[HttpHeaders.ETag])
        assertEquals(listOf("no-store"), own200.headers.getAll(HttpHeaders.CacheControl))
        // Any other API answer keeps the blanket no-store.
        assertEquals(listOf("no-store"), client.get("/api/other").headers.getAll(HttpHeaders.CacheControl))
    }

    private companion object {
        /** The `/views/` reads that do NOT answer through a validator, each with its reason (`planning-model.md` "View validators"). */
        val LEFT_OUT = mapOf(
            "/api/v1/views/deviations" to "each connection's `status.nextPollAt` is the read's own instant while a poll is due",
            "/api/v1/views/capacity-deviations" to "the same member: two reads are never equal, so a 304 could never be pinned",
        )

        /** The spec text of one path (from its key to the next path's). */
        fun specSegment(spec: String, path: String): String {
            val start = spec.indexOf("\n  $path:\n")
            check(start >= 0) { "$path is not in the spec" }
            val next = Regex("\n  /api/").find(spec, start + 1)
            return spec.substring(start, next?.range?.first ?: spec.length)
        }
    }
}
