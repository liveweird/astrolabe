// Shared fixtures for the Dependencies page: a row, an end and a document. Rows and ends are the RESOLVED shapes the page works with
// (`utils/dependencyListRows.ts`); `dependencyListView` answers the WIRE document built from them (the three name lists and the refs).
import type { components } from "../api/schema";
import type { DependencyListEnd, DependencyListRow as Row } from "../utils/dependencyListRows";

type View = components["schemas"]["DependencyListView"];

/** A milestone end with its project and team; override any member. */
export function milestoneEnd(over: Partial<DependencyListEnd> = {}): DependencyListEnd {
  return {
    kind: "MILESTONE",
    id: 12,
    name: "Design review",
    projectId: 3,
    projectName: "Checkout",
    teamId: 4,
    teamName: "Backend",
    ...over,
  };
}

/** A whole-project end: its own id as `projectId`, no team; override any member. */
export function projectEnd(over: Partial<DependencyListEnd> = {}): DependencyListEnd {
  return {
    kind: "PROJECT",
    id: 5,
    name: "Payments",
    projectId: 5,
    projectName: "Payments",
    teamId: null,
    teamName: null,
    ...over,
  };
}

/** A dependency that holds (milestone to milestone, finish to start); override any member. */
export function dependencyRow(over: Partial<Row> = {}): Row {
  return {
    id: 77,
    predecessor: milestoneEnd(),
    successor: milestoneEnd({ id: 13, name: "Build", projectId: 6, projectName: "Billing", teamId: 7, teamName: "Frontend" }),
    type: "FS",
    lagDays: 0,
    check: { status: "OK", shortfallDays: null, slackDays: 2, requiredDate: "2027-06-14", actualDate: "2027-06-16" },
    ...over,
  };
}

/** A dependency that does not hold, `days` working days short. */
export function violatedRow(over: Partial<Row> = {}, days = 3): Row {
  return dependencyRow({
    check: { status: "VIOLATED", shortfallDays: days, slackDays: -days, requiredDate: "2027-06-14", actualDate: "2027-06-09" },
    ...over,
  });
}

/** A dependency with an end that has no dates. */
export function unscheduledRow(over: Partial<Row> = {}): Row {
  return dependencyRow({ check: { status: "UNSCHEDULED", shortfallDays: null, slackDays: null, requiredDate: null, actualDate: null }, ...over });
}

/** Each distinct id once (the first name wins), by ascending id, as the server lists them. */
function once<T extends { id: number }>(items: T[]): T[] {
  return [...new Map(items.slice().reverse().map((item) => [item.id, item])).values()].sort((a, b) => a.id - b.id);
}

/** The WIRE document over the (resolved) rows given: the three name lists hold exactly what the rows name; `totals` default to what the rows add up to (override to model a cut list). */
export function dependencyListView(dependencies: Row[], over: Partial<View> = {}): View {
  const ends = dependencies.flatMap((row) => [row.predecessor, row.successor]);
  const milestones = ends.filter((end) => end.kind === "MILESTONE");
  return {
    revision: 1,
    totals: {
      links: dependencies.length,
      violated: dependencies.filter((row) => row.check.status === "VIOLATED").length,
      unscheduled: dependencies.filter((row) => row.check.status === "UNSCHEDULED").length,
    },
    projects: once([
      ...ends.filter((end) => end.kind === "PROJECT").map((end) => ({ id: end.id, name: end.name })),
      ...milestones.map((end) => ({ id: end.projectId, name: end.projectName })),
    ]),
    teams: once(milestones.map((end) => ({ id: end.teamId ?? 0, name: end.teamName ?? "" }))),
    milestones: once(milestones.map((end) => ({ id: end.id, name: end.name, projectId: end.projectId, teamId: end.teamId ?? 0 }))),
    dependencies: dependencies.map((row) => ({
      ...row,
      predecessor: { kind: row.predecessor.kind, id: row.predecessor.id },
      successor: { kind: row.successor.kind, id: row.successor.id },
    })),
    truncated: false,
    ...over,
  };
}
