import { describe, expect, test } from "vitest";
import i18n from "../i18n";
import { ApiError } from "../api/http";
import { bindFailure } from "./jiraBind";

const t = i18n.getFixedT("en");
const problem = (status: number, type: string | undefined, detail: string) =>
  new ApiError(status, { type, title: "x", status, detail });

describe("bindFailure - every answer a bind gives, in words", () => {
  test("400 keeps the server's own sentence under a localized lead", () => {
    expect(bindFailure(problem(400, undefined, "ABC-12 is outside the connection's project keys"), t)).toEqual({
      message: "This link was refused:",
      detail: "ABC-12 is outside the connection's project keys",
    });
  });

  test("409 already-bound names the other side through the server's sentence", () => {
    expect(bindFailure(problem(409, "urn:astrolabe:problem:already-bound", "E2E-3 is already linked to project X"), t)).toEqual({
      message: "Already linked:",
      detail: "E2E-3 is already linked to project X",
    });
  });

  test("409 jira-mapping-invalid says an administrator has to fix it", () => {
    expect(bindFailure(problem(409, "urn:astrolabe:problem:jira-mapping-invalid", "stale"), t).message).toMatch(/administrator has to fix it/);
  });

  test("the other 409s, 403, 404, 429 and 502 each read in words", () => {
    expect(bindFailure(problem(409, "urn:astrolabe:problem:jira-not-discovered", "x"), t).message).toMatch(/not been tested/);
    expect(bindFailure(problem(409, "urn:astrolabe:problem:jira-token-unreadable", "x"), t).message).toMatch(/token cannot be read/);
    expect(bindFailure(problem(403, undefined, "x"), t).message).toMatch(/owners and administrators/);
    expect(bindFailure(problem(404, undefined, "x"), t).message).toBe("This plan item no longer exists.");
    expect(bindFailure(problem(429, undefined, "x"), t).message).toMatch(/Too many link attempts/);
    expect(bindFailure(problem(502, "urn:astrolabe:problem:jira-upstream", "Jira did not answer (AUTHENTICATION_FAILED)"), t)).toEqual({
      message: "Jira could not be reached or refused the request:",
      detail: "Jira refused the credentials (AUTHENTICATION_FAILED)",
    });
  });

  test("an unexpected status or a network failure never shows error.message", () => {
    expect(bindFailure(problem(418, undefined, "x"), t).message).toBe("The link failed (418)");
    expect(bindFailure(new TypeError("Failed to fetch"), t).message).toBe("The link failed");
  });

  test("a 502 whose detail names no code carries no detail, and a timeout reads as the shared timeout sentence", () => {
    expect(bindFailure(problem(502, "urn:astrolabe:problem:jira-upstream", "Jira did not answer"), t)).toEqual({
      message: "Jira could not be reached or refused the request:",
      detail: undefined,
    });
    const timeout = new DOMException("The operation timed out", "TimeoutError");
    expect(bindFailure(timeout, t).message).toBe(t("common.error.timeout"));
  });
});
