import { describe, expect, test } from "vitest";
import i18n from "../i18n";
import { ApiError } from "../api/http";
import { APPLIED, PREVIEW, previewItem } from "../test/flow";
import { applyRequest, calendarDays, defaultTicks, importFailure, infoSentence, isClosed, isImportable, outcomeSentence } from "./capacityImport";

const t = i18n.t.bind(i18n);

describe("capacity import helpers", () => {
  test("the calendar days count both ends, across a month, a year and a leap day", () => {
    expect(calendarDays("2026-11-02", "2026-11-02")).toBe(1);
    expect(calendarDays("2026-11-02", "2026-11-13")).toBe(12);
    expect(calendarDays("2026-11-02", "2026-12-31")).toBe(60);
    expect(calendarDays("2026-11-02", "2027-01-01")).toBe(61);
    expect(calendarDays("2025-11-01", "2027-09-08")).toBe(677);
    expect(calendarDays("2028-02-28", "2028-03-01")).toBe(3);
  });

  test("each info reads as its sentence; the long window names the row's own calendar days", () => {
    const item = previewItem({ start: "2025-11-01", end: "2027-09-08" });
    expect(infoSentence({ code: "MANUAL_PERIOD_INSIDE", date: "2026-11-30" }, item, t)).toBe(
      "A hand-entered period starts on 2026-11-30, inside the sprint: the sprint's figure will not hold from then.",
    );
    expect(infoSentence({ code: "ZERO_CAPACITY", date: null }, item, t)).toBe("Flow's figure is 0 man-days: not selected by default.");
    expect(infoSentence({ code: "LONG_WINDOW", date: null }, item, t)).toContain("This sprint spans 677 calendar days, more than Flow's 60-day cap");
    expect(infoSentence({ code: "FIXED_FIGURE", date: null, days: 10 }, item, t)).toBe(
      "Flow's figure is a fixed total for the whole sprint, so it is spread over the sprint's 10 working days; some of its days belong to an earlier sprint.",
    );
  });

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
