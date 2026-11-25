import { describe, expect, test } from "vitest";
import { planOf } from "../test/planView";
import { foldableKeys, planRows, programKey, projectKey, rowName, streamKey, toggledCollapsed } from "./planTree";

const PLAN = planOf([
  {
    id: 1,
    name: "Platform",
    programs: [
      { id: 10, name: "Billing", projects: [{ id: 100, name: "Invoices" }, { id: 101, name: "Taxes" }] },
      { id: 11, name: "Identity" },
    ],
  },
  { id: 2, name: "Legacy", endDate: "2025-12-31" },
]);

const keysOf = (collapsed: string[] = []) => planRows(PLAN, new Set(collapsed)).map((row) => row.key);

describe("planRows", () => {
  test("keys are kind plus id, and every node is open when nothing is folded", () => {
    expect(streamKey(1)).toBe("ws:1");
    expect(programKey(10)).toBe("pg:10");
    expect(projectKey(100)).toBe("pj:100");
    expect(keysOf()).toEqual(["ws:1", "pg:10", "pj:100", "pj:101", "pg:11", "ws:2"]);
  });

  test("a row names its parent, its depth and its counts", () => {
    const rows = planRows(PLAN, new Set());
    expect(rows.map((row) => [row.key, row.parentKey, row.depth])).toEqual([
      ["ws:1", null, 0],
      ["pg:10", "ws:1", 1],
      ["pj:100", "pg:10", 2],
      ["pj:101", "pg:10", 2],
      ["pg:11", "ws:1", 1],
      ["ws:2", null, 0],
    ]);
    expect(rows[0]).toMatchObject({ kind: "workStream", childCount: 2, expanded: true });
    expect(rows[1]).toMatchObject({ kind: "program", childCount: 2, expanded: true });
    expect(rows.every((row) => !row.context)).toBe(true);
  });

  test("a folded node hides everything under it and says it is folded", () => {
    expect(keysOf(["pg:10"])).toEqual(["ws:1", "pg:10", "pg:11", "ws:2"]);
    expect(planRows(PLAN, new Set(["pg:10"]))[1]).toMatchObject({ expanded: false, childCount: 2 });
    expect(keysOf(["ws:1"])).toEqual(["ws:1", "ws:2"]);
  });

  test("a childless node is never expanded, and a key the plan does not hold changes nothing", () => {
    expect(planRows(PLAN, new Set()).find((row) => row.key === "ws:2")).toMatchObject({ childCount: 0, expanded: false });
    expect(keysOf(["ws:99", "pg:77", "pj:5"])).toEqual(keysOf());
  });

  test("the order is the view's own", () => {
    const reversed = { ...PLAN, workStreams: [...PLAN.workStreams].reverse() };
    expect(planRows(reversed, new Set()).map((row) => row.key)).toEqual(["ws:2", "ws:1", "pg:10", "pj:100", "pj:101", "pg:11"]);
  });

  test("an empty plan has no rows", () => {
    expect(planRows(planOf([]), new Set())).toEqual([]);
  });
});

describe("foldableKeys and toggledCollapsed", () => {
  test("only nodes with children can fold", () => {
    expect(foldableKeys(PLAN)).toEqual(["ws:1", "pg:10"]);
  });

  test("a toggle flips one key", () => {
    expect(toggledCollapsed(PLAN, new Set(), "ws:1")).toEqual(["ws:1"]);
    expect(toggledCollapsed(PLAN, new Set(["ws:1", "pg:10"]), "ws:1")).toEqual(["pg:10"]);
  });

  test("a change drops the keys of nodes the plan no longer holds, and keeps those of nodes it holds", () => {
    expect(toggledCollapsed(PLAN, new Set(["ws:99", "pg:10", "pj:5"]), "ws:1")).toEqual(["pg:10", "ws:1"]);
  });
});

test("rowName reads the node's own name at every level", () => {
  const rows = planRows(PLAN, new Set());
  expect(rows.map(rowName)).toEqual(["Platform", "Billing", "Invoices", "Taxes", "Identity", "Legacy"]);
});
