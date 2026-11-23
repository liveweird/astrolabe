package ch.nokillswit

import java.io.File
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

/**
 * Real-time waits in the server tests (`Thread.sleep(`, `delay(`) are a cost on every run and a flake waiting for a slow runner, so
 * they may not regrow (1.26 T4): a wait for "the thing under test has reached state X" is a signal (`CompletableDeferred`,
 * `awaitLockWait`), a bounded poll of an external observable (`awaitUntil`), or a backdated stamp, never a guessed pause.
 *
 * A plain source scan of `server/src/test/kotlin` (comment lines and trailing `//` comments are ignored; this file is skipped). A call
 * is any `Thread.sleep(`, `.sleep(` or `delay(`, whatever its argument. Every file that still waits is listed in [ALLOWED] with how many
 * calls it has and WHY the wait is the test (or the harness) itself. The ratchet is exact, like `SourceFileSizeTest`: a file with
 * MORE calls than listed fails (a new sleep, or an unlisted file), a file with FEWER fails too ("lower the count" or "delete the
 * entry"), so the list can only shrink. Adding an entry or raising a count is a reviewed exception that must justify itself here.
 */
class TestSleepGuardTest {
    private val sleepCall = Regex("""(?:\.sleep|\bdelay)\(""")

    private fun callsPerFile(): Map<String, Int> {
        val root = File(System.getProperty("repo.root") ?: "..", "server/src/test/kotlin")
        assertTrue(root.isDirectory, "${root.absolutePath} not found")
        val sources = root.walkTopDown().filter { it.isFile && it.extension == "kt" && it.name != "TestSleepGuardTest.kt" }.toList()
        assertTrue(sources.size > MIN_FILES, "expected the server test sources, found ${sources.size} files")
        return sources.associate { it.relativeTo(root).invariantSeparatorsPath to countCalls(it) }.filterValues { it > 0 }
    }

    private fun countCalls(file: File): Int = file.readLines().sumOf { line ->
        val code = line.trim()
        val comment = code.startsWith("//") || code.startsWith("*") || code.startsWith("/*")
        if (comment) 0 else sleepCall.findAll(code.substringBefore(" //")).count()
    }

    @Test
    fun `no test source sleeps outside the allow-list`() {
        val calls = callsPerFile()
        val unlisted = calls.filter { (file, count) -> count > (ALLOWED[file]?.calls ?: 0) }
            .map { (file, count) -> "$file: $count call(s), allowed ${ALLOWED[file]?.calls ?: 0}" }
        assertTrue(
            unlisted.isEmpty(),
            "replace the wait with a signal, awaitLockWait, awaitUntil or a backdated stamp (see this test's KDoc): $unlisted",
        )
    }

    @Test
    fun `every allow-list entry still sleeps exactly as often as it says`() {
        val calls = callsPerFile()
        val stale = ALLOWED.filter { (file, allowed) -> (calls[file] ?: 0) < allowed.calls }
            .map { (file, allowed) -> "$file: ${calls[file] ?: 0} call(s), listed ${allowed.calls}" }
        assertTrue(stale.isEmpty(), "the list only shrinks: lower the count or delete the entry for $stale")
    }

    @Test
    fun `every allow-list entry names a file and a reason`() {
        assertTrue(ALLOWED.isNotEmpty())
        ALLOWED.forEach { (file, allowed) ->
            assertTrue(file.endsWith(".kt") && allowed.calls > 0, "$file: a Kotlin file and a positive count")
            assertTrue(allowed.why.length > MIN_REASON, "$file: say why this wait cannot be a signal")
        }
        assertEquals(ALLOWED.keys.toList(), ALLOWED.keys.sorted(), "keep the list sorted by file")
    }

    private class Allowed(val calls: Int, val why: String)

    private companion object {
        const val MIN_FILES = 100
        const val MIN_REASON = 20

        /** File (under `server/src/test/kotlin`) -> how many wait calls it keeps and why. Only ever shrinks. */
        val ALLOWED: Map<String, Allowed> = mapOf(
            "ConnectionPoolTest.kt" to Allowed(
                3,
                "two 100 ms polls of pg_stat_activity until a pool's backends are gone, and the 50 ms pace of the saturation observation " +
                    "loop: the observable is a database catalog, no signal exists",
            ),
            "GcTestSupport.kt" to Allowed(1, "pauses between forced GCs: a weak reference clears when the collector says, not on a signal"),
            "JiraImportSupport.kt" to Allowed(
                1,
                "outlastDeadline(): a scripted handler that outlives a test's short deadline; the deadline or a cancellation ends it",
            ),
            "LatencyCollectorTest.kt" to Allowed(1, "the synthetic route's handler delay IS the latency the collector is measuring"),
            "LeakedSocketGuardTest.kt" to Allowed(
                3,
                "a 100 ms poll for a backend to end; a 300 ms settle to prove the unguarded driver LEAKS (a negative proof); and the " +
                    "idle-in-transaction wait, which is the server-side timeout under test",
            ),
            "PermitContentionTest.kt" to Allowed(
                1,
                "releases the held permit 100 ms after a bind queued behind it; a queued permit waiter has no observable to await, and " +
                    "the class documents that a virtual clock cannot expire a suspended acquire",
            ),
            "PooledConnectionPinTest.kt" to Allowed(1, "a deadline poll of the pool's own acquired-size metric (no signal)"),
            "ProbeRunTest.kt" to Allowed(1, "a probe body that outlasts its 50 ms probe timeout; the timeout cancels it"),
            "RequestAsTest.kt" to Allowed(
                1,
                "keeps a transform inside the big-parse lock for 50 ms so a second call WOULD overlap it if the lock were free",
            ),
            "RequestReadTimeoutTest.kt" to Allowed(
                3,
                "a raw client that idles or trickles bytes IS the slow-loris the read timeout is tested against",
            ),
            "SharedPauseTest.kt" to Allowed(1, "a 5 ms bounded poll of the pause's own state, which has no signal"),
            "ShutdownAuditProbe.kt" to Allowed(
                1,
                "stands in for the release round-trip of the child process's shutdown path, which the test orders around",
            ),
            "ShutdownAuditTest.kt" to Allowed(
                2,
                "a later ApplicationStopped handler that must run LONGER than a prematurely released hook would need, and the bounded " +
                    "poll for that hook to park on the stop latch (a thread state has no signal)",
            ),
            "SourceHttpHeadersTest.kt" to Allowed(
                1,
                "a negative proof: the second call must STAY queued behind the only permit, which only elapsed time can show",
            ),
            "StatementTimeoutAnswerTest.kt" to Allowed(1, "the lock cap: a limit that is not enforced fails instead of hanging the fork"),
            "TestAwait.kt" to Allowed(1, "awaitUntil: the one bounded poll tests share (10 ms), ending the moment the condition holds"),
            "TestEnvironment.kt" to Allowed(
                2,
                "awaitEvent (log capture) and awaitLockWait (pg_stat_activity): the shared bounded polls, 50 ms, ending as soon as true",
            ),
        )
    }
}
