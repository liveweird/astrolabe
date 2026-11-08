import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { getCapacityDeviations, type CapacityDeviationConnection, type CapacityDeviationFilter } from "../api/capacityDeviations";
import { DEVIATIONS_POLL_MS, IDLE_REFRESH_MS } from "../utils/syncRuns";
import { useBoundedPoll } from "./useBoundedPoll";

/**
 * The capacity deviations live under the `["flow"]` prefix, in their own `["flow","deviations"]` branch: a Flow refresh (Refresh now, a run) re-reads
 * `["flow"]`, and the writes that change what the document compares - a link or unlink (`refreshFlowLinks`), an applied capacity import, a manual
 * capacity edit, a public holiday - invalidate this branch alone. No timeline view reads it.
 */
const capacityDeviationsKey = (filter: CapacityDeviationFilter) => ["flow", "deviations", "view", filter] as const;

/** Names what is running: every connection whose newest run is running, by connection and run id (the bounded poll's latch key); null = nothing. */
function runningKey(connections: readonly CapacityDeviationConnection[] | undefined): string | null {
  const running = (connections ?? []).filter((connection) => connection.status.lastRun?.running).map((connection) => `${connection.id}:${connection.status.lastRun?.id}`);
  return running.length === 0 ? null : running.join(",");
}

/**
 * The capacity deviation document. It refetches when the window regains focus (stated) and, while the SERVER says a run is running
 * (`status.lastRun.running`), at the Deviations page's bounded poll - the response that first reports the run finished carries the new data. The team
 * page also asks for the slow idle re-read its Flow panel has (`idleRefresh`), and only when there is a link to compare (`enabled`).
 */
export function useCapacityDeviations(filter: CapacityDeviationFilter, { enabled = true, idleRefresh = false }: { enabled?: boolean; idleRefresh?: boolean } = {}) {
  const poll = useBoundedPoll(DEVIATIONS_POLL_MS);
  return useQuery({
    queryKey: capacityDeviationsKey(filter),
    queryFn: () => getCapacityDeviations(filter),
    enabled,
    placeholderData: keepPreviousData,
    refetchOnWindowFocus: true,
    refetchInterval: (query) => poll(runningKey(query.state.data?.connections)) || (idleRefresh ? IDLE_REFRESH_MS : false),
  });
}
