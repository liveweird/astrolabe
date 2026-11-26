import { useMemo } from "react";
import type { TeamColour } from "../utils/teamColours";
import { useTeamOptions } from "./useTeamOptions";

/**
 * Team id → colour key, over the ONE cached teams read (`["teams","options"]`, `useTeamOptions`): no view document names a team's colour. A
 * team the read lacks (deleted, or the read not answered yet) is absent from the map, and a mark draws nothing for it.
 */
export function useTeamColours(): ReadonlyMap<number, TeamColour> {
  const { teams } = useTeamOptions();
  return useMemo(() => new Map(teams.map((team) => [team.id, team.colour])), [teams]);
}
