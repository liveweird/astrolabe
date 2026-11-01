import type { TeamView } from "../api/teams";

/**
 * The team order PUT's list (`PUT /teams/{id}/milestone-order` is wholesale: what it does not list is forgotten). A manager's order is
 * never reshuffled — only unlisted newcomers slot in at the bottom by project rank, Reset (the empty list) restores the default — so a
 * milestone the manager placed and later UNSCHEDULED must keep its stored place even though the page shows no row for it. Pure.
 *
 * The FULL list is `order.milestoneIds` (the stored order, scheduled or not) followed by the scheduled rows it does not list, in their
 * displayed order. A reorder of the scheduled rows is a permutation of the displayed scheduled ids; it is applied by keeping every
 * unscheduled listed id at its INDEX in the full list and filling the other slots, in order, with that permutation. Example: stored
 * [A, B, M, C], M unscheduled, "Move C to top" → permutation [C, A, B] → PUT [C, A, M, B]. Unlisted unscheduled milestones stay unlisted.
 */
export function fullOrderList(view: TeamView): number[] {
  const listed = new Set(view.order.milestoneIds);
  return [...view.order.milestoneIds, ...view.scheduled.map((milestone) => milestone.id).filter((id) => !listed.has(id))];
}

/**
 * The list to PUT after the scheduled rows were reordered into [permutation] (a permutation of the view's displayed scheduled ids; the
 * Move buttons and a row drag both produce one). A [permutation] that is not one — a different length, a repeated or unknown id — is a
 * caller bug and changes nothing: `null` is returned, and the caller writes nothing.
 */
export function placeScheduled(view: TeamView, permutation: readonly number[]): number[] | null {
  const full = fullOrderList(view);
  const scheduled = new Set(view.scheduled.map((milestone) => milestone.id));
  const isPermutation = permutation.length === scheduled.size && new Set(permutation).size === scheduled.size && permutation.every((id) => scheduled.has(id));
  if (!isPermutation) return null;
  const fill = [...permutation];
  return full.map((id) => (scheduled.has(id) ? (fill.shift() as number) : id));
}
