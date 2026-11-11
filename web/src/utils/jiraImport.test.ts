import { describe, expect, test } from "vitest";
import { allSelectable, blockingParent, emptyScope, indexItems, tickRow, toApplyRequest, toScope, unscheduledForRights, updatedWithinOf } from "./jiraImport";
import { PREVIEW_ITEMS } from "../test/jiraImport";

const SCOPE = { workStreamId: 3, ownerPersonId: 8, copyDates: true };
const index = indexItems(PREVIEW_ITEMS);
const ids = (set: ReadonlySet<string>) => [...set].sort();

describe("ticks", () => {
  test("only the rows the preview would write are tickable", () => {
    expect(ids(allSelectable(PREVIEW_ITEMS))).toEqual(["95001", "95002", "95003", "95004", "95005", "95009", "95010"]);
  });

  test("unticking a parent unticks everything created under it, and says how many moved with it", () => {
    const result = tickRow(index, allSelectable(PREVIEW_ITEMS), "95001", false);
    expect(ids(result.ticks)).toEqual(["95009", "95010"]);
    expect(result.alsoChanged).toBe(4);
    const alpha = tickRow(index, allSelectable(PREVIEW_ITEMS), "95002", false);
    expect(ids(alpha.ticks)).toEqual(["95001", "95003", "95009", "95010"]);
    expect(alpha.alsoChanged).toBe(2);
  });

  test("ticking a child ticks the rows it is created under; a sibling stays as it was", () => {
    const none = new Set<string>();
    const result = tickRow(index, none, "95004", true);
    expect(ids(result.ticks)).toEqual(["95001", "95002", "95004"]);
    expect(result.alsoChanged).toBe(2);
    expect(tickRow(index, none, "95010", true)).toMatchObject({ alsoChanged: 0 });
  });

  test("an unticked row under an unticked parent names that parent; a deliberately unticked leaf does not", () => {
    const ticks = tickRow(index, allSelectable(PREVIEW_ITEMS), "95002", false).ticks;
    const child = PREVIEW_ITEMS.find((i) => i.jiraId === "95004")!;
    expect(blockingParent(index, ticks, child)?.issueKey).toBe("IMP-2");
    const leafOnly = tickRow(index, allSelectable(PREVIEW_ITEMS), "95004", false).ticks;
    expect(blockingParent(index, leafOnly, child)).toBeUndefined();
    expect(blockingParent(index, ticks, PREVIEW_ITEMS.find((i) => i.jiraId === "95008")!)).toBeUndefined();
  });

  test("ticked milestones the server marked DATES_NOT_COPIED are counted, only while dates are copied", () => {
    const all = allSelectable(PREVIEW_ITEMS);
    expect(unscheduledForRights(PREVIEW_ITEMS, all, true)).toEqual({ count: 1, of: 2 });
    expect(unscheduledForRights(PREVIEW_ITEMS, new Set([...all].filter((id) => id !== "95005")), true)).toEqual({ count: 0, of: 1 });
    expect(unscheduledForRights(PREVIEW_ITEMS, all, false)).toEqual({ count: 0, of: 0 });
  });
});

describe("the scope", () => {
  const keys = ["IMP", "OUT"];
  test("is null until a work stream, an owner and a key are picked", () => {
    expect(toScope(emptyScope(keys), keys)).toBeNull();
    const form = { ...emptyScope(keys), workStreamId: "3", owner: { value: "8", label: "Ola" } };
    expect(toScope({ ...form, keys: [] }, keys)).toBeNull();
    expect(toScope(form, keys)).toEqual({ ...SCOPE, filter: { excludeDone: true, updatedWithinDays: 365 } });
  });

  test("a subset of the keys and the defaults are sent; all keys are not", () => {
    const form = { ...emptyScope(keys), workStreamId: "3", owner: { value: "8", label: "Ola" }, keys: ["IMP"], programId: "4", projectId: "9", team: { value: "5", label: "T" }, copyDates: false };
    expect(toScope(form, keys)).toEqual({ workStreamId: 3, ownerPersonId: 8, projectKeys: ["IMP"], defaults: { programId: 4, projectId: 9, teamId: 5 }, copyDates: false, filter: { excludeDone: true, updatedWithinDays: 365 } });
  });
});

describe("the import filter", () => {
  const keys = ["IMP"];
  const ready = { ...emptyScope(keys), workStreamId: "3", owner: { value: "8", label: "Ola" } };

  test("opens with done items left out and a 365-day window", () => {
    expect(emptyScope(keys)).toMatchObject({ excludeDone: true, updatedWithinDays: 365 });
  });

  test.each([
    ["both on", true, 30, { excludeDone: true, updatedWithinDays: 30 }],
    ["done only (the field emptied)", true, "", { excludeDone: true }],
    ["the window only", false, 90, { excludeDone: false, updatedWithinDays: 90 }],
    ["the upper bound", true, 3650, { excludeDone: true, updatedWithinDays: 3650 }],
    ["the lower bound", true, 1, { excludeDone: true, updatedWithinDays: 1 }],
  ])("%s sends the filter the controls say", (_name, excludeDone, updatedWithinDays, filter) => {
    expect(toScope({ ...ready, excludeDone, updatedWithinDays }, keys)).toEqual({ ...SCOPE, filter });
  });

  test("both off and an empty field send no filter at all", () => {
    const scope = toScope({ ...ready, excludeDone: false, updatedWithinDays: "" }, keys);
    expect(scope).toEqual(SCOPE);
    expect(scope).not.toHaveProperty("filter");
  });

  test.each([0, 3651, 1.5, -5, "abc"])("a days value of %j the server would refuse is no scope", (value) => {
    expect(updatedWithinOf(value)).toBeNull();
    expect(toScope({ ...ready, updatedWithinDays: value }, keys)).toBeNull();
  });

  test("a blank field is no time limit", () => {
    expect(updatedWithinOf("")).toEqual({ days: null });
    expect(updatedWithinOf("  ")).toEqual({ days: null });
  });

  test("the apply body carries the scope's filter as the preview read it", () => {
    const scope = toScope(ready, keys)!;
    const body = toApplyRequest(scope, PREVIEW_ITEMS, allSelectable(PREVIEW_ITEMS), new Map());
    expect(body.filter).toEqual({ excludeDone: true, updatedWithinDays: 365 });
    expect(toApplyRequest(SCOPE, PREVIEW_ITEMS, allSelectable(PREVIEW_ITEMS), new Map())).not.toHaveProperty("filter");
  });
});

describe("the apply body", () => {
  const find = (key: string) => toApplyRequest(SCOPE, PREVIEW_ITEMS, allSelectable(PREVIEW_ITEMS), new Map()).items.find((i) => i.jiraId === key)!;

  test("projects the landing to {kind, nodeId} and carries the team the row showed", () => {
    expect(find("95004")).toEqual({ jiraId: "95004", expected: { action: "CREATE", level: "MILESTONE", parentJiraId: "95002", parent: { kind: "NEW_ROW" }, teamId: 5 } });
    expect(find("95010").expected).toEqual({ action: "CREATE", level: "MILESTONE", parent: { kind: "EXISTING", nodeId: 40 }, teamId: 5 });
    expect(find("95001").expected).toEqual({ action: "CREATE", level: "PROGRAM" });
  });

  test("a BIND carries its target node and no landing", () => {
    expect(find("95009").expected).toEqual({ action: "BIND", level: "PROJECT", parentJiraId: "95001", nodeId: 77 });
  });

  test("an override goes in overrides, only where it differs, and never into expected", () => {
    const body = toApplyRequest(SCOPE, PREVIEW_ITEMS, allSelectable(PREVIEW_ITEMS), new Map([["95004", 6], ["95005", 6]]));
    const first = body.items.find((i) => i.jiraId === "95004")!;
    expect(first.overrides).toEqual({ teamId: 6 });
    expect(first.expected.teamId).toBe(5);
    expect(body.items.find((i) => i.jiraId === "95005")!.overrides).toBeUndefined();
  });

  test("only ticked rows are sent, in preview order", () => {
    const body = toApplyRequest(SCOPE, PREVIEW_ITEMS, new Set(["95010", "95001", "95008"]), new Map());
    expect(body.items.map((i) => i.jiraId)).toEqual(["95001", "95010"]);
  });
});
