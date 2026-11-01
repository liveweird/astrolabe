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

/** Put `id` where `overId` is now (what dragging a row over another does: the rows in between shift by one). */
export function moveOver(ids: readonly number[], id: number, overId: number): number[] {
  const from = ids.indexOf(id);
  const to = ids.indexOf(overId);
  return from < 0 || to < 0 ? [...ids] : placeAt(ids, from, to);
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
 * The view as it will read once `ids` is saved: the ranked list in that order with positions 1..n, everything else unranked
 * (by name, case-insensitive, then id — the server's own order). An id the view does not know is skipped.
 */
export function applyRanking(view: RoadmapView, ids: readonly number[]): RoadmapView {
  const all = [...view.ranked.map((entry) => entry.project), ...view.unranked];
  const byId = new Map(all.map((project) => [project.id, project]));
  const ranked = ids.flatMap((id) => byId.get(id) ?? []).map((project, index) => ({ position: index + 1, project }));
  const rankedIds = new Set(ranked.map((entry) => entry.project.id));
  const unranked = all
    .filter((project) => !rankedIds.has(project.id))
    .sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()) || a.id - b.id);
  return { ...view, ranked, unranked };
}
