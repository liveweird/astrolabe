import type { QueryClient } from "@tanstack/react-query";
import { refreshQueriesAfterMutation } from "./queryRefresh";

/**
 * After a write that changes which Flow team an Astrolabe team is linked to - a link, an unlink, "Link all suggested": the connection pages'
 * team lists (`["flow","teams"]`), the team pages' Flow panels (`["flow","team"]`, keyed by the team) and the capacity deviations
 * (`["flow","deviations"]`: a link or an unlink changes which teams they compare). Nothing of the timeline views moves (a link carries no plan
 * state), so unlike a Jira bind this never touches `["plan"]` or `["roadmap"]`.
 */
export function refreshFlowLinks(queryClient: QueryClient): Promise<void> {
  return refreshQueriesAfterMutation(queryClient, ["flow", "teams"], ["flow", "team"], ["flow", "deviations"]);
}

/**
 * After a per-sprint capacity acknowledge or its withdrawal: the capacity deviations (`["flow","deviations"]`: the Deviations page's section and the
 * team page's lines) and the plan's views (`["plan"]`: the team view's flag and week markers follow the open rows). A link carries no plan state, but
 * an acknowledgement does reach the team view.
 */
export function refreshCapacityAcknowledgements(queryClient: QueryClient): Promise<void> {
  return refreshQueriesAfterMutation(queryClient, ["flow", "deviations"], ["plan"]);
}
