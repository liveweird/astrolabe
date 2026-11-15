// The nightly's retry list (checkup 1.23 Q6, plan 1.24 E2): reads Playwright's JSON report (test-results/results.json, written in CI only)
// and prints a Markdown summary of the tests whose outcome is `flaky` (failed, then passed on a retry) and, apart from them, the tests
// that failed for good. e2e.yml appends the output to $GITHUB_STEP_SUMMARY. It is information, never a gate: it ALWAYS exits 0, and a
// missing or unreadable report is one line, because the step must not hide the suite's own verdict.
// Usage: node scripts/flaky-summary.mjs [report.json]   (default: test-results/results.json under e2e/)
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const DEFAULT_REPORT = join(dirname(dirname(fileURLToPath(import.meta.url))), "test-results", "results.json");
const MAX_MESSAGE = 200;
// An attempt that did not end well; "passed" and "skipped" are the others.
const FAILED_ATTEMPT = new Set(["failed", "timedOut", "interrupted"]);
// Playwright colours its error messages with ANSI escapes (built from the ESC code, so the pattern holds no control character).
const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g");

/** Every test of the report, depth first: { file, line, titlePath, test }. */
function* walk(suite, path = []) {
  const here = suite.file !== undefined && suite.title === suite.file ? path : [...path, suite.title];
  for (const spec of suite.specs ?? []) {
    for (const test of spec.tests ?? []) {
      yield { file: spec.file, line: spec.line, title: [...here, spec.title].filter(Boolean).join(" › "), test };
    }
  }
  for (const child of suite.suites ?? []) yield* walk(child, here);
}

/** The first line of the first failed attempt's error, plain text, cut to one table cell. */
function firstFailure(test) {
  const attempt = (test.results ?? []).find((r) => FAILED_ATTEMPT.has(r.status));
  const message = attempt?.error?.message ?? attempt?.errors?.[0]?.message ?? "";
  const line = message.replace(ANSI, "").split("\n").find((l) => l.trim() !== "") ?? "(no error message)";
  const cut = line.trim().length > MAX_MESSAGE ? `${line.trim().slice(0, MAX_MESSAGE)}…` : line.trim();
  return cut.replace(/\|/g, "\\|").replace(/`/g, "'");
}

const byLocation = (a, b) => a.file.localeCompare(b.file) || a.line - b.line;

function table(rows) {
  const lines = ["| Test | Attempts | First failure |", "| --- | ---: | --- |"];
  for (const row of rows) {
    const where = `\`${row.file}:${row.line}\``;
    lines.push(`| ${where} ${row.title.replace(/\|/g, "\\|")} | ${row.test.results?.length ?? 0} | ${firstFailure(row.test)} |`);
  }
  return lines;
}

/** The Markdown for one parsed report. Pure: no file access. */
export function summarize(report) {
  const all = (report.suites ?? []).flatMap((suite) => [...walk(suite)]);
  const flaky = all.filter((t) => t.test.status === "flaky").sort(byLocation);
  const failed = all.filter((t) => t.test.status === "unexpected").sort(byLocation);
  const out = ["## E2E: tests that needed a retry", ""];
  if (flaky.length === 0 && failed.length === 0) {
    out.push(`No test needed a retry (${all.length} tests).`);
    return `${out.join("\n")}\n`;
  }
  out.push(`${all.length} ${all.length === 1 ? "test" : "tests"}: ${flaky.length} flaky (passed on a retry), ${failed.length} failed.`, "");
  if (flaky.length > 0) out.push("### Flaky", "", ...table(flaky), "");
  if (failed.length > 0) out.push("### Failed", "", ...table(failed), "");
  return `${out.join("\n").trimEnd()}\n`;
}

/** The summary for a report file, or the one line that says why there is none. Never throws. */
export function summarizeFile(path) {
  let text;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return "## E2E: tests that needed a retry\n\nNo report to read: the suite did not get as far as writing one.\n";
  }
  try {
    return summarize(JSON.parse(text));
  } catch {
    return "## E2E: tests that needed a retry\n\nThe report could not be read as JSON.\n";
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.stdout.write(summarizeFile(process.argv[2] ?? DEFAULT_REPORT));
}
