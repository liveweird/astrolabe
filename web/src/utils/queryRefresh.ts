import { hashKey, type QueryClient, type QueryKey } from "@tanstack/react-query";

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

/**
 * After a successful write on one cached entry of a view whose key carries more than the id (the team page's baseline pick and critical-chain toggle):
 * the INACTIVE sibling entries under `prefix` are removed, the written one kept. A sibling still holds the document as it was before the write (its
 * order list, its tray), and coming back to it would show that copy until its refetch lands - a change made from it in that window would be built on a
 * list the write has outdated. Without a copy the page shows the loading placeholder (writes refused) and then the fresh document.
 */
export function dropInactiveSiblings(queryClient: QueryClient, prefix: QueryKey, written: QueryKey): void {
  const keep = hashKey(written);
  queryClient.removeQueries({ queryKey: prefix, type: "inactive", predicate: (query) => query.queryHash !== keep });
}
