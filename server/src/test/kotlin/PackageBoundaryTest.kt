package ch.nokillswit

import java.io.File
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

/**
 * The one-way package layering (CLAUDE.md "Package layout", checkup D5): everything under `infra/` is the foundation every feature
 * builds on, so it never references a feature package (`teams`, `people`, `planning`, `users`, `auth`, `authz`, `telemetry`, `jira`,
 * `sync`).
 * `audit` (the cross-cutting audit trail) and `plugins` (Ktor wiring: `respondProblem`) are not features and stay open to `infra`.
 * The composition root is the one documented exception ([infraCompositionRoot]): the DB/bootstrap wiring MUST construct the
 * feature services it publishes on
 * `Application.attributes` (`Bootstrap.kt` also registers the `jira` service with the encryption-at-rest backfill), so exactly those two
 * files may name exactly those packages. `telemetry/` is the top layer (an observer of
 * every lower one): nothing else names it. A plain source scan (no Docker, no classpath tricks): any non-comment line of a file in
 * the lower package that mentions an upper package by its qualified name (an import, a wildcard import or an inline reference) is a
 * violation.
 *
 * Flow's connector-side rules (`ingest`/`norm`/`jira`/`gitlab` never reach `metrics`/`reports`, `fetch` reaches only `infra`) came with
 * those packages and are ported with them.
 */
class PackageBoundaryTest {
    private val mainSources: List<File> by lazy {
        val root = File(System.getProperty("repo.root") ?: "..", "server/src/main/kotlin")
        assertTrue(root.isDirectory, "${root.absolutePath} not found")
        root.walkTopDown().filter { it.isFile && it.extension == "kt" }.toList()
    }

    /**
     * Composition-root exceptions to "infra never references a feature": `infra/db/Database.kt` builds and publishes the feature
     * services (`teams`, `people`, `planning`, `users`, `auth`, `jira`, `sync`) and `infra/db/Bootstrap.kt` seeds the admin through
     * `users`/`auth`. Keyed by file name,
     * valued by the feature packages that file may import;
     * a listed package the file no longer uses fails the test (a stale exception is dead permission).
     */
    private val infraCompositionRoot: Map<String, Set<String>> = mapOf(
        "Database.kt" to setOf("auth", "jira", "people", "planning", "sync", "teams", "users"),
        "Bootstrap.kt" to setOf("auth", "jira", "users"),
    )

    private val featurePackages = listOf(
        "teams", "people", "planning", "users", "auth", "authz", "telemetry", "jira", "sync",
    )

    private fun packageOf(text: String): String? =
        text.lineSequence().firstOrNull { it.startsWith("package ") }?.removePrefix("package ")?.trim()

    private fun isComment(line: String): Boolean = line.trimStart().let { it.startsWith("//") || it.startsWith("*") || it.startsWith("/*") }

    /** `line number: line` of every code line in [text] that names one of [forbidden] (`metrics`, `reports`, ...) by qualified package. */
    private fun forbiddenReferences(text: String, forbidden: List<String>): List<String> {
        val pattern = Regex("""\bch\.nokillswit\.(${forbidden.joinToString("|")})\b""")
        return text.lineSequence().withIndex()
            .filter { (_, line) -> !isComment(line) && pattern.containsMatchIn(line) }
            .map { (index, line) -> "${index + 1}: ${line.trim()}" }
            .toList()
    }

    @Test
    fun `no package outside telemetry references telemetry`() {
        // telemetry/ is the top layer (an observer of every lower one): it reaches `plugins` and `infra/db` through attribute
        // keys, so those seams never name it. The scan must see the package, or an empty result proves nothing.
        assertTrue(mainSources.any { packageOf(it.readText()) == "ch.nokillswit.telemetry" }, "no source declares ch.nokillswit.telemetry")
        val violations = mainSources.flatMap { file ->
            val text = file.readText()
            if (packageOf(text) == "ch.nokillswit.telemetry") {
                emptyList()
            } else {
                forbiddenReferences(text, listOf("telemetry")).map { "${file.name} $it" }
            }
        }
        assertEquals(emptyList(), violations)
    }

    private fun infraSources(): List<Pair<File, String>> = mainSources.mapNotNull { file ->
        val text = file.readText()
        if (packageOf(text)?.startsWith("ch.nokillswit.infra") == true) file to text else null
    }

    @Test
    fun `infra never references a feature package outside the composition root`() {
        val infra = infraSources()
        assertTrue(infra.size > 20, "the scan saw only ${infra.size} infra sources")
        val violations = infra.flatMap { (file, text) ->
            val allowed = infraCompositionRoot[file.name].orEmpty()
            forbiddenReferences(text, featurePackages - allowed).map { "${file.name} $it" }
        }
        assertEquals(emptyList(), violations)
    }

    @Test
    fun `every composition-root exception is still used`() {
        val infra = infraSources().associate { (file, text) -> file.name to text }
        for ((name, allowed) in infraCompositionRoot) {
            val text = infra[name] ?: error("composition-root file $name is not under infra/")
            for (pkg in allowed) {
                assertTrue(forbiddenReferences(text, listOf(pkg)).isNotEmpty(), "$name no longer references $pkg: drop the exception")
            }
        }
    }

    @Test
    fun `the scan flags imports, wildcard imports and inline references but not comments`() {
        val source = """
            package ch.nokillswit.infra

            import ch.nokillswit.teams.TeamService
            import ch.nokillswit.users.*
            // import ch.nokillswit.teams.InComment
             * ch.nokillswit.users.InKdoc
            val x = ch.nokillswit.teams.Other()
            import ch.nokillswit.teamsx.NotThePackage
        """.trimIndent()
        assertEquals(
            listOf(
                "3: import ch.nokillswit.teams.TeamService",
                "4: import ch.nokillswit.users.*",
                "7: val x = ch.nokillswit.teams.Other()",
            ),
            forbiddenReferences(source, listOf("teams", "users")),
        )
    }
}
