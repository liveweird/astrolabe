import { useEffect, useMemo } from "react";
import { useDebouncedValue } from "@mantine/hooks";
import { useQuery } from "@tanstack/react-query";
import { checkSchedule } from "../api/scheduleProposals";
import type { ScheduleProposalMove } from "../api/teams";
import { acceptItems, type ScheduleCheckState } from "../utils/scheduleProposal";

/** How long the ticks must rest before the server is asked: a run of clicks is one question. */
const CHECK_DEBOUNCE_MS = 300;

type CheckItems = ReturnType<typeof acceptItems>;

/** Where `ticked` moves of `total` stand: every one (or no move to tick at all), none, or some. */
const modeOf = (ticked: number, total: number): ScheduleCheckState["mode"] => (ticked >= total ? "all" : ticked === 0 ? "none" : "some");

/**
 * The ticked-subset check of a schedule proposal (1.8): the proposal's own link verdicts and proposed load describe EVERY move accepted,
 * so while only SOME moves are ticked the server (`POST /schedule-proposals/check`, a computation) is asked for the verdicts of exactly
 * those moves, and the page shows its answer (`overlayCheck`). All ticked is the proposal's own answer and none ticked changes nothing,
 * so neither sends a request. The ticks are debounced (300 ms); the query is keyed by the debounced ticked items, so an answer for an
 * older selection is never shown for the current one (`pending` covers the debounce window and the request, a cancelled one is asked again; `byTeam` is `null` until the
 * answer for the CURRENT ticks is in). `enabled` is false while no proposal is open. Writes nothing and holds no lock; a failure is `failed`.
 */
export function useScheduleCheck({
  teamIds,
  revision,
  scopeHash,
  moves,
  selected,
  enabled,
}: {
  teamIds: readonly number[];
  revision: number;
  /** The proposal's scope fingerprint: a proposal re-asked after a scope change has the same moves but may judge them differently. */
  scopeHash: string;
  moves: readonly ScheduleProposalMove[];
  selected: ReadonlySet<number>;
  enabled: boolean;
}): ScheduleCheckState {
  const total = moves.length;
  const ticked = acceptItems({ moves }, selected);
  // A string, not the array: the debounce compares by identity and the items are rebuilt on every render.
  const current = JSON.stringify(ticked);
  const [debounced] = useDebouncedValue(current, CHECK_DEBOUNCE_MS);
  const items = useMemo(() => JSON.parse(debounced) as CheckItems, [debounced]);
  const settled = debounced === current;
  // The request follows the DEBOUNCED ticks, and only once they have caught up with the current ones (a proposal that replaced the last one
  // must not send the old items).
  const sortedTeamIds = [...teamIds].sort((a, b) => a - b);
  const queryEnabled = enabled && settled && modeOf(items.length, total) === "some";
  const query = useQuery({
    queryKey: ["plan", "schedule-check", sortedTeamIds, revision, scopeHash, items],
    queryFn: () => checkSchedule({ teamIds: sortedTeamIds, items }),
    enabled: queryEnabled,
  });
  // A write's `cancelQueries(["plan"])` can cancel a check in flight; with no data it reverts to pending-and-idle and nothing would ask again.
  const cancelled = queryEnabled && query.isPending && query.fetchStatus === "idle";
  const { refetch } = query;
  useEffect(() => {
    if (cancelled) void refetch();
  }, [cancelled, refetch]);
  const mode = enabled ? modeOf(ticked.length, total) : "all";
  const some = mode === "some";
  return {
    mode,
    byTeam: some && settled && query.data ? new Map(query.data.teams.map((team) => [team.teamId, team])) : null,
    pending: some && (!settled || query.isFetching || cancelled),
    failed: some && settled && query.isError && !query.data,
  };
}
