import { getTeamView } from "../api/teams";
import { applyTeamSchedule } from "../utils/teamViewUpdate";
import { useScheduleWritePath } from "./useScheduleWritePath";

/**
 * The cache key of one team's view, its baseline pick and its critical chain (v0.9: another pick is another entry; 1.27: so is the chain, the
 * document that also carries `criticalChain`) - under the `["plan"]` prefix like the project view, so every plan mutation refreshes a mounted team page.
 * The page's three writes take the SAME `(baseline, chain)` pair as the view and build their key here, so a write never stores a document under the other entry's key.
 */
export const teamViewKey = (teamId: number, baseline: number | null, chain = false) => ["plan", "team", teamId, { baseline, chain }] as const;
/** Every entry of one team's view (each pick and chain): what a successful write clears of its inactive siblings. */
export const teamViewPrefix = (teamId: number) => ["plan", "team", teamId] as const;
/** The mutation key the team page's two writes (schedule, order) share, so neither starts while the other is in flight. */
export const teamWriteKey = (teamId: number) => ["plan", "team-write", teamId] as const;

/**
 * The team page's data and its schedule write path: the project view's, generalised (`useScheduleWritePath`) over `GET /views/team/{id}`.
 * `chain` (1.27, the page's Critical path toggle) asks for the critical chain too and selects its own entry; a chain-only key change keeps the
 * baseline overlay of the same pick (`overlayPick`).
 */
export function useTeamSchedule(teamId: number, baseline: number | null, chain = false) {
  return useScheduleWritePath({
    queryKey: teamViewKey(teamId, baseline, chain),
    queryFn: () => getTeamView(teamId, baseline, chain),
    apply: applyTeamSchedule,
    enabled: Number.isInteger(teamId),
    writeKey: teamWriteKey(teamId),
    overlayPick: baseline,
    siblings: teamViewPrefix(teamId),
  });
}
