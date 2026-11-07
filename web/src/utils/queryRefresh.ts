import type { QueryClient, QueryKey } from "@tanstack/react-query";

/** Refresh successful mutations without reusing a pending first fetch with no cached data. */
export async function refreshQueriesAfterMutation(queryClient: QueryClient, ...queryKeys: QueryKey[]): Promise<void> {
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
