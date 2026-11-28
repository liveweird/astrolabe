import { partialMatchKey, type QueryClient, type QueryKey } from "@tanstack/react-query";

/** Every entry of every team's view (each team, baseline pick and critical-chain toggle): `["plan","team",id,{baseline,chain}]`. */
export const TEAM_VIEWS_KEY = ["plan", "team"] as const;

/**
 * Refresh successful mutations without reusing a pending first fetch with no cached data.
 *
 * A refresh that covers the team views (`["plan"]`, `["plan","team"]`) also REMOVES the INACTIVE ones, synchronously, before anything is awaited. An entry
 * nobody observes would only be flagged stale and kept for the `gcTime`; coming back to the team page, `useQuery` returns that copy as real data, so the
 * page's loading refusal never engages and a change made in the first moments (Move up) is built on the list this very write has outdated. Without
 * the copy the page shows the loading placeholder (writes refused) and then the fresh document. The mounted entry stays: it refetches, and the
 * page's own next write must still be possible. A rank write names `["plan","team"]` too (the global rank is the default tail of every team's order).
 * Not covered: another person's or tab's write, which relies on the refetch on mount.
 */
export async function refreshQueriesAfterMutation(queryClient: QueryClient, ...queryKeys: QueryKey[]): Promise<void> {
  if (queryKeys.some((queryKey) => partialMatchKey(TEAM_VIEWS_KEY, queryKey))) {
    queryClient.removeQueries({ queryKey: TEAM_VIEWS_KEY, type: "inactive" });
  }
  // keepPreviousData belongs to the observer: default invalidation can still reuse that
  // query's initial fetch. Cancel every affected group before starting any fresh reads.
  await Promise.all(queryKeys.map((queryKey) => queryClient.cancelQueries({ queryKey })));
  await Promise.all(queryKeys.map((queryKey) => queryClient.invalidateQueries({ queryKey })));
}

/**
 * After a write that changes what the Jira flags and bars on the four timeline views show - a bind, an unlink, an import, an acknowledgement:
 * the Jira queries (`["jira"]`: the Deviations page, the chips, the bindings lists), `["plan"]` (the plan, project and team views) and
 * `["roadmap"]` (the roadmap and programs views). A scheduled poll changes the same flags with no write here; open pages catch up on focus.
 */
export function refreshJiraAndTimelines(queryClient: QueryClient): Promise<void> {
  return refreshQueriesAfterMutation(queryClient, ["jira"], ["plan"], ["roadmap"]);
}
