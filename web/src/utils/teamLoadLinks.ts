import { teamLoadFilterParams, type TeamLoadWarning } from "./teamLoadFilters";

/** The ONE place the Team load route is spelled out: every team against its capacity, in the Planning section after Milestones. */
export const teamLoadPath = "/team-load";

/** `/team-load?warning=overloaded|wip|any`: the teams with that warning (Home's two capacity badges). Spelled through `teamLoadFilterParams`, so the page reads back what a link wrote. */
export function teamLoadWarningPath(warning: TeamLoadWarning): string {
  return `${teamLoadPath}?${teamLoadFilterParams({ warning })}`;
}
