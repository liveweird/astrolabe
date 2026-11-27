import { teamLoadFilterParams, type TeamLoadWarning } from "./teamLoadFilters";

/** The ONE place the teams route family is spelled out — never hand-assemble a team URL. */
export const teamsPath = "/teams";
export const teamPath = (id: number) => `${teamsPath}/${id}`;

/** `/teams?warning=overloaded|wip|any`: the teams with that warning (Home's two capacity badges). Spelled through `teamLoadFilterParams`, so the page reads back what was written. */
export const teamsWarningPath = (warning: TeamLoadWarning) => `${teamsPath}?${teamLoadFilterParams({ warning })}`;
