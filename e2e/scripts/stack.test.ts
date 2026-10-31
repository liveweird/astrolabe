import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { ensureStack } from "../stack.ts";
import config from "../playwright.config.ts";

/**
 * The stack is never torn down: the suite registers no global teardown at all, and global setup's only service command is the
 * start (`docker compose up`, never `down`/`rm`) — checked on its source, as running it needs a live stack.
 */
function assertTeardownLeavesTheStack(): void {
  assert.equal(config.globalTeardown, undefined);
  const source = readFileSync(new URL("../global-setup.ts", import.meta.url), "utf8");
  assert.doesNotMatch(source, /compose (down|rm|stop|kill)|docker (rm|stop|kill|volume)/);
}

test("a healthy existing deployment is reused without service commands", async () => {
  await ensureStack("https://custom.example.test", {
    responds: async () => true,
    start: () => assert.fail("must not start an already healthy deployment"),
    wait: async () => assert.fail("must not wait again"),
  });
});

test("a stopped local stack is started and never torn down", async () => {
  const actions: string[] = [];
  await ensureStack("http://localhost:8086", {
    responds: async () => false,
    start: () => { actions.push("start"); },
    wait: async () => { actions.push("ready"); },
  });
  assert.deepEqual(actions, ["start", "ready"]);
  assertTeardownLeavesTheStack();
});

test("readiness failure preserves the started stack and its existing data", async () => {
  let starts = 0;
  await assert.rejects(ensureStack("http://localhost:8086", {
    responds: async () => false,
    start: () => { starts++; },
    wait: async () => { throw new Error("database unavailable"); },
  }), /database unavailable/);
  assert.equal(starts, 1);
  assertTeardownLeavesTheStack();
});

test("an unavailable custom target never starts the unrelated default stack", async () => {
  await assert.rejects(ensureStack("https://custom.example.test", {
    responds: async () => false,
    start: () => assert.fail("must not start the default stack for a different target"),
    wait: async () => assert.fail("must not wait for a different target"),
  }), /start that deployment/);
});
