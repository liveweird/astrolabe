import type { QueryClient } from "@tanstack/react-query";
import { refreshQueriesAfterMutation } from "./queryRefresh";

/**
 * After a write that changes which Flow team an Astrolabe team is linked to - a link, an unlink, "Link all suggested": the connection pages'
 * team lists (`["flow","teams"]`) and the team pages' Flow panels (`["flow","team"]`, keyed by the team). Nothing of the timeline views moves
 * (a link carries no plan state), so unlike a Jira bind this never touches `["plan"]` or `["roadmap"]`.
 */
export function refreshFlowLinks(queryClient: QueryClient): Promise<void> {
  return refreshQueriesAfterMutation(queryClient, ["flow", "teams"], ["flow", "team"]);
}
