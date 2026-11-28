import { useState } from "react";

/** The most teams one run takes (the server's `teamIds` ceiling): above it Propose is off and the page says so. */
export const MAX_RUN_TEAMS = 50;

const sameSet = (a: readonly number[], b: readonly number[]) => a.length === b.length && a.every((id) => b.includes(id));

/**
 * The teams a cross-team run is asked over (1.38): the page's own set (`defaultIds`, derived by the page and followed while nothing is chosen) until the viewer picks another
 * (`set`), which is page state only (never remembered; it dies with the page). A choice that equals the default as a set is no choice: `ids` is then `defaultIds` itself, so an untouched
 * picker asks for exactly what the page always asked for. `chosen` says the viewer's set differs from the page's. A chosen set is kept sorted by id, the order the defaults come in.
 * Choosing the page's own set (by hand, or the reset) stores NO choice, so the picker goes on following the page when its set changes later.
 */
export function useRunTeams(defaultIds: number[]): { ids: number[]; chosen: boolean; set: (ids: readonly number[]) => void } {
  const [picked, setPicked] = useState<number[] | null>(null);
  const chosen = picked !== null && !sameSet(picked, defaultIds);
  const set = (ids: readonly number[]) => {
    const next = [...new Set(ids)].sort((a, b) => a - b);
    setPicked(sameSet(next, defaultIds) ? null : next);
  };
  return { ids: chosen ? picked : defaultIds, chosen, set };
}
