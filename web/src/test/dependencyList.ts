// Shared fixtures for the Dependencies page: a row, an end and a document as GET /views/dependencies answers them.
import type { components } from "../api/schema";

type Row = components["schemas"]["DependencyListRow"];
type End = components["schemas"]["DependencyEndpoint"];
type View = components["schemas"]["DependencyListView"];

/** A milestone end with its project, team and dates; override any member. */
export function milestoneEnd(over: Partial<End> = {}): End {
  return {
    kind: "MILESTONE",
    id: 12,
    name: "Design review",
    projectId: 3,
    projectName: "Checkout",
    teamId: 4,
    teamName: "Backend",
    startDate: "2027-06-07",
    endDate: "2027-06-11",
    ...over,
  };
}

/** A whole-project end: its own id as `projectId`, no team, the derived span; override any member. */
export function projectEnd(over: Partial<End> = {}): End {
  return {
    kind: "PROJECT",
    id: 5,
    name: "Payments",
    projectId: 5,
    projectName: "Payments",
    teamId: null,
    teamName: null,
    startDate: null,
    endDate: null,
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

/** A document over the rows given; `totals` default to what the rows add up to (override to model a cut list). */
export function dependencyListView(dependencies: Row[], over: Partial<View> = {}): View {
  return {
    revision: 1,
    totals: {
      links: dependencies.length,
      violated: dependencies.filter((row) => row.check.status === "VIOLATED").length,
      unscheduled: dependencies.filter((row) => row.check.status === "UNSCHEDULED").length,
    },
    dependencies,
    truncated: false,
    ...over,
  };
}
