package ch.nokillswit

import ch.nokillswit.infra.fetch.FetchException
import ch.nokillswit.infra.fetch.FetchSource
import ch.nokillswit.infra.fetch.PermitWait
import ch.nokillswit.infra.fetch.SourceHttp
import io.ktor.client.HttpClient
import io.ktor.client.engine.mock.MockEngine
import io.ktor.client.engine.mock.respond
import io.ktor.http.HttpHeaders
import io.ktor.http.HttpMethod
import io.ktor.http.HttpStatusCode
import io.ktor.http.headersOf
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.async
import kotlinx.coroutines.delay
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeout
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertTrue

/**
 * The permit queue of `SourceHttp` under contention (1.1.0 F1): the pool is process-wide, so a call that waits for a permit must not
 * wait for ever. A first attempt's deadline starts BEFORE its permit (the queue is charged to the call: `TIMEOUT`), and an
 * interactive caller's
 * [PermitWait] turns a longer queue into the typed `BUSY`. Real time with small limits (a virtual clock cannot expire a suspended acquire).
 */
class PermitContentionTest {
    private val gate = CompletableDeferred<Unit>()
    private val started = CompletableDeferred<Unit>()

    private fun http(deadlineMillis: Long = 60_000) = SourceHttp(
        HttpClient(
            MockEngine { request ->
                if (request.url.encodedPath == "/hold") {
                    started.complete(Unit)
                    gate.await()
                }
                respond("{}", HttpStatusCode.OK, headersOf(HttpHeaders.ContentType, "application/json"))
            },
        ) { expectSuccess = false; followRedirects = false },
        maxRetries = 0, maxResponseBytes = 1_000_000, maxConcurrentRequests = 1,
        source = FetchSource("Test", "test.maxResponseBytes"), requestDeadlineMillis = deadlineMillis,
    )

    private suspend fun SourceHttp.get(path: String) = request(HttpMethod.Get, "https://tenant.test$path")

    @Test
    fun `a bind queued behind a held permit fails fast with BUSY and leaks nothing`() = runBlocking<Unit> {
        val http = http()
        val holder = async { http.get("/hold") }
        withTimeout(10_000) { started.await() }

        val began = System.nanoTime()
        val failure = assertFailsWith<FetchException> { withContext(PermitWait(150)) { http.get("/x") } }
        val waitedMillis = (System.nanoTime() - began) / 1_000_000
        assertEquals("BUSY", failure.code)
        assertTrue(waitedMillis in 100..5_000, "failed after its limit, not at once and not for ever (waited $waitedMillis ms)")

        gate.complete(Unit)
        holder.await()
        withTimeout(10_000) { http.get("/x") } // the timed-out waiter took no permit with it
    }

    @Test
    fun `a bind gets the permit when it frees within its limit`() = runBlocking<Unit> {
        val http = http()
        val holder = async { http.get("/hold") }
        withTimeout(10_000) { started.await() }
        val release = async { delay(100); gate.complete(Unit) }
        withContext(PermitWait(5_000)) { http.get("/x") }
        release.await()
        holder.await()
    }

    @Test
    fun `the time queued for the first permit is charged to the call's deadline`() = runBlocking<Unit> {
        val http = http(deadlineMillis = 300)
        val holder = async { http.get("/hold") }
        withTimeout(10_000) { started.await() }

        val began = System.nanoTime()
        val failure = assertFailsWith<FetchException> { http.get("/x") }
        val waitedMillis = (System.nanoTime() - began) / 1_000_000
        assertEquals("TIMEOUT", failure.code, "a call without an interactive limit times out on its own deadline")
        assertTrue(waitedMillis in 250..5_000, "it waited its deadline, not for ever (waited $waitedMillis ms)")

        gate.complete(Unit)
        holder.await()
    }
}
