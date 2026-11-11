package ch.nokillswit

import java.io.File
import kotlin.test.Test
import kotlin.test.assertTrue

/**
 * Pins the launch path of the re-armed read timeout (`plugins/ReadTimeout.kt`, `security.md` "Slow requests"): the launcher's
 * `mainClass` must be `MainKt` (Ktor's `EngineMain` would silently drop the fix) and `main` must go through `createServer(`.
 * Pure file parsing, like `JvmMemoryFlagsTest`.
 */
class LaunchPathTest {
    private val repoRoot = File(System.getProperty("repo.root") ?: "..")

    private fun text(path: String): String {
        val file = File(repoRoot, path)
        assertTrue(file.isFile, "${file.absolutePath} not found")
        return file.readText()
    }

    @Test
    fun `the launcher's mainClass is MainKt`() {
        val mainClass = Regex("""(?m)^\s*mainClass\s*=\s*"([^"]+)"""").find(text("server/build.gradle.kts"))
        assertTrue(
            mainClass != null && mainClass.groupValues[1] == "ch.nokillswit.MainKt",
            "mainClass must be ch.nokillswit.MainKt, got: ${mainClass?.value}",
        )
    }

    @Test
    fun `main goes through createServer, which re-arms the read timeout`() {
        val source = text("server/src/main/kotlin/main.kt")
        val body = Regex("""fun main\(args: Array<String>\)\s*\{(.*?)\n\}""", RegexOption.DOT_MATCHES_ALL).find(source)
        assertTrue(body != null && body.groupValues[1].contains("createServer("), "main must call createServer(args)")
        assertTrue(source.contains("rearmReadTimeout()"), "createServer must call rearmReadTimeout()")
    }
}
