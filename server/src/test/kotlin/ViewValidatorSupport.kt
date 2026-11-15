package ch.nokillswit

import io.ktor.client.HttpClient
import io.ktor.client.request.get
import io.ktor.client.request.header
import io.ktor.client.statement.HttpResponse
import io.ktor.client.statement.bodyAsText
import io.ktor.http.HttpHeaders
import io.ktor.http.HttpStatusCode
import kotlin.test.assertEquals
import kotlin.test.assertNotEquals
import kotlin.test.assertNotNull

/** A conditional GET of [url] (the conformance-checked client; `If-None-Match: [validator]`). */
suspend fun HttpClient.conditional(url: String, validator: String): HttpResponse =
    get(url) { header(HttpHeaders.IfNoneMatch, validator) }

/** How often a revalidation is re-read when the shared database moved between two reads (a different tag), as Flow's wire test does. */
private const val STAMP_RACE_RETRIES = 3

/**
 * Reads [url] twice and asserts the view validator contract: the first read is a `200` with a weak `ETag` and ONE `no-store`; the
 * second, sending that tag, is a `304` with no body, the same tag and the same single `no-store`. A `200` carrying a DIFFERENT tag is
 * the shared database moving between the reads (re-read with the new tag, up to three tries); a `200` with the SAME tag is the bug.
 * Returns the tag that was finally matched.
 */
suspend fun HttpClient.assertRevalidates(url: String, label: String = url): String {
    val first = get(url)
    assertEquals(HttpStatusCode.OK, first.status, "$label: ${first.bodyAsText().take(300)}")
    var etag = assertNotNull(first.headers[HttpHeaders.ETag], "$label 200 ETag")
    assertEquals(true, etag.startsWith("W/\""), "$label: a weak validator, was $etag")
    assertEquals(listOf("no-store"), first.headers.getAll(HttpHeaders.CacheControl), "$label 200 Cache-Control, once")
    assertEquals(null, first.headers[HttpHeaders.Vary]?.takeIf { "Authorization" in it }, "$label: no Vary")
    repeat(STAMP_RACE_RETRIES) {
        val again = conditional(url, etag)
        if (again.status == HttpStatusCode.NotModified) {
            assertEquals("", again.bodyAsText(), "$label: a 304 has no body")
            assertEquals(etag, again.headers[HttpHeaders.ETag], "$label 304 ETag")
            assertEquals(listOf("no-store"), again.headers.getAll(HttpHeaders.CacheControl), "$label 304 Cache-Control, once")
            assertEquals("nosniff", again.headers["X-Content-Type-Options"], "$label 304 keeps the security headers")
            return etag
        }
        assertEquals(HttpStatusCode.OK, again.status, label)
        val moved = assertNotNull(again.headers[HttpHeaders.ETag], "$label 200 ETag")
        assertNotEquals(etag, moved, "$label: a 200 with the SAME tag as the one sent is a validator that does not validate")
        etag = moved
    }
    error("$label: no 304 in $STAMP_RACE_RETRIES tries - a member of the document changes between two reads with nothing written")
}

/**
 * Asserts that [url] answers `304` for [etag] (sent as `spell(etag)`: the strong spelling, a list...), with the §3.1 race rule: a `200`
 * carrying a DIFFERENT tag is the shared database moving between the reads (re-read with the new tag, up to three tries); a `200` with
 * the SAME tag is the bug. Returns the tag that was finally matched.
 */
suspend fun HttpClient.assertNotModified(url: String, etag: String, label: String = url, spell: (String) -> String = { it }): String {
    var tag = etag
    repeat(STAMP_RACE_RETRIES) {
        val answer = conditional(url, spell(tag))
        if (answer.status == HttpStatusCode.NotModified) return tag
        assertEquals(HttpStatusCode.OK, answer.status, label)
        val moved = assertNotNull(answer.headers[HttpHeaders.ETag], "$label 200 ETag")
        assertNotEquals(tag, moved, "$label: a 200 with the SAME tag as the one sent is a validator that does not validate")
        tag = moved
    }
    error("$label: no 304 in $STAMP_RACE_RETRIES tries - the document changes between reads with nothing written")
}
