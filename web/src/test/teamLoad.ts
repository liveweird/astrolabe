// Shared fixtures for the Team load page: a row and a document as GET /views/team-load answers them.
import type { components } from "../api/schema";

type Row = components["schemas"]["TeamLoadRow"];
type View = components["schemas"]["TeamLoadView"];

/** One team's row with no warning at all; override any member. */
export function teamLoadRow(over: Partial<Row> = {}): Row {
  return {
    id: 3,
    name: "Backend",
    managerName: "Alex Rivera",
    milestones: 12,
    unscheduledMilestones: 0,
    overloadedWeeks: 0,
    wipExceededWeeks: 0,
    weeksWithoutCapacity: 0,
    ...over,
  };
}

/** A document over the rows given; `totals` default to what the rows add up to (override to model a cut list). */
export function teamLoadView(teams: Row[], over: Partial<View> = {}): View {
  return {
    revision: 1,
    totals: {
      teams: teams.length,
      overloadedTeams: teams.filter((row) => row.overloadedWeeks > 0).length,
      wipExceededTeams: teams.filter((row) => row.wipExceededWeeks > 0).length,
    },
    teams,
    truncated: false,
    ...over,
  };
}
