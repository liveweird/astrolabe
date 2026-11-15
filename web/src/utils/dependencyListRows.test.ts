import { describe, expect, test } from "vitest";
import { dependencyListView, dependencyRow, milestoneEnd, projectEnd, unscheduledRow, violatedRow } from "../test/dependencyList";
import { resolveDependencyList } from "./dependencyListRows";

const toProject = projectEnd({ id: 8, name: "Search", projectId: 8, projectName: "Search" });
const ROWS = [
  violatedRow({ id: 1 }),
  dependencyRow({ id: 2, lagDays: -1 }),
  unscheduledRow({
    id: 3,
    predecessor: milestoneEnd({ id: 20, name: "Scoping", projectId: 8, projectName: "Search", teamId: 9, teamName: "Data" }),
    successor: toProject,
    type: "SS",
  }),
];

describe("resolveDependencyList", () => {
  test("joins the names back: the rows round-trip through the wire document", () => {
    const resolved = resolveDependencyList(dependencyListView(ROWS));
    expect(resolved.dependencies).toEqual(ROWS);
  });

  test("a milestone end takes its name, project and team from the lists, a project end is its own project with no team", () => {
    const [, , open] = resolveDependencyList(dependencyListView(ROWS)).dependencies;
    expect(open.predecessor).toEqual({ kind: "MILESTONE", id: 20, name: "Scoping", projectId: 8, projectName: "Search", teamId: 9, teamName: "Data" });
    expect(open.successor).toEqual({ kind: "PROJECT", id: 8, name: "Search", projectId: 8, projectName: "Search", teamId: null, teamName: null });
  });

  test("the revision, the totals and the cut flag pass through as the server sent them", () => {
    const wire = dependencyListView(ROWS, { revision: 41, totals: { links: 1400, violated: 40, unscheduled: 5 }, truncated: true });
    const resolved = resolveDependencyList(wire);
    expect(resolved.revision).toBe(41);
    expect(resolved.totals).toEqual({ links: 1400, violated: 40, unscheduled: 5 });
    expect(resolved.truncated).toBe(true);
    expect(Object.keys(resolved).sort()).toEqual(["dependencies", "revision", "totals", "truncated"]);
  });

  test("an empty document resolves to no rows", () => {
    expect(resolveDependencyList(dependencyListView([])).dependencies).toEqual([]);
  });

  test("a milestone, a project or a team the lists do not hold throws", () => {
    const wire = dependencyListView(ROWS);
    expect(() => resolveDependencyList({ ...wire, milestones: [] })).toThrow(/milestone/);
    expect(() => resolveDependencyList({ ...wire, projects: [] })).toThrow(/project/);
    expect(() => resolveDependencyList({ ...wire, teams: [] })).toThrow(/team/);
    expect(() => resolveDependencyList({ ...wire, projects: wire.projects.filter((p) => p.id !== 8) })).toThrow(/project \(8\)/);
  });
});
