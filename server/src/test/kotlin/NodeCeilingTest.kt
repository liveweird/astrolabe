package ch.nokillswit

import ch.nokillswit.infra.fetch.DEPTH_CEILING_TEXT
import ch.nokillswit.infra.fetch.FetchException
import ch.nokillswit.infra.fetch.FetchSource
import ch.nokillswit.infra.fetch.MAX_RESPONSE_DEPTH
import ch.nokillswit.infra.fetch.NODE_CEILING_TEXT
import ch.nokillswit.infra.fetch.SourceHttp
import io.ktor.client.HttpClient
import io.ktor.client.engine.mock.MockEngine
import io.ktor.client.engine.mock.respond
import io.ktor.client.request.HttpRequestData
import io.ktor.http.Headers
import io.ktor.http.HttpHeaders
import io.ktor.http.HttpMethod
import io.ktor.http.HttpStatusCode
import io.ktor.http.headersOf
import java.io.ByteArrayOutputStream
import java.util.concurrent.CopyOnWriteArrayList
import java.util.zip.GZIPOutputStream
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertTrue

private val JSON_HEADERS = headersOf(HttpHeaders.ContentType, "application/json")
private const val MIB = 1024L * 1024

/**
 * The properties of the verbatim-ported `SourceHttp` that its node/depth ceiling, bounded read and parse promise
 * (`infra/fetch/NodeCeiling.kt`; Flow's `JiraResponseNodeCeilingTest` is the donor, minus the scan-only vectors `PagingCeilingTest` keeps
 * and the Jira-specific stub-page checks): the ceiling is derived from the byte cap; a body at it parses and one token over does not;
 * a dense or deep body is a typed `LIMIT_EXCEEDED` BEFORE it is parsed (never a `StackOverflowError`); multi-byte text, truncation,
 * trailing text and empty bodies behave; the WARN never carries the body; identity encoding is requested and a gzip body is never inflated.
 */
class NodeCeilingTest {
    private val source = FetchSource("Test", "test.maxResponseBytes")

    private fun bytes(json: String) = json.toByteArray(Charsets.UTF_8)

    private fun nested(depth: Int) = "[".repeat(depth) + "]".repeat(depth)

    private class Wire(val requests: MutableList<HttpRequestData> = CopyOnWriteArrayList())

    private fun http(
        maxResponseBytes: Long,
        body: ByteArray,
        wire: Wire = Wire(),
        headers: Headers = JSON_HEADERS,
        maxResponseNodes: Long? = null,
    ): SourceHttp {
        val client = HttpClient(MockEngine { request -> wire.requests += request; respond(body, HttpStatusCode.OK, headers) }) {
            expectSuccess = false
            followRedirects = false
        }
        // Production wiring passes only the byte cap (the default derives the node ceiling); a test passes nodes only to pin the boundary.
        return if (maxResponseNodes == null) {
            SourceHttp(
                client, maxRetries = 0, maxResponseBytes = maxResponseBytes, maxConcurrentRequests = 1, source = source, sleeper = {},
            )
        } else {
            SourceHttp(
                client, maxRetries = 0, maxResponseBytes = maxResponseBytes, maxConcurrentRequests = 1, source = source, sleeper = {},
                maxResponseNodes = maxResponseNodes,
            )
        }
    }

    private suspend fun SourceHttp.get() = request(HttpMethod.Get, "https://stub.test/rest/api/3/x")

    @Test
    fun `a dense body inside the byte cap is refused as LIMIT_EXCEEDED before it is parsed, with constant text`() = runBlocking<Unit> {
        // 1 MiB cap -> 131,072 tokens. `{},` x 100,000 = 300 KB (inside the byte cap) and 200,000 tokens. The array is never closed:
        // had it been parsed it would be INVALID_RESPONSE, so LIMIT_EXCEEDED proves the scan came first.
        val dense = bytes("[" + "{},".repeat(100_000))
        assertTrue(dense.size < MIB)
        val failure = assertFailsWith<FetchException> { http(MIB, dense).get() }
        assertEquals("LIMIT_EXCEEDED", failure.code)
        assertEquals(200, failure.status)
        assertEquals("Test fetch failed: LIMIT_EXCEEDED (200): $NODE_CEILING_TEXT", failure.message)
    }

    @Test
    fun `a body nested a hundred thousand levels deep is a typed refusal, not a StackOverflowError`() = runBlocking<Unit> {
        val failure = assertFailsWith<FetchException> { http(8 * MIB, bytes("[".repeat(100_000))).get() }
        assertEquals("LIMIT_EXCEEDED", failure.code)
        assertEquals("Test fetch failed: LIMIT_EXCEEDED (200): $DEPTH_CEILING_TEXT", failure.message)
        // A well-formed one just past the ceiling is refused too; at the ceiling it parses and re-serialises.
        val closed = assertFailsWith<FetchException> { http(8 * MIB, bytes(nested(MAX_RESPONSE_DEPTH + 1))).get() }
        assertEquals("LIMIT_EXCEEDED", closed.code)
        assertEquals(nested(MAX_RESPONSE_DEPTH), http(8 * MIB, bytes(nested(MAX_RESPONSE_DEPTH))).get().toString())
    }

    @Test
    fun `the same refusal is the one an over-cap body gets, so a caller answers both alike`() = runBlocking<Unit> {
        val overCap = assertFailsWith<FetchException> { http(1_024, ByteArray(2_000) { 'x'.code.toByte() }).get() }
        val dense = assertFailsWith<FetchException> { http(1_024, bytes("[" + "0,".repeat(400))).get() }
        assertEquals(overCap.code, dense.code)
    }

    @Test
    fun `a body at the ceiling still parses, and one token over does not`() = runBlocking<Unit> {
        // [0,0,0,0] = 1 bracket + 3 commas.
        assertEquals(4, (http(8_192, bytes("[0,0,0,0]"), maxResponseNodes = 4).get() as JsonArray).size)
        assertFailsWith<FetchException> { http(8_192, bytes("[0,0,0,0]"), maxResponseNodes = 3).get() }
    }

    @Test
    fun `a ceiling not passed is derived from the byte cap`() = runBlocking<Unit> {
        // 8,192 bytes -> 1,024 tokens: the bracket + 1,023 commas is exactly at it, one comma more is over.
        assertEquals(1_024, (http(8_192, bytes("[" + "0,".repeat(1_023) + "0]")).get() as JsonArray).size)
        assertFailsWith<FetchException> { http(8_192, bytes("[" + "0,".repeat(1_024) + "0]")).get() }
    }

    @Test
    fun `a body over a mebibyte is parsed under the big-parse lock and arrives intact`() = runBlocking<Unit> {
        val big = bytes("[" + "0,".repeat(600_000) + "0]")
        assertTrue(big.size > MIB)
        assertEquals(600_001, (http(8 * MIB, big).get() as JsonArray).size)
    }

    @Test
    fun `a multi-byte body parses from its bytes to the same tree the text parses to`() = runBlocking<Unit> {
        // Polish diacritics, CJK, an astral emoji (a surrogate pair), a literal and an escaped pair, and \u escapes of both kinds.
        val text = """{"pl":"zażółć gęślą jaźń","cjk":"日本語のテキスト 漢字","emoji":"😀 𝄞","escaped":"ą中 😀",""" +
            """"key ż 中":["é",1.5,null,true]}"""
        val expected = Json.parseToJsonElement(text)
        val parsed = http(8 * MIB, bytes(text)).get()
        assertEquals(expected, parsed)
        assertEquals(expected.toString(), parsed.toString())
        val obj = parsed as JsonObject
        assertEquals("zażółć gęślą jaźń", (obj.getValue("pl") as JsonPrimitive).content)
        assertEquals("😀 𝄞", (obj.getValue("emoji") as JsonPrimitive).content)
        assertEquals("ą中 😀", (obj.getValue("escaped") as JsonPrimitive).content)
        // Past the 1 MiB big-parse lock, with a multi-byte character straddling the 8 KiB reads of the stream decoder.
        val big = "[" + "\"żółć日😀\",".repeat(150_000) + "\"end\"]"
        assertTrue(bytes(big).size > MIB)
        assertEquals(Json.parseToJsonElement(big), http(8 * MIB, bytes(big)).get())
    }

    @Test
    fun `a truncated body, text after the document and an empty body are INVALID_RESPONSE, not an unmapped one`() = runBlocking<Unit> {
        listOf(
            """{"a":[1,2""",
            """{"a":"zażółć""",
            """{"a":1}}""",
            """{"a":1} trailing""",
            """[1,2]3""",
            """{"a":1}{"b":2}""",
            "",
            "not json",
        ).forEach { body ->
            val failure = assertFailsWith<FetchException>(body) { http(8 * MIB, bytes(body)).get() }
            assertEquals("INVALID_RESPONSE", failure.code, body)
            assertEquals(200, failure.status, body)
        }
    }

    @Test
    fun `the node-ceiling WARN carries the constant ceiling text and numbers only, never the body`() = runBlocking<Unit> {
        val logs = LogCapture("ch.nokillswit.infra.fetch.SourceHttp")
        try {
            val marker = "HOSTSECRET"
            assertFailsWith<FetchException> { http(1_024, bytes("""["$marker",""" + "0,".repeat(400) + "0]")).get() }
            val warn = logs.events.single { it.formattedMessage.startsWith("A Test response was refused") }
            assertEquals(
                "A Test response was refused ($NODE_CEILING_TEXT); ceilings: 128 tokens, $MAX_RESPONSE_DEPTH levels",
                warn.formattedMessage,
            )
            assertTrue(marker !in warn.formattedMessage)
        } finally {
            logs.detach()
        }
    }

    private fun gzip(raw: ByteArray): ByteArray {
        val out = ByteArrayOutputStream()
        GZIPOutputStream(out).use { it.write(raw) }
        return out.toByteArray()
    }

    @Test
    fun `identity encoding is asked for, and a gzip body that comes anyway is never inflated or parsed`() = runBlocking<Unit> {
        // A small compressed body that would inflate to a dense 3 MB document.
        val bomb = gzip(bytes("[" + "{},".repeat(1_000_000) + "{}]"))
        assertTrue(bomb.size < 100_000)
        val wire = Wire()
        val headers = headersOf(HttpHeaders.ContentType to listOf("application/json"), HttpHeaders.ContentEncoding to listOf("gzip"))
        val failure = assertFailsWith<FetchException> { http(8 * MIB, bomb, wire, headers).get() }
        assertEquals("INVALID_RESPONSE", failure.code, "the compressed bytes are what is read and parsed: not JSON")
        assertEquals("identity", wire.requests.single().headers[HttpHeaders.AcceptEncoding])
    }
}
