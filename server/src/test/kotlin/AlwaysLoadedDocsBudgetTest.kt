package ch.nokillswit

import java.io.File
import kotlin.test.Test
import kotlin.test.assertTrue

/**
 * Keeps the always-loaded instruction set inside its size budget. `CLAUDE.md` imports docs with bare `@path` lines, so
 * `CLAUDE.md` and every file it imports are in every session's context; together they must stay under [BUDGET_BYTES]
 * bytes (the promise `CLAUDE.md` makes in its "Cross-cutting conventions" section). The file list is derived from those
 * `@` lines. `web/CLAUDE.md` is auto-loaded for every `web/` edit, so it has its own cap, [WEB_CLAUDE_BUDGET_BYTES]: it is
 * the frontend rule set, the page mechanics live in `.claude/docs/web-internals.md`.
 * `scripts/check-docs-budget.mjs` derives the same list and reads both numbers from this source, so CI's
 * `e2e-static` job (which a Markdown-only PR does not skip, unlike `server`) enforces the same limits.
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

    @Test
    fun `web CLAUDE_md stays under its own byte budget`() {
        val webClaude = locate("web/CLAUDE.md", "../web/CLAUDE.md")
        assertTrue(
            webClaude.length() <= WEB_CLAUDE_BUDGET_BYTES,
            "web/CLAUDE.md is ${webClaude.length()} bytes, the budget is $WEB_CLAUDE_BUDGET_BYTES. Measure with " +
                "`wc -c web/CLAUDE.md`. Page mechanics belong in .claude/docs/web-internals.md, leaving the rule " +
                "and a one-line pointer in web/CLAUDE.md.",
        )
    }

    private companion object {
        const val BUDGET_BYTES = 36_000
        const val WEB_CLAUDE_BUDGET_BYTES = 30_000
        val IMPORT_LINE = Regex("""^@(\S+)$""")
    }
}
