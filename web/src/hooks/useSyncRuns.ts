import { useQuery } from "@tanstack/react-query";
import { listSyncRuns, type SyncKind, type SyncRun } from "../api/sync";
import { useBoundedPoll } from "./useBoundedPoll";

/** The query key of one connection's runs: under the `["jira"]` prefix the connection page's mutations refresh. */
export const syncRunsKey = (kind: SyncKind, connectionId: number) => ["jira", "runs", kind, connectionId] as const;

/** The id of the newest run that is running (the list is newest first), or null: what the poll's safety latch is keyed on. */
function newestLiveRunId(runs: readonly SyncRun[] | undefined): string | null {
  const live = runs?.find((run) => run.running);
  return live ? String(live.id) : null;
}

/**
 * One connection's runs (the newest 50), polled while the SERVER says a run is running (`run.running`: unfinished and inside its claim
 * window; the client never judges a run's age). It stops when the run ends and when the page unmounts (the query's observer goes away
 * with it). As a safety net the poll also stops `RUN_POLL_MAX_MS` after the page first saw the newest running run, and a new run starts
 * it again (`useBoundedPoll`).
 */
export function useSyncRuns(kind: SyncKind, connectionId: number, enabled: boolean) {
  const poll = useBoundedPoll();
  const query = useQuery({
    queryKey: syncRunsKey(kind, connectionId),
    queryFn: () => listSyncRuns(kind, connectionId),
    enabled,
    refetchInterval: (q) => poll(newestLiveRunId(q.state.data?.items)),
  });
  const runs = query.data?.items;
  return { runs, isLoading: query.isLoading, isError: query.isError, error: query.error, live: runs?.some((run) => run.running) ?? false };
}
