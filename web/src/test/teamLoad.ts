// Shared fixtures for the Teams page: a row and a document as GET /views/team-load answers them.
import type { components } from "../api/schema";

type Row = components["schemas"]["TeamLoadRow"];
type View = components["schemas"]["TeamLoadView"];

/** One team's row with no warning at all; override any member. */
export function teamLoadRow(over: Partial<Row> = {}): Row {
  return {
    id: 3,
    name: "Backend",
    description: null,
    managerPersonId: 9,
    managerName: "Alex Rivera",
    milestones: 12,
    unscheduledMilestones: 0,
    overloadedWeeks: 0,
    wipExceededWeeks: 0,
    weeksWithoutCapacity: 0,
    warningWeeks: [],
    ...over,
  };
}

/** A document over the rows given; `totals` default to what the rows add up to (override to model a cut list). */
export function teamLoadView(teams: Row[], over: Partial<View> = {}): View {
  return {
    revision: 1,
    currentWeekStart: "2027-01-04",
    totals: {
      teams: teams.length,
      overloadedTeams: teams.filter((row) => row.overloadedWeeks > 0).length,
      wipExceededTeams: teams.filter((row) => row.wipExceededWeeks > 0).length,
      unscheduledMilestones: teams.reduce((sum, row) => sum + row.unscheduledMilestones, 0),
    },
    teams,
    truncated: false,
    warningWeeksTruncated: false,
    ...over,
  };
}
