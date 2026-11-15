import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { summarize, summarizeFile } from "./flaky-summary.mjs";

const script = fileURLToPath(new URL("./flaky-summary.mjs", import.meta.url));

// Fixtures in the shape of Playwright's JSON reporter (JSONReport in playwright/types/testReporter.d.ts): suites (a file suite,
// describe suites inside) > specs > tests > results; `status` of a test is expected | unexpected | flaky | skipped.
const ESC = String.fromCharCode(27);
const attempt = (status, retry, message) => ({
  status,
  retry,
  duration: 1000,
  errors: [],
  ...(message === undefined ? {} : { error: { message } }),
});
const spec = (file, line, title, status, results) => ({ title, file, line, column: 5, ok: status !== "unexpected", tags: [], id: `${file}-${line}`, tests: [{ status, results }] });
const fileSuite = (file, specs, suites = []) => ({ title: file, file, line: 0, column: 0, specs, suites });
const report = (...suites) => ({ suites, errors: [], stats: {} });

const passes = (file, line, title) => spec(file, line, title, "expected", [attempt("passed", 0)]);
const flaky = (file, line, title, message) =>
  spec(file, line, title, "flaky", [attempt("failed", 0, message), attempt("failed", 1, "second"), attempt("passed", 2)]);
const failed = (file, line, title, message) =>
  spec(file, line, title, "unexpected", [attempt("failed", 0, message), attempt("timedOut", 1, "later"), attempt("failed", 2, "last")]);

test("no flaky test: one line, with the number of tests", () => {
  const md = summarize(report(fileSuite("a.spec.ts", [passes("a.spec.ts", 3, "one"), passes("a.spec.ts", 9, "two")])));
  assert.match(md, /^## E2E: tests that needed a retry\n/);
  assert.match(md, /No test needed a retry \(2 tests\)\./);
  assert.doesNotMatch(md, /\|/);
});

test("one flaky test: file and line, title with its describe, the attempts and the first line of the first failure", () => {
  const message = `${ESC}[31mTimeout 10000ms exceeded.${ESC}[39m\nCall log:\n  - waiting for locator`;
  const md = summarize(
    report(
      fileSuite(
        "jira-sync.spec.ts",
        [passes("jira-sync.spec.ts", 5, "plain")],
        [{ title: "Jira sync", specs: [flaky("jira-sync.spec.ts", 44, "refreshes | twice", message)], suites: [] }],
      ),
    ),
  );
  assert.match(md, /2 tests: 1 flaky \(passed on a retry\), 0 failed\./);
  assert.match(md, /### Flaky/);
  assert.doesNotMatch(md, /### Failed/);
  assert.match(md, /\| `jira-sync\.spec\.ts:44` Jira sync › refreshes \\\| twice \| 3 \| Timeout 10000ms exceeded\. \|/);
  assert.doesNotMatch(md, new RegExp(ESC), "ANSI colours are stripped");
  assert.doesNotMatch(md, /Call log/, "only the first line of the error");
});

test("one failed test is listed apart from the flaky ones, in file and line order", () => {
  const md = summarize(
    report(
      fileSuite("b.spec.ts", [failed("b.spec.ts", 12, "breaks", "expect(received).toBe(expected)\n\nExpected: 1")]),
      fileSuite("a.spec.ts", [flaky("a.spec.ts", 30, "second", "late"), flaky("a.spec.ts", 8, "first", "early")]),
    ),
  );
  assert.match(md, /3 tests: 2 flaky \(passed on a retry\), 1 failed\./);
  const flakyAt = md.indexOf("### Flaky");
  const failedAt = md.indexOf("### Failed");
  assert.ok(flakyAt >= 0 && failedAt > flakyAt, "Flaky comes first, Failed after it");
  assert.ok(md.indexOf("a.spec.ts:8") < md.indexOf("a.spec.ts:30"), "sorted by line");
  assert.ok(md.indexOf("a.spec.ts:30") < failedAt, "the failed test is not among the flaky ones");
  assert.match(md, /\| `b\.spec\.ts:12` breaks \| 3 \| expect\(received\)\.toBe\(expected\) \|/);
});

test("a skipped test and an error with no message do not break the list", () => {
  const skipped = spec("a.spec.ts", 2, "later", "skipped", []);
  const bare = flaky("a.spec.ts", 4, "bare");
  bare.tests[0].results[0] = attempt("failed", 0);
  const md = summarize(report(fileSuite("a.spec.ts", [skipped, bare])));
  assert.match(md, /2 tests: 1 flaky/);
  assert.match(md, /\(no error message\)/);
});

test("no file, or a file that is not JSON: one line each, and the script still exits 0", () => {
  const dir = mkdtempSync(join(tmpdir(), "flaky-summary-"));
  const missing = join(dir, "results.json");
  assert.match(summarizeFile(missing), /No report to read/);
  const missingRun = spawnSync(process.execPath, [script, missing], { encoding: "utf8" });
  assert.equal(missingRun.status, 0);
  assert.match(missingRun.stdout, /No report to read/);

  const broken = join(dir, "broken.json");
  writeFileSync(broken, "{ not json");
  const brokenRun = spawnSync(process.execPath, [script, broken], { encoding: "utf8" });
  assert.equal(brokenRun.status, 0);
  assert.match(brokenRun.stdout, /could not be read as JSON/);
});

test("a report file with a flaky test is printed by the script, exit 0", () => {
  const dir = mkdtempSync(join(tmpdir(), "flaky-summary-"));
  const file = join(dir, "results.json");
  writeFileSync(file, JSON.stringify(report(fileSuite("a.spec.ts", [flaky("a.spec.ts", 8, "first", "early")]))));
  const run = spawnSync(process.execPath, [script, file], { encoding: "utf8" });
  assert.equal(run.status, 0);
  assert.match(run.stdout, /1 flaky \(passed on a retry\), 0 failed/);
});
