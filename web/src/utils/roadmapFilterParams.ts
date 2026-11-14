import { idOf } from "./deviationFilters";
import type { RoadmapFilters } from "./roadmapRows";

/** The Roadmap's whole filter state: the four filters and the program pick (the ids of the picked programs; empty = every program). */
export type RoadmapFilterState = { filters: RoadmapFilters; pick: number[] };

/** What a link may name: any of the filters and the pick (an unnamed one is off). */
export type RoadmapFilterLink = { filters?: Partial<RoadmapFilters>; pick?: readonly number[] };

/** The five parameter names, in the order they are written. */
const NAMES = ["programId", "workStreamId", "teamId", "ownerPersonId", "flagged"] as const;

/** More programs than this in one URL are cut (the plan has about twenty). */
const MAX_PICK = 100;

/** True when the URL names any of the five filter parameters (even a malformed one): such a URL is taken as written, a bare one is not. */
export function hasRoadmapFilterParams(params: URLSearchParams): boolean {
  return NAMES.some((name) => params.has(name));
}

/**
 * The filter state a URL names: every malformed value is dropped (a stale link never breaks the page), `flagged` is a state only as the exact word
 * `true`, a repeated `programId` is the pick (de-duplicated, ascending, at most 100). Anything the URL does not name is off.
 */
export function parseRoadmapFilter(params: URLSearchParams): RoadmapFilterState {
  const pick = [...new Set(params.getAll("programId").map(idOf).filter((id): id is number => id !== undefined))]
    .sort((a, b) => a - b)
    .slice(0, MAX_PICK);
  return {
    filters: {
      workStreamId: idOf(params.get("workStreamId")) ?? null,
      teamId: idOf(params.get("teamId")) ?? null,
      ownerPersonId: idOf(params.get("ownerPersonId")) ?? null,
      flaggedOnly: params.get("flagged") === "true",
    },
    pick,
  };
}

/** The state as URL parameters (only the set ones, in one stable order), the inverse of {@link parseRoadmapFilter}; empty when nothing is set. */
export function roadmapFilterParams({ filters, pick }: RoadmapFilterLink): URLSearchParams {
  const params = new URLSearchParams();
  for (const id of [...new Set(pick ?? [])].sort((a, b) => a - b).slice(0, MAX_PICK)) params.append("programId", String(id));
  if (filters?.workStreamId != null) params.set("workStreamId", String(filters.workStreamId));
  if (filters?.teamId != null) params.set("teamId", String(filters.teamId));
  if (filters?.ownerPersonId != null) params.set("ownerPersonId", String(filters.ownerPersonId));
  if (filters?.flaggedOnly === true) params.set("flagged", "true");
  return params;
}

/** The URL's search with its five filter parameters replaced by `state`'s; a foreign parameter is kept. */
export function withRoadmapFilterParams(current: URLSearchParams, state: RoadmapFilterLink): URLSearchParams {
  const next = new URLSearchParams(current);
  for (const name of NAMES) next.delete(name);
  for (const [name, value] of roadmapFilterParams(state)) next.append(name, value);
  return next;
}

/** True when the state narrows nothing (a bare URL says exactly this). */
export function isRoadmapFilterEmpty({ filters, pick }: RoadmapFilterState): boolean {
  return roadmapFilterParams({ filters, pick }).size === 0;
}
