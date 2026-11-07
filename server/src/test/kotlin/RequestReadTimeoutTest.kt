package ch.nokillswit

import io.ktor.server.netty.EngineMain
import io.ktor.server.testing.testApplication
import java.net.Socket
import java.net.SocketTimeoutException
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull
import kotlin.test.assertTrue
import kotlinx.coroutines.runBlocking

/**
 * The Netty request-read timeout (`ktor.deployment.requestReadTimeoutSeconds`, `$REQUEST_READ_TIMEOUT_SECONDS`;
 * `.claude/docs/security.md` "Slow requests"). `testApplication` never runs Netty, so the behaviour tests boot the REAL
 * application through `EngineMain.createServer` (the shipped `mainClass`), which is what reads the key from
 * `application.yaml` — on an ephemeral port with a one-second timeout, and speak raw HTTP over a socket.
 */
class RequestReadTimeoutTest {

    @Test
    fun `the default timeout is 60 seconds`() = testApplication {
        configureApp()
        startApplication()
        assertEquals("60", application.environment.config.property(KEY).getString())
    }

    @Test
    fun `an out-of-range timeout refuses to start naming the key, zero (off) is accepted`() {
        listOf("-1", "3601", "abc").forEach { bad ->
            testApplication {
                configureApp(KEY to bad)
                assertStartupFails("Config \"$KEY\"") { startApplication() }
            }
        }
        testApplication {
            configureApp(KEY to "0")
            startApplication()
        }
    }

    @Test
    fun `a non-numeric timeout fails the real EngineMain boot too`() {
        // EngineMain parses the key with a bare toInt() before any module runs, so the message names the value, not the key.
        val failure = runCatching { withRealEngine(timeoutSeconds = "abc") { } }.exceptionOrNull()
        assertTrue(
            generateSequence(failure) { it.cause }.any { it is NumberFormatException },
            "a non-numeric timeout must refuse startup with a NumberFormatException, got: $failure",
        )
    }

    @Test
    fun `a stalled request body is answered 408 and the connection closed within the timeout, without error noise`() {
        withRealEngine(timeoutSeconds = 1) { port ->
            // Attached after the boot: startup legitimately WARNs (dev JWT secret, log mail transport) and shutdown ERRORs inside Netty.
            val logs = LogCapture(org.slf4j.Logger.ROOT_LOGGER_NAME)
            try {
                Socket("127.0.0.1", port).use { socket ->
                    socket.soTimeout = SOCKET_WAIT_MS
                    socket.send(slowBodyHead() + "{\"em")
                    val startedAt = System.nanoTime()
                    val reply = socket.readUntilClosed()
                    val elapsedMs = (System.nanoTime() - startedAt) / NANOS_PER_MS
                    assertTrue(reply.startsWith("HTTP/1.1 408"), "expected 408, got: ${reply.take(MAX_ECHO)}")
                    assertTrue(elapsedMs in MIN_FIRE_MS..MAX_FIRE_MS, "answered after $elapsedMs ms, expected about 1000")
                }
                // The cancelled call is handled asynchronously: wait for its one INFO line, then check nothing louder came with it.
                val info = runBlocking { logs.awaitEvent { it.formattedMessage.startsWith("Request timed out waiting for bytes (408)") } }
                assertTrue(info != null && info.level == ch.qos.logback.classic.Level.INFO, "the timeout's INFO line is missing")
                val loud = logs.events.filter { it.level.isGreaterOrEqual(ch.qos.logback.classic.Level.WARN) }
                assertTrue(loud.isEmpty(), "a read-timeout 408 logged: ${loud.map { it.formattedMessage.take(MAX_ECHO) }}")
            } finally {
                logs.detach()
            }
        }
    }

    /**
     * KNOWN LIMITATION, pinned: Ktor's `KtorReadTimeoutHandler` fires its exception ONCE per connection. If the connection sits
     * idle past the timeout with no request open, that one firing is spent, and a request that then stalls on the same
     * connection is never cut. If Ktor fixes this the test fails: update `security.md` "Slow requests" and drop the BACKLOG item.
     */
    @Test
    fun `known limitation - a request stalled after the connection idled past the timeout is not cut`() {
        withRealEngine(timeoutSeconds = 1) { port ->
            Socket("127.0.0.1", port).use { socket ->
                socket.soTimeout = SOCKET_WAIT_MS
                socket.send("GET /api/v1/health HTTP/1.1\r\nHost: localhost\r\n\r\n")
                assertTrue(socket.readResponse().startsWith("HTTP/1.1 200"))
                Thread.sleep(IDLE_AFTER_FIRST_MS)
                socket.send(slowBodyHead().replace("Connection: close\r\n", "") + "{\"em")
                assertNull(socket.pollReply(STALL_OBSERVE_MS), "Ktor now cuts a stall after an idle period: update security.md")
            }
        }
    }

    @Test
    fun `the timeout is an idle-gap bound - a body trickled faster than the gap is not cut off`() {
        withRealEngine(timeoutSeconds = TRICKLE_TIMEOUT_SECONDS) { port ->
            Socket("127.0.0.1", port).use { socket ->
                socket.soTimeout = SOCKET_WAIT_MS
                socket.send(slowBodyHead())
                // Eight bytes, 0.3 s apart: 2.4 s in total, longer than the 2 s timeout, but no gap comes near it.
                repeat(TRICKLE_BYTES) {
                    Thread.sleep(TRICKLE_GAP_MS)
                    socket.send("x")
                    assertNull(socket.pollReply(), "the connection was cut during a trickle that never idled for the timeout")
                }
            }
        }
    }

    @Test
    fun `an ordinary request is unaffected`() {
        withRealEngine(timeoutSeconds = 1) { port ->
            Socket("127.0.0.1", port).use { socket ->
                socket.soTimeout = SOCKET_WAIT_MS
                socket.send("GET /api/v1/health HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n")
                val reply = socket.readUntilClosed()
                assertTrue(reply.startsWith("HTTP/1.1 200"), "expected 200, got: ${reply.take(MAX_ECHO)}")
            }
        }
    }

    @Test
    fun `an idle keep-alive connection between requests is not closed by the timeout`() {
        withRealEngine(timeoutSeconds = 1) { port ->
            Socket("127.0.0.1", port).use { socket ->
                socket.soTimeout = SOCKET_WAIT_MS
                val get = "GET /api/v1/health HTTP/1.1\r\nHost: localhost\r\n\r\n"
                socket.send(get)
                val first = socket.readResponse()
                assertTrue(first.startsWith("HTTP/1.1 200"), "first request failed: ${first.take(MAX_ECHO)}")
                // Two timeouts of silence with no request open: Ktor only answers 408 for an OPEN call.
                Thread.sleep(IDLE_MS)
                socket.send(get)
                val second = socket.readResponse()
                assertTrue(second.startsWith("HTTP/1.1 200"), "the idle connection was dropped: ${second.take(MAX_ECHO)}")
            }
        }
    }

    /** A login POST that promises a body of [BODY_LENGTH] bytes, headers complete. */
    private fun slowBodyHead() =
        "POST /api/v1/login HTTP/1.1\r\nHost: localhost\r\nContent-Type: application/json\r\n" +
            "Content-Length: $BODY_LENGTH\r\nConnection: close\r\n\r\n"

    private fun Socket.send(text: String) {
        getOutputStream().write(text.toByteArray())
        getOutputStream().flush()
    }

    /** Reads to EOF (the server closes after the 408); a read stall past the socket timeout fails the test. */
    private fun Socket.readUntilClosed(): String = getInputStream().readBytes().decodeToString()

    /** One whole HTTP/1.1 response: the head up to the blank line, then `Content-Length` body bytes (the health answers carry one). */
    private fun Socket.readResponse(): String {
        val input = getInputStream()
        val head = StringBuilder()
        while (!head.endsWith("\r\n\r\n")) {
            val b = input.read()
            check(b >= 0) { "connection closed mid-response: ${head.take(MAX_ECHO)}" }
            head.append(b.toChar())
        }
        val length = Regex("(?i)content-length: *(\\d+)").find(head)?.groupValues?.get(1)?.toInt() ?: 0
        return head.toString() + input.readNBytes(length).decodeToString()
    }

    /** The reply bytes if any arrive within a short wait, else null. */
    private fun Socket.pollReply(waitMs: Int = POLL_MS): String? {
        val previous = soTimeout
        soTimeout = waitMs
        return try {
            val buffer = ByteArray(MAX_ECHO)
            val n = getInputStream().read(buffer)
            if (n < 0) "" else String(buffer, 0, n)
        } catch (_: SocketTimeoutException) {
            null
        } finally {
            soTimeout = previous
        }
    }

    /** Boots the real app on Netty (ephemeral port, shared test database) with the given read timeout. */
    private fun withRealEngine(timeoutSeconds: Any, block: (port: Int) -> Unit) {
        val args = arrayOf(
            "-P:ktor.deployment.port=0",
            "-P:$KEY=$timeoutSeconds",
            "-P:postgres.jdbcUrl=${PostgresTestSupport.jdbcUrl}",
            "-P:postgres.r2dbcUrl=${PostgresTestSupport.r2dbcUrl}",
            "-P:postgres.user=${PostgresTestSupport.user}",
            "-P:postgres.password=${PostgresTestSupport.password}",
            "-P:mail.appUrl=https://localhost:8086",
            "-P:telemetry.enabled=false",
            "-P:sync.scheduler.enabled=false",
        )
        val server = EngineMain.createServer(args)
        server.start(wait = false)
        try {
            block(runBlocking { server.engine.resolvedConnectors() }.first().port)
        } finally {
            server.stop(0, 0)
        }
    }

    private companion object {
        const val KEY = "ktor.deployment.requestReadTimeoutSeconds"
        const val BODY_LENGTH = 200
        const val SOCKET_WAIT_MS = 10_000
        const val NANOS_PER_MS = 1_000_000L
        const val MIN_FIRE_MS = 700L
        const val MAX_FIRE_MS = 4_000L
        const val TRICKLE_BYTES = 8
        const val TRICKLE_GAP_MS = 300L
        const val TRICKLE_TIMEOUT_SECONDS = 2
        const val IDLE_AFTER_FIRST_MS = 1_500L
        const val STALL_OBSERVE_MS = 2_500
        const val POLL_MS = 50
        const val IDLE_MS = 2_200L
        const val MAX_ECHO = 200
    }
}
