import { describe, expect, test } from "vitest";
import type { PlanFlag, RoadmapLink, RoadmapProject, RoadmapView } from "../api/roadmap";
import {
  activeFilterCount,
  allProjects,
  arrowSpecsForLinks,
  conflictsByProject,
  countFlags,
  datesOf,
  displayRows,
  driftBandOf,
  flagEntries,
  flagTotals,
  knownFilters,
  knownPick,
  ownerOptions,
  pickAmong,
  programOptions,
  visibleProjects,
  workStreamOptions,
  type RoadmapFilters,
} from "./roadmapRows";

const NONE: RoadmapFilters = { workStreamId: null, teamId: null, ownerPersonId: null, flaggedOnly: false };

const flag = (kind: PlanFlag["kind"], severity: PlanFlag["severity"], over: Partial<PlanFlag> = {}): PlanFlag => ({ kind, severity, days: 3, teamId: null, otherProjectId: null, deviation: null, count: null, ...over });

const project = (id: number, name: string, over: Partial<RoadmapProject> = {}): RoadmapProject => ({
  jira: null,
  id,
  name,
  programId: 10,
  programName: "Billing",
  workStreamId: 1,
  workStreamName: "Platform",
  ownerPersonId: 5,
  ownerName: "Ola Owner",
  targetStart: null,
  targetEnd: null,
  rankPosition: null,
  teamIds: [],
  span: null,
  drift: null,
  flags: [],
  can: { editTargetWindow: false },
  ...over,
});

const A = project(1, "Alpha", { teamIds: [7], flags: [flag("DRIFT_END_EARLY", "INFO"), flag("DRIFT_END_LATE", "WARNING")] });
const B = project(2, "Beta", { programId: 11, programName: "Compliance", workStreamId: 2, workStreamName: "Ops", ownerPersonId: 6, ownerName: "Tania Tax", teamIds: [7, 8] });
const C = project(3, "Gamma", { flags: [flag("RANK_INVERSION", "WARNING", { teamId: 7, otherProjectId: 1 })] });
const D = project(4, "Delta", { programId: 11, programName: "Compliance", workStreamId: 2, workStreamName: "Ops", ownerPersonId: 6, ownerName: "Tania Tax" });

const view = (over: Partial<RoadmapView> = {}): RoadmapView => ({
  jiraSites: [],
  revision: 1,
  can: { editRank: true },
  teams: [
    { id: 7, name: "Payments" },
    { id: 8, name: "Web" },
  ],
  links: [],
  ranked: [
    { position: 1, project: A },
    { position: 2, project: B },
    { position: 4, project: C },
  ],
  unranked: [D],
  ...over,
});

describe("visibleProjects", () => {
  test("no filter and no pick keeps every row and the server's positions (a gap stays a gap)", () => {
    const visible = visibleProjects(view(), NONE, null);
    expect(visible.ranked.map((e) => [e.position, e.project.id])).toEqual([[1, 1], [2, 2], [4, 3]]);
    expect(visible.unranked.map((p) => p.id)).toEqual([4]);
  });

  test.each([
    ["work stream", { ...NONE, workStreamId: 2 }, [2], [4]],
    ["team (a project with milestones on it)", { ...NONE, teamId: 7 }, [1, 2], []],
    ["owner", { ...NONE, ownerPersonId: 6 }, [2], [4]],
    ["flagged only", { ...NONE, flaggedOnly: true }, [1, 3], []],
    ["two filters AND together", { ...NONE, workStreamId: 1, flaggedOnly: true }, [1, 3], []],
  ])("the %s filter", (_name, filters, ranked, unranked) => {
    const visible = visibleProjects(view(), filters, null);
    expect(visible.ranked.map((e) => e.project.id)).toEqual(ranked);
    expect(visible.unranked.map((p) => p.id)).toEqual(unranked);
  });

  test("the program pick keeps only the picked programs, with the filters", () => {
    expect(visibleProjects(view(), NONE, new Set([11])).ranked.map((e) => e.project.id)).toEqual([2]);
    expect(visibleProjects(view(), { ...NONE, teamId: 8 }, new Set([10])).ranked).toEqual([]);
  });
});

describe("options and stored values", () => {
  test("the options are the distinct work streams, owners and programs of the view, by name", () => {
    expect(workStreamOptions(view())).toEqual([{ id: 2, name: "Ops" }, { id: 1, name: "Platform" }]);
    expect(ownerOptions(view())).toEqual([{ id: 5, name: "Ola Owner" }, { id: 6, name: "Tania Tax" }]);
    expect(programOptions(view()).map((p) => [p.id, p.name, p.workStreamName])).toEqual([[10, "Billing", "Platform"], [11, "Compliance", "Ops"]]);
    expect(allProjects(view()).map((p) => p.id)).toEqual([1, 2, 3, 4]);
  });

  test("a stored filter id the view no longer offers filters nothing", () => {
    expect(knownFilters(view(), { workStreamId: 99, teamId: 8, ownerPersonId: 98, flaggedOnly: true })).toEqual({ workStreamId: null, teamId: 8, ownerPersonId: null, flaggedOnly: true });
  });

  test("a stored pick keeps the programs that exist; none left = no pick", () => {
    expect([...(knownPick(view(), [11, 99]) ?? [])]).toEqual([11]);
    expect(knownPick(view(), [99])).toBeNull();
    expect(knownPick(view(), [])).toBeNull();
  });

  test("pickAmong is the same rule over any list of programs - the programs page passes the ones ITS view holds, empty programs included", () => {
    const programs = [{ id: 10 }, { id: 12 }];
    expect([...(pickAmong(programs, [12, 11]) ?? [])]).toEqual([12]);
    expect(pickAmong(programs, [11])).toBeNull();
  });

  test("the filter badge counts each field in force plus the pick", () => {
    expect(activeFilterCount(NONE, null)).toBe(0);
    expect(activeFilterCount({ workStreamId: 1, teamId: 7, ownerPersonId: null, flaggedOnly: true }, new Set([10]))).toBe(4);
  });
});

describe("displayRows", () => {
  test("ranked rows, the divider while something is unranked, unranked rows", () => {
    const rows = displayRows(visibleProjects(view(), NONE, null));
    expect(rows.map((r) => (r.kind === "divider" ? "—" : `${r.position ?? "u"}:${r.project.id}`))).toEqual(["1:1", "2:2", "4:3", "—", "u:4"]);
  });

  test("no divider without an unranked row; the divider leads when nothing is ranked", () => {
    expect(displayRows(visibleProjects(view({ unranked: [] }), NONE, null)).some((r) => r.kind === "divider")).toBe(false);
    expect(displayRows(visibleProjects(view({ ranked: [] }), NONE, null)).map((r) => r.kind)).toEqual(["divider", "project"]);
  });
});

describe("flags", () => {
  test("counts split warnings from infos, and the totals cover the visible rows only", () => {
    expect(countFlags(A.flags)).toEqual({ warnings: 1, infos: 1 });
    expect(flagTotals(visibleProjects(view(), NONE, null))).toEqual({ warnings: 2, infos: 1 });
    expect(flagTotals(visibleProjects(view(), { ...NONE, ownerPersonId: 6 }, null))).toEqual({ warnings: 0, infos: 0 });
  });

  test("the panel lists warnings first, then by rank position, a project's own flags in the server's order", () => {
    const entries = flagEntries(visibleProjects(view(), NONE, null));
    expect(entries.map((e) => [e.project.id, e.flag.kind])).toEqual([
      [1, "DRIFT_END_LATE"],
      [3, "RANK_INVERSION"],
      [1, "DRIFT_END_EARLY"],
    ]);
    expect(entries[1].position).toBe(4);
  });
});

describe("driftBandOf / datesOf", () => {
  test("the band runs from the day after the window to the span's end, only for a late project", () => {
    const late = project(9, "Late", { targetStart: "2027-01-04", targetEnd: "2027-01-29", span: { start: "2027-01-04", end: "2027-02-12" }, drift: { startDays: 0, endDays: 14 } });
    expect(driftBandOf(late)).toEqual({ start: "2027-01-30", end: "2027-02-12" });
    expect(driftBandOf({ ...late, drift: { startDays: 0, endDays: 0 } })).toBeNull();
    expect(driftBandOf({ ...late, drift: { startDays: 0, endDays: -3 } })).toBeNull();
    expect(driftBandOf({ ...late, drift: null })).toBeNull();
    expect(driftBandOf({ ...late, targetEnd: null })).toBeNull();
  });

  test("the dates are every span end and window end of the whole plan", () => {
    const dated = view({ ranked: [{ position: 1, project: project(9, "X", { targetStart: "2027-01-04", targetEnd: "2027-01-29", span: { start: "2027-01-11", end: "2027-02-12" } }) }], unranked: [] });
    expect(datesOf(dated).sort()).toEqual(["2027-01-04", "2027-01-11", "2027-01-29", "2027-02-12"]);
    expect(datesOf(view())).toEqual([]);
  });
});

const link = (pred: number, succ: number, over: Partial<RoadmapLink> = {}): RoadmapLink => ({
  predecessorProjectId: pred,
  successorProjectId: succ,
  direct: null,
  milestoneLinks: { count: 0, violated: 0, unscheduled: 0 },
  ...over,
});
const direct = (id: number, type: "FS" | "SS" | "FF" | "SF", status: "OK" | "VIOLATED" | "UNSCHEDULED") => ({
  id,
  type,
  lagDays: 0,
  check: { status, shortfallDays: status === "VIOLATED" ? 2 : null, requiredDate: null, actualDate: null },
});
const LABELS = { direct: () => "direct", bundle: (l: RoadmapLink) => `bundle ${l.milestoneLinks.count}` };
const ALL = (id: number) => id;

describe("arrowSpecsForLinks", () => {
  test("a direct link joins the span bars at the edges of its type, red when violated", () => {
    const specs = arrowSpecsForLinks([link(1, 2, { direct: direct(31, "SF", "VIOLATED") }), link(2, 3, { direct: direct(32, "FS", "OK") })], ALL, LABELS);
    expect(specs).toEqual([
      { id: 31, from: { row: 1, bar: 1, kind: "START" }, to: { row: 2, bar: 2, kind: "END" }, violated: true, label: "direct" },
      { id: 32, from: { row: 2, bar: 2, kind: "END" }, to: { row: 3, bar: 3, kind: "START" }, violated: false, label: "direct" },
    ]);
  });

  test("an UNSCHEDULED direct link has nothing to point at", () => {
    expect(arrowSpecsForLinks([link(1, 2, { direct: direct(31, "FS", "UNSCHEDULED") })], ALL, LABELS)).toEqual([]);
  });

  test("the milestone links of an ordered pair are ONE bundle arrow, end to start, red when any is violated", () => {
    const specs = arrowSpecsForLinks([link(1, 2, { milestoneLinks: { count: 3, violated: 1, unscheduled: 0 } }), link(2, 1, { milestoneLinks: { count: 2, violated: 0, unscheduled: 1 } })], ALL, LABELS);
    expect(specs.map((s) => [s.id, s.from.kind, s.to.kind, s.violated, s.label])).toEqual([
      ["bundle:1-2", "END", "START", true, "bundle 3"],
      ["bundle:2-1", "END", "START", false, "bundle 2"],
    ]);
  });

  test("a pair with both a direct link and milestone links draws both; a project without a row draws neither", () => {
    const both = link(1, 2, { direct: direct(31, "FS", "OK"), milestoneLinks: { count: 1, violated: 0, unscheduled: 0 } });
    expect(arrowSpecsForLinks([both], ALL, LABELS).map((s) => s.id)).toEqual([31, "bundle:1-2"]);
    expect(arrowSpecsForLinks([both], (id) => (id === 1 ? 1 : null), LABELS)).toEqual([]);
  });
});

describe("conflictsByProject", () => {
  test("counts the violated direct link and the violated milestone links on both projects of a pair", () => {
    const counts = conflictsByProject([
      link(1, 2, { direct: direct(31, "FS", "VIOLATED"), milestoneLinks: { count: 3, violated: 2, unscheduled: 0 } }),
      link(2, 3, { direct: direct(32, "FS", "OK") }),
    ]);
    expect([...counts]).toEqual([[1, 3], [2, 3]]);
  });
});
