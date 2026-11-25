package ch.nokillswit

import ch.nokillswit.auth.LoginResponse
import ch.nokillswit.users.UserRole
import io.ktor.client.HttpClient
import io.ktor.client.call.body
import io.ktor.client.plugins.DefaultRequest
import io.ktor.client.request.get
import io.ktor.client.request.header
import io.ktor.client.statement.bodyAsBytes
import io.ktor.http.HttpHeaders
import io.ktor.http.HttpStatusCode
import io.ktor.server.testing.ApplicationTestBuilder
import java.io.ByteArrayOutputStream
import java.util.zip.GZIPOutputStream
import kotlin.test.assertEquals

/*
 * The read helpers the 1.27 scale tests share (`BaselineScaleTest`, `SavedProposalReadScaleTest`), beside [ScaleFigures]: a seeded ADMIN
 * with the shape-checked client AND a bare bearer client (the OpenAPI conformance plugin parses every response, which would sit in the
 * timings), and one document read answered as its bytes, its gzip size and [SCALE_RUNS] warm timings.
 */

/** Timed reads after the two untimed ones (the plain read and the gzip read) that warm a document. */
internal const val SCALE_RUNS = 5

private const val NANOS_PER_MILLI = 1_000_000.0

/** A seeded ADMIN of a scale test: [conformant] checks every `/api/` interaction against the spec, [bare] only carries the token. */
internal class ScaleCaller(val conformant: HttpClient, val bare: HttpClient)

internal suspend fun ApplicationTestBuilder.scaleAdmin(prefix: String): ScaleCaller {
    val email = uniqueEmail(prefix)
    TestUsers.seed(email = email, password = "pw", role = UserRole.ADMIN)
    val token = jsonClient().login(email, "pw").body<LoginResponse>().token
    val bare = createClient { install(DefaultRequest) { header(HttpHeaders.Authorization, "Bearer $token") } }
    return ScaleCaller(authedClient(email, "pw"), bare)
}

/** The gzip size of [raw] (java.util.zip defaults), for a document a test re-encodes itself. */
internal fun gzipSize(raw: ByteArray): Int = ByteArrayOutputStream().also { out -> GZIPOutputStream(out).use { it.write(raw) } }.size()

/** One document read: the plain [bytes], the [gzip] size as the server answers it, and the warm [timings] (the body included). */
internal class DocumentReading(val bytes: ByteArray, val gzip: Int, val timings: List<Double>) {
    val size: Int get() = bytes.size
    val median: Double get() = ScaleFigures.median(timings)
    val max: Double get() = timings.max()
}

/** Reads [path] once plain, once with `Accept-Encoding: gzip`, then [runs] timed times; every answer must be `200`. */
internal suspend fun HttpClient.readDocument(path: String, runs: Int = SCALE_RUNS): DocumentReading {
    val first = get(path)
    assertEquals(HttpStatusCode.OK, first.status, path)
    val bytes = first.bodyAsBytes()
    val gzip = get(path) { header(HttpHeaders.AcceptEncoding, "gzip") }.bodyAsBytes().size
    val timings = List(runs) {
        val started = System.nanoTime()
        val response = get(path)
        assertEquals(HttpStatusCode.OK, response.status, path)
        response.bodyAsBytes()
        (System.nanoTime() - started) / NANOS_PER_MILLI
    }
    return DocumentReading(bytes, gzip, timings)
}
