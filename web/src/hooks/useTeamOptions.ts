import { useQuery } from "@tanstack/react-query";
import { listEveryTeam } from "../api/teams";
import type { TeamColour } from "../utils/teamColours";

/** One name, id and colour per team: all a filter select, a swatch and the colour editor need. */
export type TeamOption = { id: number; name: string; colour: TeamColour };

/** Stable between renders while the read has not answered. */
const NONE: readonly TeamOption[] = [];

/**
 * EVERY team by name for the filter selects (Milestones, Dependencies, Deviations), as ONE cached query under `["teams","options"]` - the prefix every
 * team write refreshes (Lettuce's `useAllUsers` shape: one key, one shape under it, so no picker hides the people past one page of 100).
 * `settled` is true once a read has succeeded (a failed re-read keeps the last copy): a select says "Team 12" for an id the list lacks only then,
 * never while the list is on its way or failed - nothing is said about a team from data that has not arrived.
 * `failed` is true while the read has failed and nothing was ever read (a field that holds a team id then stops waiting and says "Team 12").
 */
export function useTeamOptions(): { teams: readonly TeamOption[]; settled: boolean; failed: boolean } {
  const { data, isError } = useQuery({ queryKey: ["teams", "options"], queryFn: listEveryTeam });
  return { teams: data ?? NONE, settled: data !== undefined, failed: isError && data === undefined };
}
