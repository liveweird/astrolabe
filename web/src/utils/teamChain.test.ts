import { describe, expect, test } from "vitest";
import type { ProjectDependency } from "../api/dependencies";
import type { TeamChainLink, TeamChainMember, TeamCriticalChain } from "../api/teams";
import { ghostRowId } from "./dependencyArrows";
import { chainArrowSpecs, chainDays, chainProjectNames, criticalArrowRows, orderedMembers } from "./teamChain";

// The team page's critical chain, pure (`.claude/docs/timeline.md` "The critical-path highlight"): the server's block adapted to rows, arrows and the text table.

const member = (kind: "MILESTONE" | "PROJECT", id: number, over: Partial<TeamChainMember> = {}): TeamChainMember => ({
  kind,
  id,
  name: `m${id}`,
  projectId: kind === "PROJECT" ? id : 70,
  projectName: kind === "PROJECT" ? `m${id}` : "Alpha",
  teamId: kind === "PROJECT" ? null : 9,
  teamName: kind === "PROJECT" ? null : "Platform",
  startDate: "2027-02-01",
  endDate: "2027-02-05",
  hops: 1,
  chainOf: [7],
  ...over,
});

const chainLink = (id: number, from: TeamChainMember, to: TeamChainMember, over: Partial<TeamChainLink> = {}): TeamChainLink => ({
  id,
  predecessor: { kind: from.kind, id: from.id },
  successor: { kind: to.kind, id: to.id },
  type: "FS",
  lagDays: 0,
  ...over,
});

const chainOf = (members: TeamChainMember[], links: TeamChainLink[] = [], truncated = false): TeamCriticalChain => ({ members, links, truncated });

describe("orderedMembers", () => {
  test("sorts by start, end, name (case-insensitive), kind, id - not by the server's nearest-first order - and leaves the block alone", () => {
    const late = member("MILESTONE", 1, { startDate: "2027-03-01", endDate: "2027-03-05", hops: 1 });
    const early = member("MILESTONE", 2, { startDate: "2027-02-01", endDate: "2027-02-12", hops: 3 });
    const earlyEnds = member("MILESTONE", 3, { startDate: "2027-02-01", endDate: "2027-02-05", hops: 2 });
    const upper = member("MILESTONE", 4, { name: "Beta", startDate: "2027-02-01", endDate: "2027-02-05" });
    const lower = member("MILESTONE", 5, { name: "alpha", startDate: "2027-02-01", endDate: "2027-02-05" });
    const project = member("PROJECT", 6, { name: "alpha", startDate: "2027-02-01", endDate: "2027-02-05" });
    const sameKind = member("MILESTONE", 7, { name: "alpha", startDate: "2027-02-01", endDate: "2027-02-05" });
    const chain = chainOf([late, early, earlyEnds, upper, lower, project, sameKind]);
    expect(orderedMembers(chain).map((m) => `${m.kind[0]}${m.id}`)).toEqual(["M5", "M7", "P6", "M4", "M3", "M2", "M1"]);
    // a copy: the server's order is intact (the cap depends on it)
    expect(chain.members.map((m) => m.id)).toEqual([1, 2, 3, 4, 5, 6, 7]);
  });
});

describe("rows and range", () => {
  test("a milestone and a project of one id are two rows", () => {
    expect(ghostRowId(member("MILESTONE", 5))).toBe("ghost:m:5");
    expect(ghostRowId(member("PROJECT", 5))).toBe("ghost:p:5");
  });

  test("the range gets every member's two days, and nothing without the block", () => {
    expect(chainDays(chainOf([member("MILESTONE", 1, { startDate: "2027-01-04", endDate: "2027-01-08" }), member("PROJECT", 2, { startDate: "2027-05-03", endDate: "2027-05-07" })]))).toEqual([
      "2027-01-04",
      "2027-01-08",
      "2027-05-03",
      "2027-05-07",
    ]);
    expect(chainDays(undefined)).toEqual([]);
  });

  test("the team's projects are named by id from its scheduled AND tray milestones", () => {
    const names = chainProjectNames({
      scheduled: [{ projectId: 7, projectName: "Invoices" }],
      unscheduled: [{ projectId: 8, projectName: "Payouts" }],
    } as never);
    expect([...names]).toEqual([
      [7, "Invoices"],
      [8, "Payouts"],
    ]);
  });
});

describe("chainArrowSpecs", () => {
  const a = member("MILESTONE", 1);
  const b = member("MILESTONE", 2);
  const p = member("PROJECT", 3);
  const rowOf = (end: { kind: string; id: number }) => ghostRowId(end);

  test("one critical, never violated arrow per link, the dependency type's edges, between the members' ghost rows, labelled with their names", () => {
    const specs = chainArrowSpecs(chainOf([a, b, p], [chainLink(11, a, b), chainLink(12, b, p, { type: "SS" }), chainLink(13, a, p, { type: "FF" }), chainLink(14, p, a, { type: "SF" })]), rowOf);
    expect(specs).toEqual([
      { id: 11, from: { row: "ghost:m:1", bar: "ghost:m:1", kind: "END" }, to: { row: "ghost:m:2", bar: "ghost:m:2", kind: "START" }, violated: false, critical: true, label: "m1 → m2, FS" },
      { id: 12, from: { row: "ghost:m:2", bar: "ghost:m:2", kind: "START" }, to: { row: "ghost:p:3", bar: "ghost:p:3", kind: "START" }, violated: false, critical: true, label: "m2 → m3, SS" },
      { id: 13, from: { row: "ghost:m:1", bar: "ghost:m:1", kind: "END" }, to: { row: "ghost:p:3", bar: "ghost:p:3", kind: "END" }, violated: false, critical: true, label: "m1 → m3, FF" },
      { id: 14, from: { row: "ghost:p:3", bar: "ghost:p:3", kind: "START" }, to: { row: "ghost:m:1", bar: "ghost:m:1", kind: "END" }, violated: false, critical: true, label: "m3 → m1, SF" },
    ]);
  });

  test("a link with an end that has no row is left out", () => {
    const only = (end: { kind: string; id: number }) => (end.id === 1 ? "ghost:m:1" : null);
    expect(chainArrowSpecs(chainOf([a, b], [chainLink(11, a, b)]), only)).toEqual([]);
  });
});

describe("criticalArrowRows", () => {
  const near = member("MILESTONE", 1, { name: "near", startDate: "2027-02-08", endDate: "2027-02-12" });
  const far = member("MILESTONE", 2, { name: "far", startDate: "2027-02-01", endDate: "2027-02-05" });
  const end = (id: number, name: string, start: string) => ({ kind: "MILESTONE" as const, id, name, projectId: 7, projectName: "Invoices", teamId: 1, teamName: "Payments", startDate: start, endDate: start });
  const own = (id: number, critical: boolean, from: ReturnType<typeof end>, to: ReturnType<typeof end>): ProjectDependency =>
    ({ id, predecessor: from, successor: to, type: "FS", lagDays: 2, critical, check: { status: "OK" }, can: { edit: false, delete: false } }) as unknown as ProjectDependency;

  test("the team's own critical links and the block's links, in chain order (the predecessor's start, then the successor's, then id); a link that is not critical is not listed", () => {
    const mine = end(5, "mine", "2027-02-15");
    const rows = criticalArrowRows(
      { dependencies: [own(31, true, end(1, "near", "2027-02-08"), mine), own(32, false, end(6, "side", "2027-02-01"), mine)] },
      chainOf([near, far], [chainLink(21, far, near, { lagDays: -1 })]),
    );
    expect(rows.map((row) => [row.id, row.predecessor.name, row.successor.name, row.lagDays])).toEqual([
      [21, "far", "near", -1],
      [31, "near", "mine", 2],
    ]);
    expect(rows[0].predecessor).toEqual({ kind: "MILESTONE", id: 2, name: "far", projectId: 70, projectName: "Alpha", teamId: 9, teamName: "Platform" });
    expect(rows[1].successor).toEqual({ kind: "MILESTONE", id: 5, name: "mine", projectId: 7, projectName: "Invoices", teamId: 1, teamName: "Payments" });
  });

  test("without the block the own critical links are still listed; a block link naming a non-member is skipped", () => {
    const mine = end(5, "mine", "2027-02-15");
    expect(criticalArrowRows({ dependencies: [own(31, true, end(1, "near", "2027-02-08"), mine)] }, undefined).map((row) => row.id)).toEqual([31]);
    expect(criticalArrowRows({ dependencies: [] }, chainOf([near], [chainLink(21, far, near)]))).toEqual([]);
  });
});
