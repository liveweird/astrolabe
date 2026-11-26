import { describe, expect, test } from "vitest";
import { planOf } from "../test/planView";
import { firstKnownFocus, focusTrail, foldableKeys, isFiltered, isSearching, knownFocus, matchCount, NO_FILTER, ownerOptions, planRows, programKey, projectKey, rowName, streamKey, toggledCollapsed, type PlanFilter } from "./planTree";

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

describe("planRows with a filter", () => {
  const PEOPLE = planOf([
    {
      id: 1,
      name: "Platform",
      ownerPersonId: 4,
      ownerName: "Ola Owner",
      programs: [
        {
          id: 10,
          name: "Billing",
          ownerPersonId: 6,
          ownerName: "Pola Program",
          projects: [
            { id: 100, name: "Invoices", ownerPersonId: 5, ownerName: "Piotr Project" },
            { id: 101, name: "Taxes", ownerPersonId: 8, ownerName: "Tania Tax" },
          ],
        },
        { id: 11, name: "Identity", ownerPersonId: 6, ownerName: "Pola Program", projects: [{ id: 102, name: "Żółw", ownerPersonId: 5, ownerName: "Piotr Project" }] },
      ],
    },
    { id: 2, name: "Legacy", endDate: "2025-12-31", ownerPersonId: 4, ownerName: "Ola Owner", programs: [{ id: 12, name: "Archive", ownerPersonId: 6, ownerName: "Pola Program", projects: [{ id: 103, name: "Old taxes", ownerPersonId: 5, ownerName: "Piotr Project" }] }] },
  ]);
  const filtered = (filter: Partial<PlanFilter>, collapsed: string[] = []) => planRows(PEOPLE, new Set(collapsed), { ...NO_FILTER, ...filter });
  const shape = (filter: Partial<PlanFilter>, collapsed: string[] = []) => filtered(filter, collapsed).map((row) => `${row.key}${row.context ? " (context)" : ""}`);

  test("no filter, a blank search and hide closed off are the whole plan", () => {
    expect(isSearching(NO_FILTER)).toBe(false);
    expect(isSearching({ ...NO_FILTER, q: "   " })).toBe(false);
    expect(isFiltered(NO_FILTER)).toBe(false);
    expect(shape({ q: "  " })).toEqual(planRows(PEOPLE, new Set()).map((row) => row.key));
  });

  test("a match shows with its ancestors as context rows and nothing else", () => {
    expect(shape({ q: "invoices" })).toEqual(["ws:1 (context)", "pg:10 (context)", "pj:100"]);
    expect(shape({ q: "tax" })).toEqual(["ws:1 (context)", "pg:10 (context)", "pj:101", "ws:2 (context)", "pg:12 (context)", "pj:103"]);
  });

  test("a matching parent shows everything under it, and is not a context row", () => {
    expect(shape({ q: "billing" })).toEqual(["ws:1 (context)", "pg:10", "pj:100", "pj:101"]);
    expect(shape({ q: "platform" })).toEqual(["ws:1", "pg:10", "pj:100", "pj:101", "pg:11", "pj:102"]);
  });

  test("a node that matches and holds a match is a match, not context", () => {
    // Billing and Invoices both contain "i": Billing is a match that holds a match, so it is no context row; Platform and Legacy only lead to matches.
    const rows = shape({ q: "i" });
    expect(rows).toContain("pg:10");
    expect(rows.filter((key) => key.endsWith("(context)"))).toEqual(["ws:1 (context)", "ws:2 (context)"]);
  });

  test("the search is case- and accent-insensitive", () => {
    expect(shape({ q: "ZOLW" })).toEqual(["ws:1 (context)", "pg:11 (context)", "pj:102"]);
    expect(shape({ q: "żółw" })).toEqual(shape({ q: "zolw" }));
  });

  test("an owner matches the nodes they own, with the way to them and what is under them", () => {
    expect(shape({ ownerPersonId: 8 })).toEqual(["ws:1 (context)", "pg:10 (context)", "pj:101"]);
    expect(shape({ ownerPersonId: 6 })).toEqual(["ws:1 (context)", "pg:10", "pj:100", "pj:101", "pg:11", "pj:102", "ws:2 (context)", "pg:12", "pj:103"]);
  });

  test("the search and the owner both have to hold", () => {
    expect(shape({ q: "tax", ownerPersonId: 5 })).toEqual(["ws:2 (context)", "pg:12 (context)", "pj:103"]);
    expect(shape({ q: "billing", ownerPersonId: 5 })).toEqual([]);
  });

  test("hide closed leaves out the closed streams, searched or not, and the stored folds still apply to the rest", () => {
    expect(shape({ hideClosed: true })).toEqual(["ws:1", "pg:10", "pj:100", "pj:101", "pg:11", "pj:102"]);
    expect(shape({ hideClosed: true }, ["pg:10"])).toEqual(["ws:1", "pg:10", "pg:11", "pj:102"]);
    expect(shape({ q: "tax", hideClosed: true })).toEqual(["ws:1 (context)", "pg:10 (context)", "pj:101"]);
  });

  test("the folds in force fold a search's rows too, and a folded match still counts its children", () => {
    const rows = filtered({ q: "tax" }, ["pg:10"]);
    expect(rows.map((row) => row.key)).toEqual(["ws:1", "pg:10", "ws:2", "pg:12", "pj:103"]);
    expect(rows[1]).toMatchObject({ context: true, expanded: false, childCount: 2 });
  });

  test("counts and parents are the document's own, whatever is hidden", () => {
    const rows = filtered({ q: "invoices" });
    expect(rows[0]).toMatchObject({ childCount: 2, parentKey: null });
    expect(rows[1]).toMatchObject({ childCount: 2, parentKey: "ws:1" });
    expect(rows[2]).toMatchObject({ parentKey: "pg:10" });
  });

  test("matchCount counts the matches only, never the context or the descendants of a match", () => {
    expect(matchCount(PEOPLE, NO_FILTER)).toBe(0);
    expect(matchCount(PEOPLE, { ...NO_FILTER, q: "tax" })).toBe(2);
    expect(matchCount(PEOPLE, { ...NO_FILTER, q: "billing" })).toBe(1);
    expect(matchCount(PEOPLE, { ...NO_FILTER, q: "tax", hideClosed: true })).toBe(1);
    expect(matchCount(PEOPLE, { ...NO_FILTER, q: "zzz" })).toBe(0);
  });

  test("foldableKeys follows the filter: only the shown nodes that have children", () => {
    expect(foldableKeys(PEOPLE)).toEqual(["ws:1", "pg:10", "pg:11", "ws:2", "pg:12"]);
    expect(foldableKeys(PEOPLE, { ...NO_FILTER, q: "invoices" })).toEqual(["ws:1", "pg:10"]);
    expect(foldableKeys(PEOPLE, { ...NO_FILTER, hideClosed: true })).toEqual(["ws:1", "pg:10", "pg:11"]);
  });

  test("ownerOptions lists each owner of any node once, by name", () => {
    expect(ownerOptions(PEOPLE)).toEqual([
      { id: 4, name: "Ola Owner" },
      { id: 6, name: "Pola Program" },
      { id: 5, name: "Piotr Project" },
      { id: 8, name: "Tania Tax" },
    ].sort((a, b) => a.name.localeCompare(b.name)));
  });
});

describe("planRows with a focus", () => {
  const FOCUSED = planOf([
    {
      id: 1,
      name: "Platform",
      programs: [
        { id: 10, name: "Billing", projects: [{ id: 100, name: "Invoices" }, { id: 101, name: "Taxes" }] },
        { id: 11, name: "Identity", projects: [{ id: 102, name: "Login" }] },
      ],
    },
    { id: 2, name: "Legacy", endDate: "2025-12-31", programs: [{ id: 12, name: "Archive", projects: [{ id: 103, name: "Old taxes" }] }] },
  ]);
  const shape = (filter: Partial<PlanFilter>, collapsed: string[] = []) =>
    planRows(FOCUSED, new Set(collapsed), { ...NO_FILTER, ...filter }).map((row) => `${row.key}/${row.indent}${row.context ? " (context)" : ""}${row.locked ? " (locked)" : ""}`);

  test("a work stream focus shows that stream and everything under it, and nothing else", () => {
    expect(shape({ focus: { kind: "workStream", id: 1 } })).toEqual(["ws:1/0 (locked)", "pg:10/1", "pj:100/2", "pj:101/2", "pg:11/1", "pj:102/2"]);
  });

  test("a program focus starts the table at the program: no work stream row, indents from the program", () => {
    const rows = planRows(FOCUSED, new Set(), { ...NO_FILTER, focus: { kind: "program", id: 10 } });
    expect(rows.map((row) => [row.key, row.parentKey, row.indent, row.locked])).toEqual([
      ["pg:10", null, 0, true],
      ["pj:100", "pg:10", 1, false],
      ["pj:101", "pg:10", 1, false],
    ]);
  });

  test("the focus root is always open, whatever the folds say; what is under it folds as usual", () => {
    expect(shape({ focus: { kind: "workStream", id: 1 } }, ["ws:1", "pg:10"])).toEqual(["ws:1/0 (locked)", "pg:10/1", "pg:11/1", "pj:102/2"]);
    expect(shape({ focus: { kind: "program", id: 10 } }, ["pg:10"])).toEqual(["pg:10/0 (locked)", "pj:100/1", "pj:101/1"]);
  });

  test("a search inside a focus is bounded to its subtree, and a program focus ignores its stream's own match", () => {
    expect(shape({ focus: { kind: "workStream", id: 1 }, q: "tax" })).toEqual(["ws:1/0 (context) (locked)", "pg:10/1 (context)", "pj:101/2"]);
    expect(shape({ focus: { kind: "program", id: 10 }, q: "platform" })).toEqual([]);
    expect(shape({ focus: { kind: "program", id: 10 }, q: "tax" })).toEqual(["pg:10/0 (context) (locked)", "pj:101/1"]);
  });

  test("hide closed drops closed streams, but never the one that holds the focus", () => {
    expect(shape({ hideClosed: true })).toEqual(["ws:1/0", "pg:10/1", "pj:100/2", "pj:101/2", "pg:11/1", "pj:102/2"]);
    expect(shape({ hideClosed: true, focus: { kind: "workStream", id: 2 } })).toEqual(["ws:2/0 (locked)", "pg:12/1", "pj:103/2"]);
    expect(shape({ hideClosed: true, focus: { kind: "program", id: 12 } })).toEqual(["pg:12/0 (locked)", "pj:103/1"]);
  });

  test("a focus is a filter for the print line but not a search for the folds", () => {
    expect(isFiltered({ ...NO_FILTER, focus: { kind: "program", id: 10 } })).toBe(true);
    expect(isSearching({ ...NO_FILTER, focus: { kind: "program", id: 10 } })).toBe(false);
  });

  test("counts of matches and foldable keys follow the focus", () => {
    expect(matchCount(FOCUSED, { ...NO_FILTER, q: "tax", focus: { kind: "workStream", id: 1 } })).toBe(1);
    expect(matchCount(FOCUSED, { ...NO_FILTER, q: "tax" })).toBe(2);
    // The focus root is always open: it never folds, so Collapse all has nothing to write for it.
    expect(foldableKeys(FOCUSED, { ...NO_FILTER, focus: { kind: "program", id: 10 } })).toEqual([]);
    expect(foldableKeys(FOCUSED, { ...NO_FILTER, focus: { kind: "workStream", id: 1 } })).toEqual(["pg:10", "pg:11"]);
  });

  test("firstKnownFocus skips a named node the plan lost and falls back to the next one", () => {
    const program = { kind: "program", id: 99 } as const;
    const stream = { kind: "workStream", id: 1 } as const;
    expect(firstKnownFocus(FOCUSED, [program, stream])).toEqual(stream);
    expect(firstKnownFocus(FOCUSED, [program])).toBeNull();
    expect(firstKnownFocus(FOCUSED, [])).toBeNull();
  });

  test("knownFocus keeps a focus the plan holds and drops one it does not", () => {
    expect(knownFocus(FOCUSED, { kind: "program", id: 10 })).toEqual({ kind: "program", id: 10 });
    expect(knownFocus(FOCUSED, { kind: "program", id: 99 })).toBeNull();
    expect(knownFocus(FOCUSED, { kind: "workStream", id: 10 })).toBeNull();
    expect(knownFocus(FOCUSED, null)).toBeNull();
  });

  test("focusTrail is the way down: the stream, then the program", () => {
    expect(focusTrail(FOCUSED, { kind: "workStream", id: 1 }).map((step) => step.key)).toEqual(["ws:1"]);
    expect(focusTrail(FOCUSED, { kind: "program", id: 12 }).map((step) => [step.key, step.name])).toEqual([["ws:2", "Legacy"], ["pg:12", "Archive"]]);
    expect(focusTrail(FOCUSED, { kind: "program", id: 99 })).toEqual([]);
    expect(focusTrail(FOCUSED, null)).toEqual([]);
  });
});
