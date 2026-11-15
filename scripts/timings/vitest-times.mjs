#!/usr/bin/env node
// The web twin of `local-times.mjs slow-tests`: reads vitest's JSON report and prints (and, with --summary-file, appends as Markdown)
// the wall, the sum of the file times, their ratio (how many workers were kept busy), the slowest files and the slowest tests.
// Information, never a gate: it exits 0 whatever it finds, a missing or unreadable report included. node built-ins only (node >= 18).
// See .claude/docs/build-times.md ("In CI").
//
//   node scripts/timings/vitest-times.mjs [report.json] [--top-files 15] [--top-tests 10] [--summary-file PATH]
//
// The report comes from `vitest run --reporter=default --reporter=json --outputFile.json=test-results/vitest.json`.
// wall = the report's start to the last file's end (set-up included); a file's time = its end minus its start.
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { relative } from "node:path";
import { parseArgs } from "node:util";
import { fmtDur } from "./lib.mjs";

const { values, positionals } = parseArgs({
  args: process.argv.slice(2),
  options: {
    "top-files": { type: "string", default: "15" },
    "top-tests": { type: "string", default: "10" },
    "summary-file": { type: "string" },
  },
  allowPositionals: true,
});
const reportPath = positionals[0] ?? "test-results/vitest.json";
const topFiles = Number(values["top-files"]);
const topTests = Number(values["top-tests"]);

const table = (head, rows, align) =>
  [
    `| ${head.join(" | ")} |`,
    `|${align.map((a) => (a === "r" ? "--:" : "---")).join("|")}|`,
    ...rows.map((r) => `| ${r.join(" | ")} |`),
  ].join("\n");

/** A path shown relative to the report's working directory when it lies below it, `|` escaped for a Markdown cell. */
const shortName = (name) => {
  const rel = relative(process.cwd(), name);
  return (rel.startsWith("..") ? name : rel).replace(/\|/g, "\\|");
};

function summarise(report) {
  const files = (report.testResults ?? []).filter((f) => Number.isFinite(f.startTime) && Number.isFinite(f.endTime));
  if (files.length === 0) return undefined;
  const wall = (Math.max(...files.map((f) => f.endTime)) - (report.startTime ?? Math.min(...files.map((f) => f.startTime)))) / 1000;
  const fileRows = files.map((f) => ({ name: f.name, tests: (f.assertionResults ?? []).length, time: (f.endTime - f.startTime) / 1000 }));
  const sum = fileRows.reduce((a, f) => a + f.time, 0);
  const tests = files.flatMap((f) =>
    (f.assertionResults ?? []).map((t) => ({ name: `${shortName(f.name)} > ${t.fullName.replace(/\|/g, "\\|")}`, time: (t.duration ?? 0) / 1000 })),
  );
  return { wall, sum, files: fileRows, tests, total: report.numTotalTests ?? tests.length };
}

function render(s) {
  const fileRows = [...s.files].sort((a, b) => b.time - a.time).slice(0, topFiles);
  const testRows = [...s.tests].sort((a, b) => b.time - a.time).slice(0, topTests);
  const lines = [
    `${s.files.length} test files, ${s.total} tests`,
    `wall (report start -> last file end): ${fmtDur(s.wall)}`,
    `sum of file times: ${fmtDur(s.sum)}`,
    `sum / wall: ${(s.sum / s.wall).toFixed(2)} (the workers kept busy)`,
  ];
  const fileTable = table(
    ["file", "tests", "time", "share"],
    fileRows.map((f) => [`\`${shortName(f.name)}\``, String(f.tests), fmtDur(f.time), `${((100 * f.time) / s.sum).toFixed(1)} %`]),
    ["l", "r", "r", "r"],
  );
  const testTable = table(
    ["test", "time"],
    testRows.map((t) => [t.name, fmtDur(t.time)]),
    ["l", "r"],
  );
  return { lines, fileRows, testRows, fileTable, testTable };
}

function main() {
  let summary;
  if (!existsSync(reportPath)) {
    console.log(`vitest-times: no report at ${reportPath} (nothing to summarise)`);
    return;
  }
  try {
    summary = summarise(JSON.parse(readFileSync(reportPath, "utf8")));
  } catch (error) {
    console.log(`vitest-times: ${reportPath} is not a readable vitest report (${error.message})`);
    return;
  }
  if (summary === undefined) {
    console.log(`vitest-times: ${reportPath} lists no test files`);
    return;
  }
  const out = render(summary);
  console.log(out.lines.join("\n"));
  console.log(`\ntop ${out.fileRows.length} files\n${out.fileTable}`);
  console.log(`\ntop ${out.testRows.length} tests\n${out.testTable}`);
  if (values["summary-file"]) {
    const md = [
      "### Vitest time report",
      "",
      out.lines.map((l) => `- ${l}`).join("\n"),
      "",
      `**Top ${out.fileRows.length} files**`,
      "",
      out.fileTable,
      "",
      `**Top ${out.testRows.length} tests**`,
      "",
      out.testTable,
      "",
    ].join("\n");
    appendFileSync(values["summary-file"], `${md}\n`);
  }
}

main();
