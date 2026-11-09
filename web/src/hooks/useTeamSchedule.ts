import { getTeamView } from "../api/teams";
import { applyTeamSchedule } from "../utils/teamViewUpdate";
import { useScheduleWritePath } from "./useScheduleWritePath";

/** The cache key of one team's view and baseline pick (v0.9: another pick is another entry) — under the `["plan"]` prefix like the project view, so every plan mutation refreshes a mounted team page. */
export const teamViewKey = (teamId: number, baseline: number | null) => ["plan", "team", teamId, { baseline }] as const;
/** The mutation key the team page's two writes (schedule, order) share, so neither starts while the other is in flight. */
export const teamWriteKey = (teamId: number) => ["plan", "team-write", teamId] as const;

/** The team page's data and its schedule write path: the project view's, generalised (`useScheduleWritePath`) over `GET /views/team/{id}`. */
export function useTeamSchedule(teamId: number, baseline: number | null) {
  return useScheduleWritePath({
    queryKey: teamViewKey(teamId, baseline),
    queryFn: () => getTeamView(teamId, baseline),
    apply: applyTeamSchedule,
    enabled: Number.isInteger(teamId),
    writeKey: teamWriteKey(teamId),
  });
}
