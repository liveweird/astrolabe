import type { QueryClient } from "@tanstack/react-query";
import { refreshQueriesAfterMutation } from "./queryRefresh";

/**
 * After a write that changes which Flow team an Astrolabe team is linked to - a link, an unlink, "Link all suggested": the connection pages'
 * team lists (`["flow","teams"]`), the team pages' Flow panels (`["flow","team"]`, keyed by the team) and the capacity deviations
 * (`["flow","deviations"]`: a link or an unlink changes which teams they compare). Plan, team, project, Roadmap and Programs views also derive
 * Flow-capacity flags from those links, so they must move in the same refresh boundary.
 */
export function refreshFlowLinks(queryClient: QueryClient): Promise<void> {
  return refreshQueriesAfterMutation(queryClient, ["flow", "teams"], ["flow", "team"], ["flow", "deviations"], ["plan"], ["roadmap"]);
}

/**
 * After a capacity write or acknowledgement: re-read the source document and every view carrying derived Flow-capacity flags.
 */
export function refreshFlowCapacity(queryClient: QueryClient): Promise<void> {
  return refreshQueriesAfterMutation(queryClient, ["flow", "deviations"], ["plan"], ["roadmap"]);
}

/** A connection create, edit, delete, test or completed run can change availability and the flags derived from its mirror. */
export function refreshFlowConnections(queryClient: QueryClient): Promise<void> {
  return refreshQueriesAfterMutation(queryClient, ["flow"], ["plan"], ["roadmap"]);
}
