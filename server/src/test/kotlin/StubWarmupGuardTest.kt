package ch.nokillswit

import java.io.File
import kotlin.test.Test
import kotlin.test.assertTrue

/**
 * The first start of a shared stub server ([JiraStubServer]: ~2,300 mappings; [FlowStubServer]: a handful, but a 130 KB document)
 * pays WireMock's, Jetty's and the matcher's cold paths; a test class whose first test paid that INSIDE `testApplication` would meet
 * Ktor's hard 60 s limit on a slow runner (`UncompletedCoroutinesError`). The rule is mechanical, per stub:
 *
 * - a test class (`*Test.kt`) that reads the stub (`JiraStubServer.` / `JiraStubFixture.` or `FlowStubServer.` / `FlowStubFixture.`
 *   beyond the warm-up call itself) must warm it in a `@BeforeClass` - `<Stub>Fixture.warm()` within [WINDOW] lines of the annotation;
 * - a helper file (not `*Test.kt`) may not hide such a read, except the fixture files, or its callers would escape the first rule.
 *
 * Flow's `StubFixtureWarmupGuardTest` is the donor; its database-backed `SyncedStubFixture` triggers do not exist here.
 */
class StubWarmupGuardTest {
    /** One shared stub: its name, the pattern of a read of it, the warm-up call, and the files that are the stub itself. */
    private class Stub(val name: String, val prefix: String, val files: Set<String>) {
        val read = Regex("""\b${prefix}Stub(?:Server|Fixture)\.""")
        val warm = Regex("""\b${prefix}StubFixture\.warm\(\)""")
    }

    private val stubs = listOf(
        Stub("Jira", "Jira", setOf("JiraStubServer.kt", "JiraStubFixture.kt")),
        Stub("Flow", "Flow", setOf("FlowStubServer.kt", "FlowStubFixture.kt")),
    )

    private fun sources(): Map<String, List<String>> {
        val root = listOf("src/test/kotlin", "server/src/test/kotlin").map(::File).firstOrNull { it.exists() }
            ?: error("server test sources not found from ${File(".").absolutePath}")
        return root.walkTopDown().filter { it.isFile && it.extension == "kt" }
            .associate { it.relativeTo(root).invariantSeparatorsPath to it.readLines() }
    }

    private fun reads(stub: Stub, lines: List<String>) = lines.any { !COMMENT.matches(it) && stub.read.containsMatchIn(it) }

    private fun warmsInBeforeClass(stub: Stub, lines: List<String>): Boolean = lines.indices.any { i ->
        !COMMENT.matches(lines[i]) && BEFORE_CLASS.containsMatchIn(lines[i]) &&
            lines.subList(i, minOf(i + WINDOW, lines.size)).any { stub.warm.containsMatchIn(it) && !COMMENT.matches(it) }
    }

    @Test
    fun `a class that reads a shared stub warms it in a BeforeClass`() {
        val sources = sources()
        assertTrue(sources.size > MIN_FILES, "expected the server test sources, found ${sources.size} files")
        for (stub in stubs) {
            val unwarmed = sources.filter { (path, lines) ->
                path.endsWith("Test.kt") && path != THIS_FILE && reads(stub, lines) && !warmsInBeforeClass(stub, lines)
            }.keys
            assertTrue(
                unwarmed.isEmpty(),
                "these classes read the shared ${stub.name} stub but do not warm it in a @BeforeClass, so their first test in a fork " +
                    "pays the one-time WireMock start INSIDE testApplication's hard 60 s limit - add: companion object { @JvmStatic " +
                    "@BeforeClass fun warmStub() { ${stub.prefix}StubFixture.warm() } } (import org.junit.BeforeClass): " +
                    "${unwarmed.sorted()}",
            )
        }
    }

    @Test
    fun `a helper file does not hide a read of a shared stub from the classes that use it`() {
        val sources = sources()
        for (stub in stubs) {
            val hidden = sources.filter { (path, lines) ->
                !path.endsWith("Test.kt") && path !in stub.files && reads(stub, lines)
            }.keys.sorted()
            assertTrue(
                hidden.isEmpty(),
                "these helper files touch ${stub.prefix}StubServer/${stub.prefix}StubFixture, so every test class using them would " +
                    "start the stub unwarmed and escape the BeforeClass rule: move the read into the test class (or extend the " +
                    "stubs and their files here): $hidden",
            )
        }
    }

    private companion object {
        const val MIN_FILES = 100
        const val WINDOW = 4
        const val THIS_FILE = "StubWarmupGuardTest.kt"
        val COMMENT = Regex("""^\s*(?:\*|//|/\*).*""")
        val BEFORE_CLASS = Regex("""@(?:[\w.]+\.)?BeforeClass\b""")
    }
}
