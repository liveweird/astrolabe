import { describe, expect, test } from "vitest";
import type { DependencyEndpoint, ProjectDependency } from "../api/dependencies";
import type { ProjectView, UpstreamEntity } from "../api/milestones";
import {
  arrowSpecs,
  chainEntries,
  conflictCount,
  conflictsByBar,
  ghostEndpoints,
  ghostRowId,
  linksOfMilestone,
  projectRowId,
  summaryCritical,
  summaryRowNeeded,
  upstreamIndex,
  upstreamOf,
} from "./projectDependencies";

const PROJECT_ID = 7;

const endpoint = (over: Partial<DependencyEndpoint> = {}): DependencyEndpoint => ({
  kind: "MILESTONE",
  id: 1,
  name: "Design",
  projectId: PROJECT_ID,
  projectName: "Invoices",
  teamId: 3,
  teamName: "Backend",
  startDate: "2027-02-01",
  endDate: "2027-02-05",
  ...over,
});

const ownProject = endpoint({ kind: "PROJECT", id: PROJECT_ID, name: "Invoices", teamId: null, teamName: null });
const foreign = (id: number, over: Partial<DependencyEndpoint> = {}) => endpoint({ id, name: `Other ${id}`, projectId: 99, projectName: "Elsewhere", ...over });

const link = (id: number, predecessor: DependencyEndpoint, successor: DependencyEndpoint, over: Partial<ProjectDependency> = {}): ProjectDependency => ({
  id,
  predecessor,
  successor,
  type: "FS",
  lagDays: 0,
  check: { status: "OK", shortfallDays: null, slackDays: 0, requiredDate: "2027-02-08", actualDate: "2027-02-08" },
  critical: false,
  can: { edit: true, delete: true },
  ...over,
});

const violated = { status: "VIOLATED", shortfallDays: 3, slackDays: -3, requiredDate: "2027-02-08", actualDate: "2027-02-03" } as const;

const viewWith = (dependencies: ProjectDependency[], upstream: UpstreamEntity[] = []) =>
  ({ project: { id: PROJECT_ID }, dependencies, criticalPath: { upstream, upstreamTruncated: false } }) as ProjectView;

const entry = (kind: UpstreamEntity["kind"], id: number, over: Partial<UpstreamEntity> = {}): UpstreamEntity => ({
  kind,
  id,
  name: `Entity ${id}`,
  projectId: 99,
  projectName: "Elsewhere",
  startDate: "2027-01-04",
  endDate: "2027-01-08",
  slackDays: 0,
  critical: true,
  hops: 1,
  ...over,
});

describe("ghostEndpoints", () => {
  test("keeps the distinct external ends that have dates, sorted by start, end, name", () => {
    const late = foreign(2, { startDate: "2027-03-01", endDate: "2027-03-05" });
    const early = foreign(3, { name: "alpha", startDate: "2027-01-04", endDate: "2027-01-08" });
    const sameDayLongerFirst = foreign(5, { startDate: "2027-01-04", endDate: "2027-01-06", name: "zulu" });
    const unscheduled = foreign(4, { startDate: null, endDate: null });
    const otherProject = endpoint({ kind: "PROJECT", id: 55, name: "Other project", projectId: 55, projectName: "Other project", teamId: null, teamName: null });
    const view = viewWith([
      link(1, late, endpoint({ id: 10 })),
      link(2, early, endpoint({ id: 10 })),
      link(3, late, endpoint({ id: 11 })),
      link(4, unscheduled, endpoint({ id: 11 })),
      link(5, endpoint({ id: 11 }), otherProject),
      link(6, sameDayLongerFirst, endpoint({ id: 11 })),
    ]);
    // Jan 4-6, Jan 4-8, the other project's Feb span, then March; the unscheduled end and the repeats are gone.
    expect(ghostEndpoints(view).map((e) => ghostRowId(e))).toEqual(["ghost:m:5", "ghost:m:3", "ghost:p:55", "ghost:m:2"]);
  });

  test("an own milestone or the own project is never a ghost", () => {
    expect(ghostEndpoints(viewWith([link(1, endpoint({ id: 1 }), ownProject)]))).toEqual([]);
  });
});

describe("summaryRowNeeded", () => {
  test("only while the project itself is an end of some link", () => {
    expect(summaryRowNeeded(viewWith([]))).toBe(false);
    expect(summaryRowNeeded(viewWith([link(1, foreign(2), endpoint({ id: 1 }))]))).toBe(false);
    expect(summaryRowNeeded(viewWith([link(1, foreign(2), ownProject)]))).toBe(true);
    expect(summaryRowNeeded(viewWith([link(1, ownProject, foreign(2))]))).toBe(true);
    // another project's span is a ghost, not this project's summary
    expect(summaryRowNeeded(viewWith([link(1, endpoint({ kind: "PROJECT", id: 55, projectId: 55 }), endpoint({ id: 1 }))]))).toBe(false);
  });
});

describe("conflicts", () => {
  const view = viewWith([
    link(1, foreign(2), endpoint({ id: 1 }), { check: violated }),
    link(2, endpoint({ id: 1 }), endpoint({ id: 4 }), { check: violated }),
    link(3, foreign(2), ownProject, { check: violated }),
    link(4, foreign(3), endpoint({ id: 4 })),
    link(5, foreign(3), endpoint({ id: 9 }), { check: { status: "UNSCHEDULED", shortfallDays: null, slackDays: null, requiredDate: null, actualDate: null } }),
  ]);

  test("conflictCount counts the violated links only", () => {
    expect(conflictCount(view)).toBe(3);
    expect(conflictCount(viewWith([]))).toBe(0);
  });

  test("conflictsByBar counts a violated link on each of its own ends; ghosts have none", () => {
    expect(conflictsByBar(view)).toEqual(
      new Map<string | number, number>([
        [1, 2],
        [4, 1],
        [projectRowId(PROJECT_ID), 1],
      ]),
    );
  });

  test("linksOfMilestone counts every link on either end of a milestone", () => {
    expect(linksOfMilestone(view, 1)).toBe(2);
    expect(linksOfMilestone(view, 4)).toBe(2);
    expect(linksOfMilestone(view, 123)).toBe(0);
  });
});

describe("arrowSpecs", () => {
  test("joins the edges of each type: FS end→start, SS start→start, FF end→end, SF start→end", () => {
    const edges = (type: ProjectDependency["type"]) => {
      const [arrow] = arrowSpecs(viewWith([link(1, foreign(2), endpoint({ id: 1 }), { type })]));
      return [arrow.from.kind, arrow.to.kind];
    };
    expect(edges("FS")).toEqual(["END", "START"]);
    expect(edges("SS")).toEqual(["START", "START"]);
    expect(edges("FF")).toEqual(["END", "END"]);
    expect(edges("SF")).toEqual(["START", "END"]);
  });

  test("addresses rows: an own milestone by its id, a ghost and the summary by their synthetic ids; violated and label follow the link", () => {
    const [toMilestone, toProject] = arrowSpecs(
      viewWith([link(1, foreign(2), endpoint({ id: 1 }), { check: violated }), link(2, endpoint({ id: 1, name: "Design" }), ownProject, { type: "FF" })]),
    );
    expect(toMilestone).toEqual({
      id: 1,
      from: { row: "ghost:m:2", bar: "ghost:m:2", kind: "END" },
      to: { row: 1, bar: 1, kind: "START" },
      violated: true,
      label: "Other 2 → Design, FS",
    });
    expect(toProject.to).toEqual({ row: "project:7", bar: "project:7", kind: "END" });
    expect(toProject.violated).toBe(false);
  });

  test("an UNSCHEDULED link has no arrow", () => {
    const view = viewWith([link(1, foreign(2), endpoint({ id: 1 }), { check: { status: "UNSCHEDULED", shortfallDays: null, slackDays: null, requiredDate: null, actualDate: null } })]);
    expect(arrowSpecs(view)).toEqual([]);
  });
});

describe("the critical path", () => {
  test("arrowSpecs flags the critical links only when asked; a link the server did not mark is never flagged", () => {
    const view = viewWith([link(1, foreign(2), endpoint({ id: 1 }), { critical: true }), link(2, endpoint({ id: 1 }), endpoint({ id: 4 }))]);
    expect(arrowSpecs(view).map((spec) => spec.critical)).toEqual([undefined, undefined]);
    expect(arrowSpecs(view, true).map((spec) => spec.critical)).toEqual([true, undefined]);
  });

  test("upstreamOf finds an entity by kind AND id (a milestone and a project may share an id) and answers undefined for the unconnected", () => {
    const index = upstreamIndex(viewWith([], [entry("MILESTONE", 5, { slackDays: 3, critical: false }), entry("PROJECT", 5)]));
    expect(upstreamOf(index, foreign(5))?.slackDays).toBe(3);
    expect(upstreamOf(index, endpoint({ kind: "PROJECT", id: 5, projectId: 5 }))?.critical).toBe(true);
    expect(upstreamOf(index, foreign(6))).toBeUndefined();
  });

  test("summaryCritical: a critical link ending on the project itself, and nothing else", () => {
    expect(summaryCritical(viewWith([link(1, foreign(2), ownProject, { critical: true })]))).toBe(true);
    expect(summaryCritical(viewWith([link(1, foreign(2), ownProject)]))).toBe(false);
    expect(summaryCritical(viewWith([link(1, foreign(2), endpoint({ id: 1 }), { critical: true })]))).toBe(false);
  });

  test("chainEntries drops the ghost-row ends by kind + id, never by hops, and keeps the server's order in two groups", () => {
    // Foreign milestone 2 is a ghost row; its project's other milestone (hops 1 as well: containment is free) is NOT a ghost row and stays listed.
    const view = viewWith(
      [link(1, foreign(2), endpoint({ id: 1 }), { critical: true })],
      [
        entry("MILESTONE", 2),
        entry("MILESTONE", 3, { hops: 1 }),
        entry("MILESTONE", 8, { hops: 2 }),
        entry("MILESTONE", 9, { slackDays: 2, critical: false }),
        entry("MILESTONE", 10, { slackDays: 5, critical: false, hops: 1 }),
      ],
    );
    const { onChain, withSlack } = chainEntries(view);
    expect(onChain.map((e) => e.id)).toEqual([3, 8]);
    expect(withSlack.map((e) => e.id)).toEqual([9, 10]);
  });

  test("a ghost PROJECT end hides the project entry only, not a milestone with the same id", () => {
    const otherProject = endpoint({ kind: "PROJECT", id: 55, name: "P55", projectId: 55, projectName: "P55", teamId: null, teamName: null });
    const view = viewWith([link(1, otherProject, endpoint({ id: 1 }))], [entry("PROJECT", 55), entry("MILESTONE", 55)]);
    expect(chainEntries(view).onChain.map((e) => e.kind)).toEqual(["MILESTONE"]);
  });
});
