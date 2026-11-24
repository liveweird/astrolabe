import { jsonRequest, voidRequest } from "./http";
import type { components } from "./schema";

type Schemas = components["schemas"];

// ---- the saved cross-team proposals (1.26) ---------------------------------------------------------------------------------------
// A saved run is the SERVER's own re-computation of a run (never a document the client sends), kept for a second manager to open: a
// computation kept, not plan state. Any signed-in user reads; the row's `can` flags carry the write rights.

export type SavedProposalSummary = Schemas["SavedProposalSummary"];
export type SavedProposalRecord = Schemas["SavedProposalRecord"];
export type SavedProposalSaveBody = Schemas["SavedProposalSaveRequest"];

/** The query-key prefix every saved-proposal read lives under (and the accept and the delete refresh). */
export const SAVED_PROPOSALS_KEY = ["schedule-proposals", "saved"] as const;
export const savedProposalListKey = [...SAVED_PROPOSALS_KEY, "list"] as const;
export const savedProposalKey = (id: number) => [...SAVED_PROPOSALS_KEY, "record", id] as const;

/** The newest saved proposals (at most 20), newest first, without their documents. A bounded set, not paged. */
export async function listSavedProposals(): Promise<Schemas["SavedProposalList"]> {
  return jsonRequest<Schemas["SavedProposalList"]>("/api/v1/saved-schedule-proposals");
}

/** One saved proposal with its state, ticks, stored run and stored check (`proposal` is null when it is `UNREADABLE`). */
export async function getSavedProposal(id: number): Promise<SavedProposalRecord> {
  return jsonRequest<SavedProposalRecord>(`/api/v1/saved-schedule-proposals/${id}`);
}

/** Saves the run named by the body (the run's `asOf`, teams, `revision` and `scopeHash`) with the ticked moves; `409` when the plan moved since the run. */
export async function saveSavedProposal(body: SavedProposalSaveBody): Promise<SavedProposalSummary> {
  return jsonRequest<SavedProposalSummary>("/api/v1/saved-schedule-proposals", { method: "POST", body: JSON.stringify(body) });
}

/** A hard delete of the saved proposal (nothing of the plan changes). */
export async function deleteSavedProposal(id: number): Promise<void> {
  await voidRequest(`/api/v1/saved-schedule-proposals/${id}`, { method: "DELETE" });
}
