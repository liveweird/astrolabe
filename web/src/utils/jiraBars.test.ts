import { describe, expect, test } from "vitest";
import { jiraRangeDates, jiraWindow, visibleJiraDates } from "./jiraBars";

describe("jiraWindow", () => {
  test("the plan's earliest and latest date, a year either side", () => {
    expect(jiraWindow(["2026-06-01", "2026-03-02", "2027-01-15"], "2030-01-01")).toEqual({ from: "2025-03-02", to: "2028-01-15" });
  });

  test("a plan with no dates uses today, a year either side", () => {
    expect(jiraWindow([], "2026-11-07")).toEqual({ from: "2025-11-07", to: "2027-11-07" });
  });
});

describe("visibleJiraDates", () => {
  const window = { from: "2025-03-02", to: "2028-01-15" };
  const link = (start: string | null, end: string | null) => ({ start, end });

  test("dates inside the window are as they are", () => {
    expect(visibleJiraDates(link("2026-03-09", "2026-04-03"), window)).toEqual({ start: "2026-03-09", end: "2026-04-03" });
  });

  test("a date beyond an edge is cut at it; a range wholly outside is nothing", () => {
    expect(visibleJiraDates(link("2026-03-09", "2206-04-03"), window)).toEqual({ start: "2026-03-09", end: "2028-01-15" });
    expect(visibleJiraDates(link("1906-03-09", "2026-04-03"), window)).toEqual({ start: "2025-03-02", end: "2026-04-03" });
    expect(visibleJiraDates(link("2206-03-09", "2206-04-03"), window)).toBeNull();
    expect(visibleJiraDates(link("1906-03-09", "1906-04-03"), window)).toBeNull();
  });

  test("both dates or nothing: a link with one date, or none, or no link draws nothing", () => {
    expect(visibleJiraDates(link("2026-03-09", null), window)).toBeNull();
    expect(visibleJiraDates(link(null, "2026-04-03"), window)).toBeNull();
    expect(visibleJiraDates(link(null, null), window)).toBeNull();
    expect(visibleJiraDates(null, window)).toBeNull();
  });
});

test("jiraRangeDates lists both visible ends of each row that draws a bar, and nothing for the rest", () => {
  const window = { from: "2025-03-02", to: "2028-01-15" };
  const rows = [{ jira: { start: "2026-03-09", end: "2206-04-03" } }, { jira: { start: "2026-03-09", end: null } }, { jira: null }, { jira: { start: "2206-01-01", end: "2206-02-01" } }];
  expect(jiraRangeDates(rows, window)).toEqual(["2026-03-09", "2028-01-15"]);
});
