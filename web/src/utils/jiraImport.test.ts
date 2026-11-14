import { describe, expect, test } from "vitest";
import type { JiraImportItem } from "../api/jira";
import {
  allSelectable,
  blockingParent,
  carriedPicks,
  carriedTicks,
  emptyScope,
  hasSuggestion,
  indexItems,
  isConfirmedMatch,
  isMatchRow,
  type MatchChange,
  nextMatches,
  searchItems,
  tickRow,
  tickShown,
  toApplyRequest,
  toScope,
  unscheduledForRights,
  updatedWithinOf,
  withMatches,
  type ImportRoot,
} from "./jiraImport";
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

describe("the preview search", () => {
  const keys = (rows: readonly { issueKey: string | null }[]) => rows.map((row) => row.issueKey);
  const redacted = PREVIEW_ITEMS.map((item) => (item.issueKey === "IMP-11" ? { ...item, jiraId: "hidden-11", issueKey: null, name: "", summary: "" } : item));

  test("a blank or whitespace query keeps every row, in order", () => {
    expect(searchItems(PREVIEW_ITEMS, "")).toBe(PREVIEW_ITEMS);
    expect(searchItems(PREVIEW_ITEMS, "   ")).toBe(PREVIEW_ITEMS);
  });

  test("matches the key, the id, the summary and the name as a substring, ignoring case and accents", () => {
    expect(keys(searchItems(PREVIEW_ITEMS, " imp-4 "))).toEqual(["IMP-4"]);
    expect(keys(searchItems(PREVIEW_ITEMS, "95009"))).toEqual(["IMP-9"]);
    expect(keys(searchItems(PREVIEW_ITEMS, "EXISTING"))).toEqual(["IMP-9"]);
    const accented = PREVIEW_ITEMS.map((item) => (item.issueKey === "IMP-5" ? { ...item, summary: "Zażółć gęślą jaźń" } : item));
    expect(keys(searchItems(accented, "ZAZOLC GESLA"))).toEqual(["IMP-5"]);
    expect(keys(searchItems(accented, "zazolc jazn x"))).toEqual([]);
    expect(keys(searchItems(accented, "zazolc gesla"))).toEqual(["IMP-5"]);
  });

  test("a redacted row (no key) never matches a non-empty query, and is kept for a blank one", () => {
    expect(searchItems(redacted, "hidden")).toEqual([]);
    expect(searchItems(redacted, "hidden-11")).toEqual([]);
    expect(searchItems(redacted, "11")).toEqual([]);
    expect(searchItems(redacted, "")).toHaveLength(PREVIEW_ITEMS.length);
  });

  test("tickShown ticks the shown selectable rows and what they are created under, and counts only the rows outside the shown ones", () => {
    const shown = searchItems(PREVIEW_ITEMS, "Epic");
    const result = tickShown(index, new Set(), shown, true);
    expect(ids(result.ticks)).toEqual(["95001", "95002", "95004", "95005", "95010"]);
    expect(result.alsoChanged).toBe(2);
  });

  test("tickShown unticks the shown rows and what is created under them, shown or not; other rows are untouched", () => {
    const all = allSelectable(PREVIEW_ITEMS);
    const result = tickShown(index, all, searchItems(PREVIEW_ITEMS, "Initiative Alpha"), false);
    expect(ids(result.ticks)).toEqual(["95001", "95003", "95009", "95010"]);
    expect(result.alsoChanged).toBe(2);
    expect(tickShown(index, all, PREVIEW_ITEMS, false)).toMatchObject({ alsoChanged: 0, ticks: new Set() });
    expect(ids(tickShown(index, new Set(), PREVIEW_ITEMS, true).ticks)).toEqual(ids(all));
  });

  test("tickShown skips a SKIP row and reports nothing moved when the shown rows are already as asked", () => {
    const all = allSelectable(PREVIEW_ITEMS);
    expect(tickShown(index, all, searchItems(PREVIEW_ITEMS, "IMP-8"), true)).toEqual({ ticks: all, alsoChanged: 0 });
    expect(tickShown(index, all, searchItems(PREVIEW_ITEMS, "IMP-4"), true)).toEqual({ ticks: all, alsoChanged: 0 });
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

describe("a rooted scope (1.14)", () => {
  const keys = ["IMC", "OUT"];
  const owner = { value: "8", label: "Ola" };
  const root = (level: ImportRoot["level"]): ImportRoot => ({ level, nodeId: 4, name: "Billing", issueKey: "IMC-1", connectionId: 1, workStreamId: 3, owner });
  const FILTER = { excludeDone: true, updatedWithinDays: 365 };

  test("the form opens at the preset stream and owner", () => {
    expect(emptyScope(keys, 3, owner)).toMatchObject({ workStreamId: "3", owner });
    expect(emptyScope(keys)).toMatchObject({ workStreamId: null, owner: null });
  });

  test("carries root {level, nodeId} and nothing else of it, and never projectKeys or the default program", () => {
    const form = { ...emptyScope(keys, 3, owner), keys: ["IMC"], programId: "4", projectId: "9", team: { value: "5", label: "T" } };
    expect(toScope(form, keys, root("PROGRAM"))).toEqual({
      workStreamId: 3,
      ownerPersonId: 8,
      defaults: { projectId: 9, teamId: 5 },
      copyDates: true,
      filter: FILTER,
      root: { level: "PROGRAM", nodeId: 4 },
    });
  });

  test("a project root sends no default project either, and the owner is the preset one", () => {
    const form = { ...emptyScope(keys, 3, owner), projectId: "9" };
    expect(toScope(form, keys, root("PROJECT"))).toEqual({ workStreamId: 3, ownerPersonId: 8, copyDates: true, filter: FILTER, root: { level: "PROJECT", nodeId: 4 } });
  });

  test("the keys are not asked for: none ticked is still a scope under a root, and none without one is not", () => {
    const form = { ...emptyScope(keys, 3, owner), keys: [] };
    expect(toScope(form, keys, root("PROGRAM"))).not.toBeNull();
    expect(toScope(form, keys)).toBeNull();
  });

  test("a whole-scope scope never has a root member, and the apply body repeats the root the preview was read under", () => {
    expect(toScope(emptyScope(keys, 3, owner), keys)).not.toHaveProperty("root");
    const scope = toScope(emptyScope(keys, 3, owner), keys, root("PROGRAM"))!;
    expect(toApplyRequest(scope, PREVIEW_ITEMS, allSelectable(PREVIEW_ITEMS), new Map()).root).toEqual({ level: "PROGRAM", nodeId: 4 });
  });

  test("the days field is still checked", () => {
    expect(toScope({ ...emptyScope(keys, 3, owner), updatedWithinDays: 0 }, keys, root("PROGRAM"))).toBeNull();
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

  test("an owner override goes in overrides.ownerPersonId on a program or project CREATE, only where it differs from the dialog's owner", () => {
    const owners = new Map([["95001", 9], ["95002", 8], ["95004", 9], ["95009", 9]]);
    const body = toApplyRequest(SCOPE, PREVIEW_ITEMS, allSelectable(PREVIEW_ITEMS), new Map([["95004", 6]]), owners);
    const overrides = (id: string) => body.items.find((i) => i.jiraId === id)!.overrides;
    expect(overrides("95001")).toEqual({ ownerPersonId: 9 });
    expect(overrides("95002")).toBeUndefined(); // the dialog's own owner: nothing to send
    expect(overrides("95004")).toEqual({ teamId: 6 }); // a milestone has no owner: the pick is dropped, the team override stays
    expect(overrides("95009")).toBeUndefined(); // a BIND never changes the node's owner
  });

  test("only ticked rows are sent, in preview order", () => {
    const body = toApplyRequest(SCOPE, PREVIEW_ITEMS, new Set(["95010", "95001", "95008"]), new Map());
    expect(body.items.map((i) => i.jiraId)).toEqual(["95001", "95010"]);
  });
});

describe("suggested matches (1.15)", () => {
  const suggested = (id: string, nodeId: number): JiraImportItem => ({ ...PREVIEW_ITEMS[0], jiraId: id, suggestion: { nodeId, nodeName: `Node ${nodeId}` } });
  const items = [suggested("1", 10), suggested("2", 20), PREVIEW_ITEMS[1]];
  const scope = { workStreamId: 3, ownerPersonId: 8, copyDates: true };

  test("hasSuggestion is a CREATE with a suggestion; isConfirmedMatch a BIND flagged MATCH_CONFIRMED", () => {
    expect(hasSuggestion(items[0])).toBe(true);
    expect(hasSuggestion(items[2])).toBe(false);
    expect(hasSuggestion({ ...items[0], action: "SKIP" })).toBe(false);
    const bound: JiraImportItem = { ...PREVIEW_ITEMS[6], infos: ["MATCH_CONFIRMED"] };
    expect(isConfirmedMatch(bound)).toBe(true);
    expect(isConfirmedMatch(PREVIEW_ITEMS[6])).toBe(false);
    expect(isMatchRow(bound) && isMatchRow(items[0]) && !isMatchRow(items[2])).toBe(true);
  });

  test("nextMatches adds the suggestion of a pending link, drops an entry with a pending create and keeps the rest once each", () => {
    const withConfirmed = { ...scope, matches: [{ jiraId: "3", nodeId: 30 }, { jiraId: "4", nodeId: 40 }] };
    const pending = new Map<string, MatchChange>([["1", "link"], ["3", "create"]]);
    expect(nextMatches(withConfirmed, items, pending)).toEqual([{ jiraId: "4", nodeId: 40 }, { jiraId: "1", nodeId: 10 }]);
    // A stale entry for a row that is linked again is replaced, never doubled.
    const stale = { ...scope, matches: [{ jiraId: "1", nodeId: 99 }] };
    expect(nextMatches(stale, items, new Map([["1", "link"]]))).toEqual([{ jiraId: "1", nodeId: 10 }]);
    expect(nextMatches(scope, items, new Map())).toEqual([]);
  });

  test("withMatches sets the member, and leaves it out when the list is empty", () => {
    expect(withMatches(scope, [{ jiraId: "1", nodeId: 10 }])).toEqual({ ...scope, matches: [{ jiraId: "1", nodeId: 10 }] });
    expect(withMatches({ ...scope, matches: [{ jiraId: "1", nodeId: 10 }] }, [])).not.toHaveProperty("matches");
  });
});

describe("carrying the user's work across a match-driven preview (1.15)", () => {
  const before = PREVIEW_ITEMS;
  // The user had unticked the project 95002 (and so what is created under it: 95004, 95005) and the BIND 95009.
  const carry = { items: before, ticks: new Set(["95001", "95003", "95010"]), teams: new Map([["95005", 5], ["95010", 6]]), owners: new Map() };
  const converted = before.map((item) => (item.jiraId === "95010" ? { ...item, action: "BIND" as const } : item));

  test("an unticked row that keeps its action stays unticked, with what is created under it; a row whose action changed opens ticked again", () => {
    expect([...carriedTicks(converted, carry)].sort()).toEqual(["95001", "95003", "95010"]);
    // Unticked before, converted since: the action changed, so the row starts ticked again; had it kept its action, it would stay unticked.
    const unticked = { ...carry, ticks: new Set(["95001", "95003"]) };
    expect(carriedTicks(converted, unticked).has("95010")).toBe(true);
    expect(carriedTicks(before, unticked).has("95010")).toBe(false);
  });

  test("a row that is new in the next preview opens ticked", () => {
    const extra = { ...PREVIEW_ITEMS[2], jiraId: "99999", issueKey: "IMP-99" };
    expect(carriedTicks([...before, extra], carry).has("99999")).toBe(true);
  });

  test("picks are kept for rows present with the same action only", () => {
    expect([...carriedPicks(converted, carry, carry.teams)]).toEqual([["95005", 5]]);
    expect([...carriedPicks(before.filter((item) => item.jiraId !== "95005"), carry, carry.teams)]).toEqual([["95010", 6]]);
  });
});
