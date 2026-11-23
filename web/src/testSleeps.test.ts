/// <reference types="node" />
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Sleep guard for every unit test under `web/src`: a `*.test.ts(x)` file does not wait in real time. A sleep (`await new Promise((r) =>
 * setTimeout(r, 50))`, a `sleep(…)` helper) is a guess: too short and the test flakes under load, long enough and the suite pays for it on every
 * run. The three honest replacements are, by what the test is after:
 * - a timer the code under test owns (a debounce, a `setTimeout(0)`, Mantine's 10 ms focus return): fake it, `vi.useFakeTimers({ toFake: [...] })`
 *   scoped to the test (`shouldAdvanceTime: true` where waitFor or user-event still need real time to flow), advance it with
 *   `vi.advanceTimersByTimeAsync`, `vi.useRealTimers()` in `afterEach` (the suite runs `isolate: false`);
 * - a negative proof ("nothing more is requested", "no banner"): wait for the settled state, `requestsAnswered(queryClient)` (`test/requestsAnswered.ts`),
 *   then assert the absence;
 * - a response that must arrive late: a gate, `deferred()` (`test/deferred.ts`), settled by the test.
 * The twin of the server's `TestSleepGuardTest`, same policy: the allow-list only shrinks. A listed file that no longer sleeps fails (delist it); a
 * new entry is a reviewed exception whose reason says why no fake clock, settled state or gate can do the job.
 *
 * What counts as a sleep: a Promise whose executor starts a `setTimeout` (the arrow-expression and the block forms), `setTimeout(resolve, …)`, and a
 * `sleep(` call. Comments are ignored. Virtual waits are not sleeps (`await vi.advanceTimersByTimeAsync(…)`), nor is `setTimeout` on its own (a
 * stub of the code under test may legitimately schedule one).
 */

/** Path under `web/src` -> why it may still sleep in real time. Empty today; it only ever shrinks. */
const SLEEPERS: Readonly<Record<string, string>> = {};

const SRC_ROOT = dirname(fileURLToPath(import.meta.url));
const SELF = "testSleeps.test.ts";
const MIN_FILES = 100;

const SLEEP_PATTERNS: readonly RegExp[] = [
  // `new Promise((resolve) => setTimeout(…` and the block form `new Promise((resolve) => {\n setTimeout(…`
  /new Promise(?:<\w+>)?\(\(?\w*\)? ?=> ?(?:window\.)?setTimeout\(/,
  /new Promise(?:<\w+>)?\(\(?\w*\)? ?=> ?\{\s+(?:window\.)?setTimeout\(/,
  /\bsetTimeout\((?:resolve|res|r|done)\b/,
  /\bsleep\(/,
];

/** Block comments and `//` comments (a `//` after whitespace or at the line start; a URL's `://` is left alone). */
function withoutComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(?<=^|\s)\/\/.*$/gm, "");
}

/** The 1-based lines of a real-time sleep in the source (a match is attributed to the line its first character sits on). */
function sleepLines(source: string): number[] {
  const code = withoutComments(source);
  const lines = new Set<number>();
  for (const pattern of SLEEP_PATTERNS) {
    for (const match of code.matchAll(new RegExp(pattern.source, "g"))) {
      lines.add(code.slice(0, match.index).split("\n").length);
    }
  }
  return [...lines].sort((a, b) => a - b);
}

function testFiles(): string[] {
  const found: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (/\.test\.tsx?$/.test(entry.name)) found.push(relative(SRC_ROOT, path).split(sep).join("/"));
    }
  };
  walk(SRC_ROOT);
  return found.filter((path) => path !== SELF).sort();
}

describe("no real-time sleeps in the unit tests", () => {
  it("the detector sees the forms it exists for, and only those", () => {
    const sleeps = [
      "await new Promise((resolve) => setTimeout(resolve, 20));",
      "await new Promise((r) => setTimeout(r, 5));",
      "await new Promise(resolve => setTimeout(resolve, 5));",
      "await new Promise<void>((resolve) => window.setTimeout(resolve, 5));",
      "const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));",
      "return new Promise((resolve) => setTimeout(() => resolve(answer), 30));",
      "await new Promise((resolve) => {\n  setTimeout(resolve, 5);\n});",
      "setTimeout(resolve, 10);",
      "await sleep(10);",
    ];
    for (const source of sleeps) expect(sleepLines(source), source).not.toEqual([]);
    const fine = [
      "await vi.advanceTimersByTimeAsync(20);",
      "await act(() => vi.advanceTimersByTimeAsync(60));",
      "vi.useFakeTimers({ toFake: ['setTimeout'] });",
      "const timer = window.setTimeout(() => (remembered = null), 0);",
      "// await new Promise((resolve) => setTimeout(resolve, 20));",
      "/* await sleep(5) */",
      "const pending = new Promise<void>((resolve) => (release = resolve));",
      "const gate = deferred();",
    ];
    for (const source of fine) expect(sleepLines(source), source).toEqual([]);
    expect(sleepLines("const a = 1;\n\nawait sleep(1);")).toEqual([3]);
  });

  it("scans the whole suite", () => {
    expect(testFiles().length).toBeGreaterThanOrEqual(MIN_FILES);
  });

  it("no test file sleeps in real time, except the allow-listed ones", () => {
    const offenders = testFiles()
      .filter((path) => !(path in SLEEPERS))
      .map((path) => ({ path, lines: sleepLines(readFileSync(join(SRC_ROOT, path), "utf8")) }))
      .filter(({ lines }) => lines.length > 0)
      .map(({ path, lines }) => `${path}:${lines.join(",")}`);
    expect(offenders, "a real-time sleep: fake the timer, await the settled state, or gate the response (see this file's header)").toEqual([]);
  });

  it("the allow-list only shrinks: every entry names an existing file that still sleeps, with a reason", () => {
    const files = new Set(testFiles());
    const stale = Object.entries(SLEEPERS).filter(
      ([path, reason]) => !files.has(path) || reason.trim() === "" || sleepLines(readFileSync(join(SRC_ROOT, path), "utf8")).length === 0,
    );
    expect(stale.map(([path]) => path), "delist a file that no longer sleeps (or never existed), and give every entry its reason").toEqual([]);
  });
});
