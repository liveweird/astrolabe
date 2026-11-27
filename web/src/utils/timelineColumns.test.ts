import { describe, expect, test } from "vitest";
import { DEFAULT_COLUMN_PREFS, hiddenColumnIds, isColumnPrefs, pickedColumns, toggledAll, type ColumnPrefs } from "./timelineColumns";
import type { TimelineColumn } from "./timelineModel";

const col = (id: string): TimelineColumn => ({ id, header: id, width: 100, hideable: true });
const OFFERED = [col("team"), col("estimate"), col("flags")];
const prefs = (collapsed: boolean, ...hidden: string[]): ColumnPrefs => ({ collapsed, hidden });
const ids = (set: ReadonlySet<string>) => [...set].sort();

describe("isColumnPrefs", () => {
  test("accepts the stored shape and the default", () => {
    expect(isColumnPrefs(DEFAULT_COLUMN_PREFS)).toBe(true);
    expect(isColumnPrefs({ collapsed: true, hidden: ["team", "gone"] })).toBe(true);
  });

  test.each([
    ["null", null],
    ["a string", "collapsed"],
    ["an array", []],
    ["a missing hidden", { collapsed: false }],
    ["a missing collapsed", { hidden: [] }],
    ["a non-boolean collapsed", { collapsed: "yes", hidden: [] }],
    ["a non-array hidden", { collapsed: false, hidden: "team" }],
    ["a non-string id", { collapsed: false, hidden: ["team", 3] }],
    ["more than 16 ids", { collapsed: false, hidden: Array.from({ length: 17 }, (_, i) => `c${i}`) }],
  ])("rejects %s", (_name, value) => {
    expect(isColumnPrefs(value)).toBe(false);
  });
});

describe("hiddenColumnIds", () => {
  test("nothing is hidden on a first visit", () => {
    expect(ids(hiddenColumnIds(DEFAULT_COLUMN_PREFS, OFFERED))).toEqual([]);
  });

  test("collapsed hides every offered column, whatever the pick", () => {
    expect(ids(hiddenColumnIds(prefs(true), OFFERED))).toEqual(["estimate", "flags", "team"]);
  });

  test("a pick hides its offered columns; an id nothing offers is ignored", () => {
    expect(ids(hiddenColumnIds(prefs(false, "estimate", "slack"), OFFERED))).toEqual(["estimate"]);
  });
});

describe("toggledAll", () => {
  test("collapses while any column is drawn, keeping the pick", () => {
    expect(toggledAll(prefs(false, "team"), OFFERED)).toEqual(prefs(true, "team"));
  });

  test("collapse then expand keeps the per-column pick", () => {
    const collapsed = toggledAll(prefs(false, "team"), OFFERED);
    const expanded = toggledAll(collapsed, OFFERED);
    expect(expanded).toEqual(prefs(false, "team"));
    expect(ids(hiddenColumnIds(expanded, OFFERED))).toEqual(["team"]);
  });

  test("a pick that hides every column is cleared on expanding: everything shows", () => {
    const expanded = toggledAll(prefs(true, "team", "estimate", "flags", "slack"), OFFERED);
    expect(expanded).toEqual(prefs(false, "slack"));
    expect(ids(hiddenColumnIds(expanded, OFFERED))).toEqual([]);
  });

  test("with every column unticked by hand the toggle shows them all", () => {
    expect(toggledAll(prefs(false, "team", "estimate", "flags"), OFFERED)).toEqual(prefs(false));
  });
});

describe("pickedColumns", () => {
  test("never stores more ids than isColumnPrefs accepts: the offered ids first, then the kept ones", () => {
    const stale = Array.from({ length: 16 }, (_, i) => `gone${i}`);
    const next = pickedColumns(prefs(false, ...stale), OFFERED, []);
    expect(next.hidden).toHaveLength(16);
    expect(next.hidden.slice(0, 3)).toEqual(["team", "estimate", "flags"]);
    expect(isColumnPrefs(next)).toBe(true);
  });

  test("hides the offered columns that were not shown", () => {
    expect(pickedColumns(DEFAULT_COLUMN_PREFS, OFFERED, ["team", "flags"])).toEqual(prefs(false, "estimate"));
  });

  test("a tick while collapsed shows that column alone", () => {
    const next = pickedColumns(prefs(true), OFFERED, ["estimate"]);
    expect(next).toEqual(prefs(false, "team", "flags"));
    expect(ids(hiddenColumnIds(next, OFFERED))).toEqual(["flags", "team"]);
  });

  test("a column the page does not offer now keeps its earlier choice", () => {
    const next = pickedColumns(prefs(false, "slack", "team"), OFFERED, ["team", "estimate", "flags"]);
    expect(next).toEqual(prefs(false, "slack"));
    // Slack comes back (Critical path on): still hidden
    expect(ids(hiddenColumnIds(next, [...OFFERED, col("slack")]))).toEqual(["slack"]);
  });
});
