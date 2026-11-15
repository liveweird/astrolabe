import type { TFunction } from "i18next";
import { describe, expect, test } from "vitest";
import { ApiError } from "../api/http";
import { jiraFailure, type JiraFailureKeys } from "./jiraFailure";

// A translator that echoes the key and its interpolation, so the table (not the wording) is what is pinned.
const t = ((key: string, opts?: { status?: number }) => (opts?.status === undefined ? key : `${key}#${opts.status}`)) as unknown as TFunction;
const problem = (status: number) => new ApiError(status, { title: "x", status, detail: "Jira did not answer (AUTHENTICATION_FAILED)" });

const FULL: JiraFailureKeys = {
  invalid: "jira.bind.error.invalid",
  forbidden: "jira.bind.error.forbidden",
  notFound: "jira.bind.error.gone",
  conflict: "jira.import.error.conflict",
  rateLimited: "jira.bind.error.rateLimited",
  upstream: "jira.bind.error.upstream",
  failedStatus: "jira.bind.error.failedStatus",
};

describe("jiraFailure - the shared status table", () => {
  test.each([
    [400, "jira.bind.error.invalid", true],
    [403, "jira.bind.error.forbidden", false],
    [404, "jira.bind.error.gone", false],
    [409, "jira.import.error.conflict", false],
    [429, "jira.bind.error.rateLimited", false],
  ] as const)("%i reads its key; the server's sentence rides on the 400 alone by default", (status, message, withDetail) => {
    const got = jiraFailure(problem(status), t, FULL);
    expect(got.message).toBe(message);
    expect("detail" in got).toBe(withDetail);
    if (withDetail) expect(got.detail).toBe("Jira did not answer (AUTHENTICATION_FAILED)");
  });

  test("detailFor widens the statuses that carry the server's sentence", () => {
    const keys = { ...FULL, detailFor: [400, 403, 404] };
    expect(jiraFailure(problem(403), t, keys).detail).toBe("Jira did not answer (AUTHENTICATION_FAILED)");
    expect(jiraFailure(problem(404), t, keys).detail).toBe("Jira did not answer (AUTHENTICATION_FAILED)");
    expect("detail" in jiraFailure(problem(409), t, keys)).toBe(false);
  });

  test("502 puts only Jira's failure code in words, and says nothing when the sentence has none", () => {
    const got = jiraFailure(problem(502), t, FULL);
    expect(got.message).toBe("jira.bind.error.upstream");
    expect(got.detail).toBeDefined();
    expect(got.detail).not.toContain("Jira did not answer");
    const bare = jiraFailure(new ApiError(502, { title: "x", status: 502, detail: "no code here" }), t, FULL);
    expect(bare).toEqual({ message: "jira.bind.error.upstream", detail: undefined });
  });

  test.each([409, 500, 503, 418])("%i without a key (or any other status) reads failedStatus with the status", (status) => {
    const keys: JiraFailureKeys = status === 409 ? { ...FULL, conflict: undefined } : FULL;
    expect(jiraFailure(problem(status), t, keys)).toEqual({ message: `jira.bind.error.failedStatus#${status}` });
  });

  test("a table without a 429 or 502 key falls to failedStatus for them", () => {
    const keys: JiraFailureKeys = { failedStatus: "common.error.actionFailedStatus" };
    for (const status of [400, 403, 404, 409, 429, 502]) {
      expect(jiraFailure(problem(status), t, keys)).toEqual({ message: `common.error.actionFailedStatus#${status}` });
    }
  });
});
