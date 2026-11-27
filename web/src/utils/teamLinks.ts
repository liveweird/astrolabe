import { teamLoadFilterParams, type TeamLoadWarning } from "./teamLoadFilters";
import { WEEKLY_LOAD_PARAM, type WeeklyLoadKind } from "./weeklyLoadAddress";

/** The ONE place the teams route family is spelled out — never hand-assemble a team URL. */
export const teamsPath = "/teams";
export const teamPath = (id: number) => `${teamsPath}/${id}`;

/** `/teams?warning=overloaded|wip|any`: the teams with that warning (Home's two capacity badges). Spelled through `teamLoadFilterParams`, so the page reads back what was written. */
export const teamsWarningPath = (warning: TeamLoadWarning) => `${teamsPath}?${teamLoadFilterParams({ warning })}`;

/**
 * A team's page with its weekly load table opened, focused and scrolled to the first week of `kind` (1.36; `useWeeklyLoadArrival`): where the Teams table's
 * overloaded, over-WIP and without-capacity badges lead, each with its own kind, to the weeks behind the figure.
 */
export const teamWeeklyLoadPath = (id: number, kind: WeeklyLoadKind) => `${teamPath(id)}?${WEEKLY_LOAD_PARAM}=${kind}`;
