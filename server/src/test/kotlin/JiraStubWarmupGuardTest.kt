package ch.nokillswit

import java.io.File
import kotlin.test.Test
import kotlin.test.assertTrue

/**
 * The first start of the shared [JiraStubServer] loads ~1,400 mappings and bodies; a test class whose first test paid that INSIDE
 * `testApplication` would meet Ktor's hard 60 s limit on a slow runner (`UncompletedCoroutinesError`). The rule is mechanical:
 *
 * - a test class (`*Test.kt`) that reads the stub (`JiraStubServer.` or `JiraStubFixture.` beyond the warm-up call itself) must warm it in
 *   a `@BeforeClass` - `JiraStubFixture.warm()` within [WINDOW] lines of the annotation;
 * - a helper file (not `*Test.kt`) may not hide such a read, except the two fixture files, or its callers would escape the first rule.
 *
 * Flow's `StubFixtureWarmupGuardTest` is the donor; its database-backed `SyncedStubFixture` triggers do not exist here.
 */
class JiraStubWarmupGuardTest {
    private fun sources(): Map<String, List<String>> {
        val root = listOf("src/test/kotlin", "server/src/test/kotlin").map(::File).firstOrNull { it.exists() }
            ?: error("server test sources not found from ${File(".").absolutePath}")
        return root.walkTopDown().filter { it.isFile && it.extension == "kt" }
            .associate { it.relativeTo(root).invariantSeparatorsPath to it.readLines() }
    }

    private fun reads(lines: List<String>) = lines.any { !COMMENT.matches(it) && READ.containsMatchIn(it) }

    private fun warmsInBeforeClass(lines: List<String>): Boolean = lines.indices.any { i ->
        !COMMENT.matches(lines[i]) && BEFORE_CLASS.containsMatchIn(lines[i]) &&
            lines.subList(i, minOf(i + WINDOW, lines.size)).any { WARM.containsMatchIn(it) && !COMMENT.matches(it) }
    }

    @Test
    fun `a class that reads the Jira stub warms it in a BeforeClass`() {
        val sources = sources()
        assertTrue(sources.size > MIN_FILES, "expected the server test sources, found ${sources.size} files")
        val unwarmed = sources.filter { (path, lines) ->
            path.endsWith("Test.kt") && path != THIS_FILE && reads(lines) && !warmsInBeforeClass(lines)
        }.keys
        assertTrue(
            unwarmed.isEmpty(),
            "these classes read the shared Jira stub but do not warm it in a @BeforeClass, so their first test in a fork pays the " +
                "one-time WireMock start INSIDE testApplication's hard 60 s limit - add: companion object { @JvmStatic @BeforeClass " +
                "fun warmStub() { JiraStubFixture.warm() } } (import org.junit.BeforeClass): ${unwarmed.sorted()}",
        )
    }

    @Test
    fun `a helper file does not hide a read of the Jira stub from the classes that use it`() {
        val hidden = sources().filter { (path, lines) -> !path.endsWith("Test.kt") && path !in FIXTURE_FILES && reads(lines) }.keys.sorted()
        assertTrue(
            hidden.isEmpty(),
            "these helper files touch JiraStubServer/JiraStubFixture, so every test class using them would start the stub unwarmed and " +
                "escape the BeforeClass rule: move the read into the test class (or extend READ and FIXTURE_FILES here): $hidden",
        )
    }

    private companion object {
        const val MIN_FILES = 100
        const val WINDOW = 4
        const val THIS_FILE = "JiraStubWarmupGuardTest.kt"
        val FIXTURE_FILES = setOf("JiraStubServer.kt", "JiraStubFixture.kt")
        val COMMENT = Regex("""^\s*(?:\*|//|/\*).*""")
        val READ = Regex("""\bJiraStub(?:Server|Fixture)\.""")
        val WARM = Regex("""\bJiraStubFixture\.warm\(\)""")
        val BEFORE_CLASS = Regex("""@(?:[\w.]+\.)?BeforeClass\b""")
    }
}
