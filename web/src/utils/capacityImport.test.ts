import { describe, expect, test } from "vitest";
import i18n from "../i18n";
import { ApiError } from "../api/http";
import { APPLIED, PREVIEW, previewItem } from "../test/flow";
import { applyRequest, defaultTicks, importFailure, isClosed, isImportable, outcomeSentence } from "./capacityImport";

const t = i18n.t.bind(i18n);

describe("capacity import helpers", () => {
  test("only a CREATE or an UPDATE with its dates and figure is importable", () => {
    expect(PREVIEW.items.map((item) => [item.sprintId, isImportable(item)])).toEqual([[101, true], [102, true], [103, true], [104, false], [105, false], [106, false]]);
    expect(isImportable(previewItem({ effectiveFrom: null }))).toBe(false);
  });

  test("the default ticks are the server's ticked rows that can be written, and nothing else", () => {
    expect([...defaultTicks(PREVIEW)]).toEqual([101, 102]);
    // A forged ticked flag on a row that cannot be written is ignored.
    expect([...defaultTicks({ ...PREVIEW, items: [previewItem({ sprintId: 9, action: "MANUAL_PERIOD", ticked: true })] })]).toEqual([]);
  });

  test("the apply body is exactly the ticked rows with their expected values, the ticked removals and the echoed from / includeClosed", () => {
    expect(applyRequest(PREVIEW, new Set([101, 102, 104, 105, 999]), new Set([34, 77]))).toEqual({
      from: "2026-11-08",
      includeClosed: false,
      items: [
        { sprintId: 101, expected: { action: "CREATE", effectiveFrom: "2026-11-09", mdPerWeek: 20 } },
        { sprintId: 102, expected: { action: "UPDATE", effectiveFrom: "2026-11-23", mdPerWeek: 18 } },
      ],
      removals: [34],
    });
    expect(applyRequest({ ...PREVIEW, includeClosed: true }, new Set(), new Set())).toEqual({ from: "2026-11-08", includeClosed: true, items: [], removals: [] });
  });

  test("a sprint is closed when it ended before from", () => {
    expect(isClosed(previewItem({ end: "2026-11-07" }), "2026-11-08")).toBe(true);
    expect(isClosed(previewItem({ end: "2026-11-08" }), "2026-11-08")).toBe(false);
    expect(isClosed(previewItem({ end: null }), "2026-11-08")).toBe(false);
  });

  test("the outcome names only what happened, in the plan's wording", () => {
    const skipped = { sprintId: 103, periodId: null, reason: "CHANGED" as const };
    expect(outcomeSentence({ created: [{ periodId: 1, sprintId: 1 }, { periodId: 2, sprintId: 2 }, { periodId: 3, sprintId: 3 }], updated: APPLIED.updated, deleted: [9], skipped: [skipped] }, t)).toBe(
      "3 created · 1 updated · 1 removed · 1 skipped: changed in the meantime",
    );
    expect(outcomeSentence({ created: [], updated: [], deleted: [], skipped: [] }, t)).toBe("Nothing was imported");
  });

  test("a refusal maps to its status sentence, and a 400 keeps the server's own detail", () => {
    const refusal = (status: number, detail?: string) => new ApiError(status, { status, title: "x", detail });
    expect(importFailure(refusal(403), t)).toEqual({ message: "Only the team's manager or an administrator can import capacity" });
    expect(importFailure(refusal(404), t).message).toBe("This link or team no longer exists — reload the page");
    expect(importFailure(refusal(400, "A sprint is listed twice"), t)).toEqual({ message: "The import was refused", detail: "A sprint is listed twice" });
    expect(importFailure(new TypeError("Failed to fetch"), t).message).toBe("Action failed. Check your connection and try again.");
  });
});
