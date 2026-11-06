import { describe, expect, test } from "vitest";
import i18n from "../i18n";
import { run } from "../test/jira";
import { errorCodeText, RUN_POLL_MAX_MS, RUN_POLL_MS, RUN_STATE_COLOR, runState } from "./syncRuns";

describe("runState", () => {
  test("the outcome of a finished run is read as is", () => {
    expect(runState(run({ outcome: "SUCCEEDED" }))).toBe("succeeded");
    expect(runState(run({ outcome: "FAILED", errorCode: "TIMEOUT" }))).toBe("failed");
    expect(runState(run({ outcome: "ABANDONED" }))).toBe("abandoned");
  });

  test("an unfinished run is running or interrupted by the SERVER's verdict alone - the client reads no clock", () => {
    const unfinished = { outcome: null, finishedAt: null };
    // However old startedAt looks to this browser, `running` is what counts.
    expect(runState(run({ ...unfinished, startedAt: 1, running: true }))).toBe("running");
    expect(runState(run({ ...unfinished, startedAt: Date.now(), running: false }))).toBe("interrupted");
    // A row with the members absent (the schema marks them optional) reads the same.
    expect(runState(run({ outcome: undefined, finishedAt: undefined, running: true }))).toBe("running");
    // A connection's `lastRun` carries the same two members and reads the same.
    expect(runState({ outcome: null, running: false })).toBe("interrupted");
  });

  test("the safety net of the poll is a bound, and every state has a colour", () => {
    expect(RUN_POLL_MAX_MS).toBeGreaterThan(RUN_POLL_MS);
    expect(RUN_STATE_COLOR).toEqual({ succeeded: "green", failed: "red", abandoned: "orange", interrupted: "orange", running: "gray" });
  });
});

describe("errorCodeText", () => {
  const t = i18n.t.bind(i18n);

  test.each([
    "AUTHENTICATION_FAILED",
    "FORBIDDEN_SCOPE",
    "NOT_FOUND",
    "RATE_LIMITED",
    "UPSTREAM_UNAVAILABLE",
    "TIMEOUT",
    "INVALID_RESPONSE",
    "LIMIT_EXCEEDED",
    "BLOCKED_HOST",
    "REDIRECT",
    "CURSOR_EXPIRED",
    "PROJECT_NOT_VISIBLE",
    "TOKEN_UNREADABLE",
    "NOT_DISCOVERED",
    "MAPPING_INVALID",
    "MAPPING_UNREADABLE",
    "CONNECTION_GONE",
    "CONNECTION_DISABLED",
    "RUN_DEADLINE",
    "SHUTDOWN",
    "INTERNAL",
    "ABANDONED",
  ])("%s has a sentence and keeps its code visible", (code) => {
    const text = errorCodeText(code, t);
    expect(text.endsWith(`(${code})`)).toBe(true);
    expect(text.length).toBeGreaterThan(code.length + 4);
  });

  test("an unknown code reads as itself", () => {
    expect(errorCodeText("SOMETHING_NEW", t)).toBe("SOMETHING_NEW");
  });
});
