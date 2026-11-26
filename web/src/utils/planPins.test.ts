import { describe, expect, test } from "vitest";
import { planOf } from "../test/planView";
import { livePins, pinnedFoldKey, pinnedRows, scopedLabel, withPinnedFolds, withPins } from "./planPins";

const PLAN = planOf([
  {
    id: 1,
    name: "Platform",
    programs: [
      { id: 10, name: "Billing", projects: [{ id: 100, name: "Invoices" }, { id: 101, name: "Taxes" }] },
      { id: 11, name: "Identity" },
    ],
  },
  { id: 2, name: "Legacy", programs: [{ id: 12, name: "Archive", projects: [{ id: 102, name: "Old" }] }] },
]);

const shape = (pins: string[], collapsed: string[] = []) => pinnedRows(PLAN, pins, new Set(collapsed)).map((row) => `${row.key}@${row.root}/${row.indent}`);

describe("pinnedRows", () => {
  test("a pinned work stream shows its whole subtree, indented from the root", () => {
    expect(shape(["ws:1"])).toEqual(["ws:1@ws:1/0", "pg:10@ws:1/1", "pj:100@ws:1/2", "pj:101@ws:1/2", "pg:11@ws:1/1"]);
  });

  test("a pinned program is its own root, a pinned project is one row", () => {
    expect(shape(["pg:10"])).toEqual(["pg:10@pg:10/0", "pj:100@pg:10/1", "pj:101@pg:10/1"]);
    expect(shape(["pj:101"])).toEqual(["pj:101@pj:101/0"]);
  });

  test("roots come in pin order, and the same node may be a root and a descendant of another root", () => {
    expect(shape(["pg:12", "ws:1", "pj:101"])).toEqual(["pg:12@pg:12/0", "pj:102@pg:12/1", "ws:1@ws:1/0", "pg:10@ws:1/1", "pj:100@ws:1/2", "pj:101@ws:1/2", "pg:11@ws:1/1", "pj:101@pj:101/0"]);
    expect(shape(["pg:10", "ws:1"]).filter((row) => row.startsWith("pg:10"))).toEqual(["pg:10@pg:10/0", "pg:10@ws:1/1"]);
  });

  test("folds are the pinned section's own, by composite key", () => {
    expect(shape(["ws:1"], [pinnedFoldKey("ws:1", "pg:10")])).toEqual(["ws:1@ws:1/0", "pg:10@ws:1/1", "pg:11@ws:1/1"]);
    expect(shape(["ws:1"], [pinnedFoldKey("ws:1", "ws:1")])).toEqual(["ws:1@ws:1/0"]);
    // A fold made in the tree (the plain key) is not this section's.
    expect(shape(["ws:1"], ["pg:10", "ws:1"])).toHaveLength(5);
    expect(pinnedRows(PLAN, ["ws:1"], new Set())[0]).toMatchObject({ childCount: 2, expanded: true, parentKey: null, locked: false, context: false });
  });

  test("a childless node is never expanded, a duplicate pin shows once, a deleted node's pin shows nothing", () => {
    expect(pinnedRows(PLAN, ["pg:11"], new Set())[0]).toMatchObject({ childCount: 0, expanded: false });
    expect(shape(["pg:10", "pg:10"])).toHaveLength(3);
    expect(shape(["pg:999", "ws:404"])).toEqual([]);
  });
});

describe("pins and their folds", () => {
  test("livePins drops the nodes the plan no longer holds and keeps the order", () => {
    expect(livePins(PLAN, ["pg:12", "ws:9", "ws:1", "pg:12"])).toEqual(["pg:12", "ws:1"]);
  });

  test("withPins appends, removes, never doubles, and prunes the deleted", () => {
    expect(withPins(PLAN, ["ws:1"], { add: "pg:10" })).toEqual(["ws:1", "pg:10"]);
    expect(withPins(PLAN, ["ws:1", "pg:10"], { add: "ws:1" })).toEqual(["ws:1", "pg:10"]);
    expect(withPins(PLAN, ["ws:1", "pg:10"], { remove: "ws:1" })).toEqual(["pg:10"]);
    expect(withPins(PLAN, ["ws:1", "pg:999", "pj:404"], { add: "ws:2" })).toEqual(["ws:1", "ws:2"]);
  });

  test("withPinnedFolds flips one composite key and drops those of a pin or node that is gone", () => {
    const key = pinnedFoldKey("ws:1", "pg:10");
    expect(withPinnedFolds(PLAN, new Set(), { toggle: key })).toEqual([key]);
    expect(withPinnedFolds(PLAN, new Set([key]), { toggle: key })).toEqual([]);
    expect(withPinnedFolds(PLAN, new Set([pinnedFoldKey("ws:9", "pg:10"), pinnedFoldKey("ws:1", "pg:77")]), { toggle: key })).toEqual([key]);
  });
});

test("scopedLabel wraps a name in the pinned section only", () => {
  const t = ((key: string, vars: { name: string }) => (key === "plan.pin.nameOf" ? `${vars.name} (pinned)` : key)) as never;
  expect(scopedLabel(t, "tree", "Edit X")).toBe("Edit X");
  expect(scopedLabel(t, "pinned", "Edit X")).toBe("Edit X (pinned)");
});
