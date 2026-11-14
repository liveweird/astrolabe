package ch.nokillswit

import java.io.File
import kotlin.test.Test
import kotlin.test.assertTrue

/**
 * The server gate runs beside the user's compose stack, whose `astrolabe-jira-stub` holds 127.0.0.1:8096 (`ci.md`, `build-times.md`
 * "Investigation log"): nothing in the suite may bind a FIXED port, or a gate run would collide with whatever listens there. The pin is a
 * source scan, no Docker:
 *
 * - [StubServer] (the shared in-JVM WireMock base of the Jira and Flow stubs) configures `dynamicPort()` and never `port(<number>)`;
 * - no other test source constructs a WireMock server of its own (it would not inherit the dynamic port);
 * - no test source opens a `ServerSocket` on a literal port other than `0` (the OS picks).
 *
 * The `8096` literals of `JiraBootTest` and `JiraClientTest` are strings for a host that is never dialled, not sockets: not scanned.
 */
class StubPortGuardTest {
    private val root: File = File(System.getProperty("repo.root") ?: "..", "server/src/test/kotlin")

    private fun sources(): Map<String, List<String>> {
        assertTrue(root.isDirectory, "server test sources not found at ${root.absolutePath}")
        return root.walkTopDown().filter { it.isFile && it.extension == "kt" }
            .associate { it.relativeTo(root).invariantSeparatorsPath to it.readLines() }
            .filterKeys { it != THIS_FILE }
    }

    private fun code(lines: List<String>) = lines.filterNot { COMMENT.matches(it) }

    @Test
    fun `the shared stub server takes a dynamic port and never a fixed one`() {
        val sources = sources()
        assertTrue(sources.size > MIN_FILES, "expected the server test sources, found ${sources.size} files")
        val stub = code(sources[STUB_SERVER] ?: error("$STUB_SERVER not found under ${root.absolutePath}"))
        assertTrue(stub.any { DYNAMIC_PORT.containsMatchIn(it) }, "$STUB_SERVER must configure the WireMock with .dynamicPort()")
        val fixed = stub.filter { FIXED_PORT.containsMatchIn(it) }
        assertTrue(
            fixed.isEmpty(),
            "$STUB_SERVER must not fix a port (the gate runs beside the compose stack's jira-stub on 8096) - use .dynamicPort(): $fixed",
        )
    }

    @Test
    fun `no other test source constructs a WireMock server of its own`() {
        val own = sources().filter { (path, lines) -> path != STUB_SERVER && code(lines).any { OWN_WIREMOCK.containsMatchIn(it) } }.keys
        assertTrue(
            own.isEmpty(),
            "these files construct a WireMock server outside StubServer, so they would not inherit its dynamic port: " +
                "extend StubServer (or add the stub there): ${own.sorted()}",
        )
    }

    @Test
    fun `no test source opens a server socket on a literal port other than zero`() {
        val fixed = sources().mapValues { (_, lines) -> code(lines).filter { isFixedSocket(it) } }.filterValues { it.isNotEmpty() }
        assertTrue(
            fixed.isEmpty(),
            "these test sources bind a fixed port, which collides with a running stack: pass 0 and read the chosen port back: $fixed",
        )
    }

    @Test
    fun `the scan recognises what it forbids`() {
        assertTrue(FIXED_PORT.containsMatchIn("WireMockConfiguration.options().port(8096)"))
        assertTrue(FIXED_PORT.containsMatchIn("    .httpsPort(8443)"))
        assertTrue(!FIXED_PORT.containsMatchIn("val client = WireMock(server.port())"))
        assertTrue(OWN_WIREMOCK.containsMatchIn("val s = WireMockServer(options().dynamicPort())"))
        assertTrue(isFixedSocket("ServerSocket(8096).use { }"))
        assertTrue(isFixedSocket("java.net.ServerSocket( 9000, 5 )"))
        assertTrue(!isFixedSocket("ServerSocket(0).use { it.localPort }"))
        assertTrue(!isFixedSocket("ServerSocket( 0 )"))
    }

    private fun isFixedSocket(line: String): Boolean =
        SOCKET.findAll(line).any { it.groupValues[1].toLong() != 0L }

    private companion object {
        const val MIN_FILES = 100
        const val STUB_SERVER = "StubServer.kt"
        const val THIS_FILE = "StubPortGuardTest.kt"
        val COMMENT = Regex("""^\s*(?:\*|//|/\*).*""")
        val DYNAMIC_PORT = Regex("""\.dynamicPort\(\)""")

        /** A configured, fixed port: `.port(8096)` / `.httpsPort(8443)` - a call WITH an argument (`server.port()` reads it back). */
        val FIXED_PORT = Regex("""\.(?:port|httpsPort|adminPort)\(\s*[^)\s]""", RegexOption.IGNORE_CASE)
        val OWN_WIREMOCK = Regex("""\bWireMock(?:Server|Rule|ClassRule)\s*\(|\bWireMockExtension\b""")

        /** `ServerSocket(<number>`: group 1 is a literal port (an expression or no argument binds nothing fixed the scan can name). */
        val SOCKET = Regex("""\bServerSocket\(\s*(\d+)""")
    }
}
