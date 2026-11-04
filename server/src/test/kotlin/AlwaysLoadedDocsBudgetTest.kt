package ch.nokillswit

import java.io.File
import kotlin.test.Test
import kotlin.test.assertTrue

/**
 * Keeps the always-loaded instruction set inside its size budget. `CLAUDE.md` imports docs with bare `@path` lines, so
 * `CLAUDE.md` and every file it imports are in every session's context; together they must stay under [BUDGET_BYTES]
 * bytes (the promise `CLAUDE.md` makes in its "Cross-cutting conventions" section). The file list is derived from those
 * `@` lines. `scripts/check-docs-budget.mjs` derives the same list and reads [BUDGET_BYTES] from this source, so CI's
 * `e2e-static` job (which a Markdown-only PR does not skip, unlike `server`) enforces the same number.
 */
class AlwaysLoadedDocsBudgetTest {
    private fun locate(vararg candidates: String): File =
        candidates.map(::File).firstOrNull { it.exists() }
            ?: error("none of ${candidates.toList()} found from ${File(".").absolutePath}")

    @Test
    fun `CLAUDE_md plus its two imported docs stay under the always-loaded byte budget`() {
        val claude = locate("CLAUDE.md", "../CLAUDE.md")
        val imports = claude.readLines().mapNotNull { IMPORT_LINE.matchEntire(it)?.groupValues?.get(1) }
        assertTrue(imports.isNotEmpty(), "no `@` import lines found in CLAUDE.md")
        val files = listOf(claude) + imports.map { locate(it, "../$it") }
        val sizes = files.associate { it.name to it.length() }
        val total = sizes.values.sum()
        assertTrue(
            total < BUDGET_BYTES,
            "the always-loaded set is $total bytes ($sizes), the budget is $BUDGET_BYTES. Measure with " +
                "`wc -c CLAUDE.md .claude/docs/testing.md .claude/docs/list-endpoints.md`. Detail belongs in an " +
                "on-demand doc under .claude/docs/ (read on demand, not imported), leaving a one-line pointer here.",
        )
    }

    private companion object {
        const val BUDGET_BYTES = 36_000
        val IMPORT_LINE = Regex("""^@(\S+)$""")
    }
}
