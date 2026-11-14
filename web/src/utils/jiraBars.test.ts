import { describe, expect, test } from "vitest";
import i18n from "../i18n";
import { baselineUnscheduledIds, jiraPageRange, jiraRangeDates, jiraScheduleDates, jiraTrayBars, jiraTrayRowId, jiraTrayRows, jiraWindow, visibleJiraDates } from "./jiraBars";

const t = i18n.getFixedT("en");

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

describe("jiraPageRange", () => {
  const rows = [{ jira: { start: "2027-03-01", end: "2027-03-05" } }, { jira: null }, { jira: { start: "2027-04-01", end: null } }];

  test("with the toggle off: no window and the plan's own dates only", () => {
    expect(jiraPageRange(false, ["2027-01-11", "2027-01-22"], rows, "2027-01-01")).toEqual({ window: null, dates: ["2027-01-11", "2027-01-22"] });
  });

  test("with it on: the window a year either side of the plan, and the Jira dates of the rows that draw a bar join the range", () => {
    expect(jiraPageRange(true, ["2027-01-11", "2027-01-22"], rows, "2027-01-01")).toEqual({
      window: { from: "2026-01-11", to: "2028-01-22" },
      dates: ["2027-01-11", "2027-01-22", "2027-03-01", "2027-03-05"],
    });
  });

  test("a Jira range wholly outside the window adds nothing", () => {
    expect(jiraPageRange(true, ["2027-01-11"], [{ jira: { start: "2040-01-01", end: "2040-01-05" } }], "2027-01-01").dates).toEqual(["2027-01-11"]);
  });
});

describe("the tray milestones' Jira rows (1.16)", () => {
  const window = { from: "2025-03-02", to: "2028-01-15" };
  const tray = (id: number, name: string, start: string | null, end: string | null, key = `E2E-${id}`) => ({
    id,
    name,
    jira: start === null && end === null ? null : { issueKey: key, start, end },
    flags: [],
  });

  test("jiraTrayBars: a bar per milestone with both dates inside the window, named as a scheduled row's, keyed by milestone id", () => {
    const bars = jiraTrayBars([tray(1, "Both", "2026-03-09", "2026-04-03"), tray(2, "One", "2026-03-09", null), tray(3, "None", null, null), tray(4, "Outside", "2206-03-09", "2206-04-03")], window, t);
    expect([...bars.keys()]).toEqual([1]);
    expect(bars.get(1)).toEqual({
      id: "jira:1",
      start: "2026-03-09",
      end: "2026-04-03",
      label: "Both",
      describe: "Jira E2E-1: 2026-03-09 to 2026-04-03",
      editable: false,
      tone: "jira",
    });
  });

  test("jiraTrayBars: cut at the window's edge, and the real dates stay in the name", () => {
    const bar = jiraTrayBars([tray(1, "Long", "2026-03-09", "2206-04-03")], window, t).get(1);
    expect(bar).toMatchObject({ start: "2026-03-09", end: "2028-01-15", describe: "Jira E2E-1: 2026-03-09 to 2206-04-03" });
  });

  test("jiraTrayBars: no window (the toggle is off) is no bar", () => {
    expect(jiraTrayBars([tray(1, "Both", "2026-03-09", "2026-04-03")], null, t).size).toBe(0);
  });

  test("jiraTrayBars: an open date deviation's sentence is appended to the bar's name", () => {
    const flags = [{ kind: "JIRA_DEVIATION", deviation: { kind: "END_DIFFERS" as const, severity: "WARNING" as const, detail: { jira: "2026-04-03", plan: "2026-04-09", days: 4 } } }];
    const bar = jiraTrayBars([{ ...tray(1, "Both", "2026-03-09", "2026-04-03"), flags }], window, t).get(1);
    expect(bar?.describe).toMatch(/^Jira E2E-1: 2026-03-09 to 2026-04-03, /);
  });

  test("jiraTrayRows: only the milestones with a bar that no baseline row took, in (drawn start, drawn end, name case-insensitively, id) order", () => {
    const items = [
      tray(1, "zeta", "2026-03-09", "2026-03-13"),
      tray(2, "Alpha", "2026-03-09", "2026-03-13"),
      tray(3, "Early", "2026-02-02", "2026-02-06"),
      tray(4, "Short", "2026-03-09", "2026-03-10"),
      tray(5, "Taken", "2026-01-05", "2026-01-09"),
      tray(6, "NoBar", "2026-03-09", null),
      tray(7, "alpha", "2026-03-09", "2026-03-13"),
    ];
    const bars = jiraTrayBars(items, window, t);
    expect(jiraTrayRows(items, bars, new Set([5])).map((m) => m.name)).toEqual(["Early", "Short", "Alpha", "alpha", "zeta"]);
    expect(jiraTrayRows(items, bars, new Set()).map((m) => m.id)).toEqual([5, 3, 4, 2, 7, 1]);
    expect(jiraTrayRows(items, new Map(), new Set())).toEqual([]);
  });

  test("the order follows the DRAWN dates: a bar cut at the window's edge sorts by the edge", () => {
    const items = [tray(1, "B", "1999-01-01", "2026-03-13"), tray(2, "A", "2025-03-02", "2026-03-13")];
    expect(jiraTrayRows(items, jiraTrayBars(items, window, t), new Set()).map((m) => m.id)).toEqual([2, 1]);
  });

  test("baselineUnscheduledIds: only the 'unscheduled' rows' milestones; jiraTrayRowId is apart from the baseline's row id", () => {
    expect(
      baselineUnscheduledIds([
        { reason: "removed", milestoneId: 1 },
        { reason: "unscheduled", milestoneId: 2 },
        { reason: "moved", milestoneId: 3 },
      ]),
    ).toEqual(new Set([2]));
    expect(jiraTrayRowId(9)).toBe("jira-unscheduled:9");
  });
});

describe("jiraScheduleDates (1.17)", () => {
  test("both dates, in order: exactly the link's dates (also a single day)", () => {
    expect(jiraScheduleDates({ start: "2026-03-09", end: "2026-04-03" })).toEqual({ start: "2026-03-09", end: "2026-04-03" });
    expect(jiraScheduleDates({ start: "2026-03-09", end: "2026-03-09" })).toEqual({ start: "2026-03-09", end: "2026-03-09" });
  });

  test("the REAL dates, even where the bar is drawn cut at the window", () => {
    const link = { start: "2026-03-09", end: "2090-04-03" };
    expect(visibleJiraDates(link, { from: "2025-03-02", to: "2028-01-15" })?.end).toBe("2028-01-15");
    expect(jiraScheduleDates(link)).toEqual(link);
  });

  test("one date, none, a reversed pair or no link: nothing to write", () => {
    expect(jiraScheduleDates({ start: "2026-03-09", end: null })).toBeNull();
    expect(jiraScheduleDates({ start: null, end: "2026-03-09" })).toBeNull();
    expect(jiraScheduleDates({ start: null, end: null })).toBeNull();
    expect(jiraScheduleDates({ start: "2026-04-03", end: "2026-03-09" })).toBeNull();
    expect(jiraScheduleDates(null)).toBeNull();
  });
});
