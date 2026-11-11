import { describe, expect, test } from "vitest";
import i18n from "../i18n";
import { ApiError } from "../api/http";
import { applyMayHaveLanded, importFailure, infoText, reasonText } from "./jiraImportText";

const t = i18n.t.bind(i18n);
const problem = (status: number, extra: Record<string, unknown> = {}) => new ApiError(status, { title: "x", status, ...extra });
const ctx = { apply: false, timedOut: false, cancelled: false };

describe("reasonText", () => {
  test.each([
    ["ALREADY_BOUND", /Already linked to a plan item/],
    ["NO_PARENT", /Nowhere to put it/],
    ["NAME_TAKEN", /already exists here/],
    ["LEVEL_UNMAPPED", /not mapped to a plan level/],
    ["NO_TEAM", /No team/],
    ["PARENT_SKIPPED", /parent is skipped/],
    ["CHANGED", /Preview again/],
  ] as const)("%s reads in words", (reason, pattern) => {
    expect(reasonText(reason, t)).toMatch(pattern);
  });

  test("a known holder is named", () => {
    expect(reasonText("ALREADY_BOUND", t, "Billing")).toBe("Already linked to Billing.");
  });
});

describe("infoText", () => {
  test("says why dates were not copied", () => {
    expect(infoText("DATES_NOT_COPIED", t)).toMatch(/do not manage/);
    expect(infoText("NAME_TRUNCATED", t)).toMatch(/100/);
    expect(infoText("ESTIMATE_NOT_CONVERTED", t)).toMatch(/Estimate/);
    expect(infoText("DATES_INVALID", t)).toMatch(/unscheduled/);
    expect(infoText("NO_WORKING_DAY", t)).toMatch(/working day/);
  });

  test("says why a row was kept as a parent, and why its own parent could not be read", () => {
    expect(infoText("KEPT_AS_PARENT", t)).toBe("Kept as a parent of an item shown here");
    expect(infoText("PARENT_UNREADABLE", t)).toBe(
      "Its parent in Jira could not be read with the connection's account (Jira answered that it does not exist or is not visible)",
    );
  });
});

describe("importFailure", () => {
  test("a cancelled preview says nothing; an abort at the deadline says so, and for an apply that it may have landed", () => {
    expect(importFailure(new DOMException("x", "AbortError"), t, { ...ctx, cancelled: true })).toBeNull();
    expect(importFailure(new DOMException("x", "AbortError"), t, { ...ctx, timedOut: true })?.message).toMatch(/Narrow the Jira projects/);
    const apply = importFailure(new DOMException("x", "AbortError"), t, { apply: true, timedOut: true, cancelled: false });
    expect(apply).toMatchObject({ repreview: true });
    expect(apply?.message).toMatch(/may still have been applied.*Links to plan items/);
  });

  test("an apply that ends in doubt - no server answer, or a 5xx other than the server's own 502 - reads like the abort; a preview never does", () => {
    const apply = { ...ctx, apply: true };
    for (const err of [new TypeError("Failed to fetch"), problem(500), problem(503), problem(504)]) {
      expect(importFailure(err, t, apply)).toMatchObject({ repreview: true, message: expect.stringMatching(/may still have been applied/) });
      expect(applyMayHaveLanded(err, false)).toBe(true);
    }
    for (const err of [problem(502), problem(409), problem(400), problem(403), problem(429)]) expect(applyMayHaveLanded(err, false)).toBe(false);
    expect(importFailure(problem(500), t, ctx)?.message).toBe("The import failed (500)");
    expect(importFailure(new TypeError("Failed to fetch"), t, ctx)?.message).toBe("The import failed");
  });

  test("409 types: mapping (an apply offers a re-preview), discovery, token, and any other conflict", () => {
    const mapping = problem(409, { type: "urn:astrolabe:problem:jira-mapping-invalid", detail: "changed - preview again" });
    expect(importFailure(mapping, t, { ...ctx, apply: true })).toMatchObject({ repreview: true, detail: "changed - preview again" });
    expect(importFailure(mapping, t, ctx)).toMatchObject({ repreview: false });
    expect(importFailure(problem(409, { type: "urn:astrolabe:problem:jira-not-discovered" }), t, ctx)?.message).toMatch(/not been tested/);
    expect(importFailure(problem(409, { type: "urn:astrolabe:problem:jira-token-unreadable" }), t, ctx)?.message).toMatch(/token/);
    expect(importFailure(problem(409), t, { ...ctx, apply: true })).toMatchObject({ repreview: true });
  });

  test("400, 403, 404, 429, 502 and the rest", () => {
    expect(importFailure(problem(400, { detail: "narrow projectKeys" }), t, ctx)).toMatchObject({ message: "The import was refused:", detail: "narrow projectKeys" });
    expect(importFailure(problem(403, { detail: "You do not own program X" }), t, ctx)).toMatchObject({ detail: "You do not own program X" });
    expect(importFailure(problem(404, { detail: "Work stream not found" }), t, ctx)?.message).toMatch(/no longer exists/);
    expect(importFailure(problem(429), t, ctx)?.message).toMatch(/5 a minute/);
    expect(importFailure(problem(502, { detail: "Jira did not answer (TIMEOUT)" }), t, ctx)?.detail).toContain("TIMEOUT");
    expect(importFailure(problem(500), t, ctx)?.message).toBe("The import failed (500)");
    expect(importFailure(new TypeError("Failed to fetch"), t, ctx)?.message).toBe("The import failed");
  });
});
