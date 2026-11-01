import type { RoadmapView } from "../api/roadmap";

// The ranking's pure order arithmetic: every change is "the new complete id list", which the wholesale PUT sends as it is.
// Nothing here mutates its input; an impossible change (unknown id, off either end) returns the list unchanged.

/** Move `id` by `delta` places (negative = up, towards rank 1), clamped to the ends. */
export function moveBy(ids: readonly number[], id: number, delta: number): number[] {
  const from = ids.indexOf(id);
  if (from < 0) return [...ids];
  return placeAt(ids, from, Math.min(Math.max(from + delta, 0), ids.length - 1));
}

/** Move `id` to the very top or the very bottom of the list (the team order's "Move to top" / "Move to bottom"). */
export function moveToEdge(ids: readonly number[], id: number, edge: "top" | "bottom"): number[] {
  const from = ids.indexOf(id);
  return from < 0 ? [...ids] : placeAt(ids, from, edge === "top" ? 0 : ids.length - 1);
}

/**
 * Drop `id` into the gap `slot` (0 = above the first row, `ids.length` = below the last; slot `n` is the gap before the row now at index `n`):
 * the row is taken out and re-inserted at `slot − 1` when the gap lies below it, else at `slot`. A slot of `from` or `from + 1` is the identity.
 */
export function moveToSlot(ids: readonly number[], id: number, slot: number): number[] {
  const from = ids.indexOf(id);
  if (from < 0) return [...ids];
  const clamped = Math.min(Math.max(slot, 0), ids.length);
  return placeAt(ids, from, clamped > from ? clamped - 1 : clamped);
}

/**
 * Drop `id` into the gap `slot` of the VISIBLE ranked rows (a filter hides some of the ranking): slot `n` is the gap before the visible row
 * now at index `n`, `visibleIds.length` the gap after the last one — `moveToSlot`'s numbering over the rows the user sees. In the FULL list `id`
 * lands just before the visible row that follows the gap (after the last visible row for the final gap); hidden rows keep their order, and a
 * gap beside the row itself (`from` or `from + 1`) is the identity. An id that is not in `fullIds` (an unranked row dropped into the list) is
 * inserted the same way; with no other visible row it goes at the end.
 */
export function moveAmongVisible(fullIds: readonly number[], visibleIds: readonly number[], id: number, slot: number): number[] {
  const from = visibleIds.indexOf(id);
  const clamped = Math.min(Math.max(slot, 0), visibleIds.length);
  if (from >= 0 && (clamped === from || clamped === from + 1)) return [...fullIds];
  const rest = fullIds.filter((existing) => existing !== id);
  const others = visibleIds.filter((existing) => existing !== id);
  if (others.length === 0) return fullIds.includes(id) ? [...fullIds] : [...rest, id];
  const to = from >= 0 && clamped > from ? clamped - 1 : clamped;
  const before = to < others.length ? rest.indexOf(others[to]) : rest.indexOf(others[others.length - 1]) + 1;
  rest.splice(before < 0 ? rest.length : before, 0, id);
  return rest;
}

/**
 * The ranking after a row was dropped into the gap `slot` of the DISPLAYED rows: the visible ranked rows, then the "Unranked" divider, then the
 * unranked rows. A slot up to the divider's own (`visibleRankedIds.length`) is a place in the ranking — a ranked row moves there, an unranked
 * one is RANKED there — and a slot beyond the divider takes a ranked row out of the ranking (Unrank); for an unranked row it changes nothing
 * (the list comes back equal, so the caller saves nothing).
 */
export function rankingAfterDrop(fullIds: readonly number[], visibleRankedIds: readonly number[], id: number, slot: number): number[] {
  return slot > visibleRankedIds.length ? removeId(fullIds, id) : moveAmongVisible(fullIds, visibleRankedIds, id, slot);
}

/** Are two id lists the same list (same ids in the same order)? */
export function sameIds(a: readonly number[], b: readonly number[]): boolean {
  return a.length === b.length && a.every((id, index) => id === b[index]);
}

function placeAt(ids: readonly number[], from: number, to: number): number[] {
  const next = [...ids];
  next.splice(to, 0, ...next.splice(from, 1));
  return next;
}

/** Rank an unranked project: it goes at the END (an id already in the list stays where it is). */
export function appendId(ids: readonly number[], id: number): number[] {
  return ids.includes(id) ? [...ids] : [...ids, id];
}

/** Unrank: drop the id, the rows below close up. */
export function removeId(ids: readonly number[], id: number): number[] {
  return ids.filter((existing) => existing !== id);
}

/**
 * The view as it will read once `ids` is saved: the ranked list in that order with positions 1..n (and each project's own `rankPosition` to
 * match), everything else unranked (`rankPosition` null; by name, case-insensitive, then id — the server's own order). An id the view does
 * not know is skipped. The derived figures (flags, spans) stay the server's until the refetch that follows the save.
 */
export function applyRanking(view: RoadmapView, ids: readonly number[]): RoadmapView {
  const all = [...view.ranked.map((entry) => entry.project), ...view.unranked];
  const byId = new Map(all.map((project) => [project.id, project]));
  const ranked = ids
    .flatMap((id) => byId.get(id) ?? [])
    .map((project, index) => ({ position: index + 1, project: { ...project, rankPosition: index + 1 } }));
  const rankedIds = new Set(ranked.map((entry) => entry.project.id));
  const unranked = all
    .filter((project) => !rankedIds.has(project.id))
    .map((project) => ({ ...project, rankPosition: null }))
    .sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()) || a.id - b.id);
  return { ...view, ranked, unranked };
}
