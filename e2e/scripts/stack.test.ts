import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { requireReadyTarget } from "../stack.ts";
import { readTarget, TARGET_VARIABLES, targetProblems } from "../target.ts";
import config from "../playwright.config.ts";

// Throwaway, non-routable names: this file is the one place besides the README that may hold URLs of any kind.
const NAMED = {
  E2E_BASE_URL: "http://stack.example.test:9000",
  E2E_MAILPIT_URL: "http://stack.example.test:9001",
  E2E_JIRA_STUB_URL: "http://stack.example.test:9002",
  E2E_FLOW_STUB_URL: "https://stack.example.test:9003",
};
const root = fileURLToPath(new URL("..", import.meta.url));

function neverCalled(): Promise<boolean> {
  return Promise.reject(new Error("must not probe a stack that was not named"));
}

test("nothing set refuses, names all four variables, and never probes", async () => {
  const problems = targetProblems({});
  assert.equal(problems.length, TARGET_VARIABLES.length);
  await assert.rejects(requireReadyTarget(problems, readTarget({}), neverCalled), (error: Error) => {
    for (const name of TARGET_VARIABLES) assert.match(error.message, new RegExp(name));
    assert.match(error.message, /default stack is a working stack/);
    return true;
  });
});

test("reading the target never throws and gives an empty string for what is unset", () => {
  assert.deepEqual(readTarget({}), { baseUrl: "", mailpitUrl: "", jiraStubUrl: "", flowStubUrl: "" });
  assert.equal(readTarget(NAMED).flowStubUrl, NAMED.E2E_FLOW_STUB_URL);
});

test("one blank or relative value is named and the others are not", async () => {
  for (const [bad, expected] of [["", /E2E_MAILPIT_URL is blank/], ["   ", /E2E_MAILPIT_URL is blank/], ["/mail", /E2E_MAILPIT_URL is not an absolute/],
    ["mailpit:8025", /E2E_MAILPIT_URL is not an absolute/], ["ftp://stack.example.test", /E2E_MAILPIT_URL is not an absolute/]] as const) {
    const env = { ...NAMED, E2E_MAILPIT_URL: bad };
    const problems = targetProblems(env);
    assert.equal(problems.length, 1, `${JSON.stringify(bad)} -> ${problems.join("; ")}`);
    assert.match(problems[0], expected);
    await assert.rejects(requireReadyTarget(problems, readTarget(env), neverCalled), (error: Error) => {
      const named = error.message.split("\n").filter((line) => line.startsWith("  - "));
      assert.equal(named.length, 1);
      assert.match(named[0], /E2E_MAILPIT_URL/);
      return true;
    });
  }
});

test("four good values and a ready stack pass without a service command", async () => {
  assert.deepEqual(targetProblems(NAMED), []);
  const probed: string[] = [];
  await requireReadyTarget(targetProblems(NAMED), readTarget(NAMED), async (url) => {
    probed.push(url);
    return true;
  });
  assert.deepEqual(probed, [`${NAMED.E2E_BASE_URL}/api/v1/ready`, `${NAMED.E2E_MAILPIT_URL}/api/v1/messages`]);
});

test("a stack that is not ready fails and nothing is started", async () => {
  const probed: string[] = [];
  await assert.rejects(requireReadyTarget([], readTarget(NAMED), async (url) => {
    probed.push(url);
    return false;
  }), /not ready: start that stack first/);
  assert.deepEqual(probed, [`${NAMED.E2E_BASE_URL}/api/v1/ready`]);
});

test("an available app with unreachable Mailpit fails before the browser tests run", async () => {
  const target = readTarget({ ...NAMED, E2E_MAILPIT_URL: `${NAMED.E2E_MAILPIT_URL}/` });
  const probed: string[] = [];
  await assert.rejects(requireReadyTarget([], target, async (url) => {
    probed.push(url);
    return url.startsWith(NAMED.E2E_BASE_URL);
  }), /E2E_MAILPIT_URL.*is not ready/);
  assert.deepEqual(probed, [`${NAMED.E2E_BASE_URL}/api/v1/ready`, `${NAMED.E2E_MAILPIT_URL}/api/v1/messages`]);
});

test("the suite registers no global teardown: a stack is never torn down", () => {
  assert.equal(config.globalTeardown, undefined);
});

/** Every file under e2e/ that is source or prose of the suite (not dependencies, reports or the lockfile). */
function suiteFiles(dir: string): string[] {
  const skipped = new Set(["node_modules", "test-results", "playwright-report", ".playwright", "package-lock.json"]);
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    if (skipped.has(entry.name)) return [];
    const path = join(dir, entry.name);
    return entry.isDirectory() ? suiteFiles(path) : [path];
  });
}

test("no file under e2e/ other than the README and this test holds a host URL of a local stack", () => {
  const exempt = new Set([join(root, "README.md"), fileURLToPath(import.meta.url)]);
  const holders = suiteFiles(root).filter((path) => !exempt.has(path) && readFileSync(path, "utf8").includes("localhost:80"));
  assert.deepEqual(holders.map((path) => relative(root, path)), []);
});

test("neither stack.ts nor global-setup.ts can start, build or stop a container", () => {
  for (const file of ["../stack.ts", "../global-setup.ts"]) {
    const source = readFileSync(new URL(file, import.meta.url), "utf8");
    assert.doesNotMatch(source, /docker|compose|child_process|execSync|spawn/i, file);
  }
});
