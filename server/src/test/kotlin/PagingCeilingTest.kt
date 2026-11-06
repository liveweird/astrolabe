package ch.nokillswit

import ch.nokillswit.infra.fetch.AnswerCeiling
import ch.nokillswit.infra.fetch.BoundedAnswer
import ch.nokillswit.infra.fetch.DEPTH_CEILING_TEXT
import ch.nokillswit.infra.fetch.FetchException
import ch.nokillswit.infra.fetch.FetchSource
import ch.nokillswit.infra.fetch.MAX_PAGE_TOKEN_CHARS
import ch.nokillswit.infra.fetch.NODE_CEILING_TEXT
import ch.nokillswit.infra.fetch.PageCeiling
import ch.nokillswit.infra.fetch.PageTokenGuard
import ch.nokillswit.infra.fetch.RunBudget
import ch.nokillswit.infra.fetch.RunCeiling
import ch.nokillswit.infra.fetch.SourceHttp
import ch.nokillswit.infra.fetch.defaultMaxResponseNodes
import ch.nokillswit.infra.fetch.jsonCeilingBreach
import io.ktor.client.HttpClient
import io.ktor.client.engine.mock.MockEngine
import io.ktor.client.engine.mock.respond
import io.ktor.http.HttpHeaders
import io.ktor.http.HttpMethod
import io.ktor.http.HttpStatusCode
import io.ktor.http.headersOf
import kotlinx.coroutines.runBlocking
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * The ceilings the fetch machinery keeps (`infra/fetch/Ceilings.kt`, `PageTokenGuard.kt`, `NodeCeiling.kt`): the page, answer and run
 * ceilings a paging loop follows, the page-token guard and the node/depth ceiling `SourceHttp` applies before it parses. Flow's version of
 * this suite drove its Jira streams; the ceilings themselves are exercised here directly (the loops that use them come with the sync).
 * Every breach is a `LIMIT_EXCEEDED` (or `INVALID_RESPONSE` for a token) of the caller's [FetchSource], with constant text.
 */
class PagingCeilingTest {
    private val source = FetchSource("Test", "test.maxResponseBytes")

    private fun code(block: () -> Unit): FetchException = assertFailsWith<FetchException> { block() }

    @Test
    fun `a page ceiling allows its pages and refuses the next one`() {
        val pages = PageCeiling(source, "/search", maxPages = 3)
        repeat(3) { pages.next() }
        val failure = code { pages.next() }
        assertEquals("LIMIT_EXCEEDED", failure.code)
        assertTrue("more than 3 pages" in failure.message.orEmpty(), failure.message)
    }

    @Test
    fun `a bounded answer refuses past its characters, its items and its pages`() {
        val chars = BoundedAnswer<String>(source, "/x", AnswerCeiling(maxChars = 10, maxItems = 100, maxPages = 100), "rows")
        chars.add("a", 5)
        chars.add("b", 5)
        assertEquals("LIMIT_EXCEEDED", code { chars.add("c", 1) }.code)
        assertEquals(listOf("a", "b"), chars.items, "an item past the ceiling is not kept")

        val items = BoundedAnswer<Int>(source, "/x", AnswerCeiling(maxChars = 1_000, maxItems = 2, maxPages = 100), "rows")
        items.add(1, 1)
        items.add(2, 1)
        assertTrue("more than 2 rows" in code { items.add(3, 1) }.message.orEmpty())

        val pages = BoundedAnswer<Int>(source, "/x", AnswerCeiling(maxChars = 1_000, maxItems = 100, maxPages = 1), "rows")
        pages.nextPage()
        assertEquals("LIMIT_EXCEEDED", code { pages.nextPage() }.code)
    }

    @Test
    fun `a run budget counts pages, items and wire bytes across the whole run`() {
        val budget = RunBudget(source, "/search", RunCeiling(maxPages = 2, maxItems = 10, maxBytes = 1_000), "issues")
        budget.nextPage()
        budget.add(4, wireBytes = 400)
        budget.nextPage()
        budget.add(6, wireBytes = 600)
        assertEquals("LIMIT_EXCEEDED", code { budget.nextPage() }.code, "a third page")
        assertTrue("more than 10 issues" in code { budget.add(1) }.message.orEmpty(), "an eleventh issue")

        val bytes = RunBudget(source, "/search", RunCeiling(maxPages = 5, maxItems = 1_000, maxBytes = 100), "issues")
        bytes.add(1, wireBytes = 100)
        assertTrue("more than 100 bytes" in code { bytes.add(1, wireBytes = 1) }.message.orEmpty())

        val unbounded = RunBudget(source, "/search", RunCeiling(maxPages = 5, maxItems = 1_000), "issues")
        unbounded.add(1, wireBytes = Long.MAX_VALUE / 4)
        unbounded.add(1, wireBytes = Long.MAX_VALUE / 4)
    }

    @Test
    fun `a page token the host repeats, or one that is too long, is refused with constant text`() {
        val guard = PageTokenGuard(source, "/search")
        guard.accept(null)
        guard.accept("t1")
        guard.accept("t2")
        val cycle = code { guard.accept("t1") }
        assertEquals("INVALID_RESPONSE", cycle.code)
        assertTrue("already sent" in cycle.message.orEmpty(), cycle.message)
        assertFalse(cycle.message.orEmpty().contains("t1"), "the host's token never echoes into the message")

        val long = code { PageTokenGuard(source, "/search").accept("x".repeat(MAX_PAGE_TOKEN_CHARS + 1)) }
        assertTrue("longer than $MAX_PAGE_TOKEN_CHARS" in long.message.orEmpty(), long.message)
        PageTokenGuard(source, "/search").accept("x".repeat(MAX_PAGE_TOKEN_CHARS))
    }

    @Test
    fun `a resumed token counts as seen, and a restart after CURSOR_EXPIRED forgets the old chain`() {
        val guard = PageTokenGuard(source, "/search", resumed = "t5")
        assertEquals("INVALID_RESPONSE", code { guard.accept("t5") }.code, "the host answered the token it was asked with")
        guard.accept("t6")
        guard.restart()
        guard.accept("t6")
        guard.accept("t5")
    }

    @Test
    fun `the node ceiling counts structural tokens outside strings and the depth ceiling the open containers`() {
        assertNull(jsonCeilingBreach("""{"a":[1,2,3],"b":"{[,:"}""".toByteArray(), nodeLimit = 100))
        // { : [ , , , : = 7 tokens; the characters inside the string and an escaped quote do not count.
        assertNull(jsonCeilingBreach("""{"a":[1,2,3],"b":"\"{[,:"}""".toByteArray(), nodeLimit = 7))
        assertEquals(NODE_CEILING_TEXT, jsonCeilingBreach("""{"a":[1,2,3],"b":"\"{[,:"}""".toByteArray(), nodeLimit = 6))
        assertEquals(NODE_CEILING_TEXT, jsonCeilingBreach("[0,0,0,0,0]".toByteArray(), nodeLimit = 4))
        assertEquals(DEPTH_CEILING_TEXT, jsonCeilingBreach("[[[[0]]]]".toByteArray(), nodeLimit = 100, depthLimit = 3))
        assertNull(jsonCeilingBreach("[[[0]]]".toByteArray(), nodeLimit = 100, depthLimit = 3))
        // A stray closer cannot take the depth below zero, so it never hides a later opener.
        assertEquals(DEPTH_CEILING_TEXT, jsonCeilingBreach("]]]][[[".toByteArray(), nodeLimit = 100, depthLimit = 2))
        assertEquals(1_048_576L, defaultMaxResponseNodes(8L * 1024 * 1024))
    }

    private fun http(body: String, maxResponseBytes: Long = 1_000_000): SourceHttp = SourceHttp(
        HttpClient(MockEngine { respond(body, HttpStatusCode.OK, headersOf(HttpHeaders.ContentType, "application/json")) }) {
            expectSuccess = false
            followRedirects = false
        },
        maxRetries = 0,
        maxResponseBytes = maxResponseBytes,
        maxConcurrentRequests = 1,
        source = source,
        sleeper = {},
    )

    @Test
    fun `SourceHttp refuses a dense or a deep body before it parses it, and a body past the byte cap while reading`() = runBlocking<Unit> {
        // 8 bytes per node at a 1,000-byte cap = 125 tokens; 130 commas is over it though the body is only ~260 bytes.
        val dense = "[${"0,".repeat(130)}0]"
        val denseFailure = assertFailsWith<FetchException> {
            http(dense, maxResponseBytes = 1_000).request(HttpMethod.Get, "https://stub.invalid/x")
        }
        assertEquals("LIMIT_EXCEEDED", denseFailure.code)
        assertTrue(NODE_CEILING_TEXT in denseFailure.message.orEmpty(), denseFailure.message)

        val deep = "[".repeat(600) + "]".repeat(600)
        val deepFailure = assertFailsWith<FetchException> { http(deep).request(HttpMethod.Get, "https://stub.invalid/x") }
        assertTrue(DEPTH_CEILING_TEXT in deepFailure.message.orEmpty(), deepFailure.message)

        val big = "[${"0,".repeat(600)}0]"
        assertEquals("LIMIT_EXCEEDED", assertFailsWith<FetchException> {
            http(big, maxResponseBytes = 1_000).request(HttpMethod.Get, "https://stub.invalid/x")
        }.code)

        assertEquals("INVALID_RESPONSE", assertFailsWith<FetchException> {
            http("{not json").request(HttpMethod.Get, "https://stub.invalid/x")
        }.code)
    }
}
