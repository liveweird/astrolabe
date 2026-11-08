// Keeps the always-loaded instruction set inside its size budget (node built-ins only). The list of files is
// CLAUDE.md plus every line of it that is a bare `@path` import; the budget is BUDGET_BYTES, read from the server test
// that enforces the same rule (server/src/test/kotlin/AlwaysLoadedDocsBudgetTest.kt) so the two cannot drift.
// It exists because that test lives in the `server` CI job, which a Markdown-only PR skips; `e2e-static` always runs.
// It also checks web/CLAUDE.md (auto-loaded for every web/ edit) against WEB_CLAUDE_BUDGET_BYTES, read the same way.
// Run from anywhere: node scripts/check-docs-budget.mjs — exits 1 when the total reaches the budget or web/CLAUDE.md exceeds its own.
// Optional first argument: the repo root to measure (defaults to the one this script lives in).
import { readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(process.argv[2] ?? join(dirname(fileURLToPath(import.meta.url)), ".."));
const testSource = readFileSync(join(root, "server/src/test/kotlin/AlwaysLoadedDocsBudgetTest.kt"), "utf8");
const budget = Number(testSource.match(/\bBUDGET_BYTES\s*=\s*([\d_]+)/)?.[1]?.replaceAll("_", ""));
if (!Number.isInteger(budget) || budget <= 0) {
  console.error("check-docs-budget: cannot read BUDGET_BYTES from AlwaysLoadedDocsBudgetTest.kt");
  process.exit(1);
}
const webBudget = Number(testSource.match(/WEB_CLAUDE_BUDGET_BYTES\s*=\s*([\d_]+)/)?.[1]?.replaceAll("_", ""));
if (!Number.isInteger(webBudget) || webBudget <= 0) {
  console.error("check-docs-budget: cannot read WEB_CLAUDE_BUDGET_BYTES from AlwaysLoadedDocsBudgetTest.kt");
  process.exit(1);
}

const claude = readFileSync(join(root, "CLAUDE.md"), "utf8");
const imports = [...claude.matchAll(/^@(\S+)$/gm)].map((m) => m[1]);
if (imports.length === 0) {
  console.error("check-docs-budget: no `@` import lines found in CLAUDE.md");
  process.exit(1);
}

const sizes = {};
for (const f of ["CLAUDE.md", ...imports]) {
  try {
    sizes[f] = statSync(join(root, f)).size;
  } catch {
    console.error(`check-docs-budget: ${f} (imported by CLAUDE.md) does not exist`);
    process.exit(1);
  }
}
const total = Object.values(sizes).reduce((a, b) => a + b, 0);
const nf = new Intl.NumberFormat("en-US");
console.log(`CLAUDE.md + ${imports.length} imports = ${nf.format(total)} of ${nf.format(budget)} bytes`);
if (total >= budget) {
  console.error(
    `the always-loaded set is ${total} bytes (${JSON.stringify(sizes)}), the budget is ${budget}. Detail belongs in an ` +
      "on-demand doc under .claude/docs/ (read on demand, not imported), leaving a one-line pointer in CLAUDE.md.",
  );
  process.exit(1);
}

const webSize = statSync(join(root, "web/CLAUDE.md")).size;
console.log(`web/CLAUDE.md = ${nf.format(webSize)} of ${nf.format(webBudget)} bytes`);
if (webSize > webBudget) {
  console.error(
    `web/CLAUDE.md is ${webSize} bytes, the budget is ${webBudget}. Page mechanics belong in .claude/docs/web-internals.md, ` +
      "leaving the rule and a one-line pointer in web/CLAUDE.md.",
  );
  process.exit(1);
}
