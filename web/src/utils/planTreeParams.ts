import { idOf } from "./deviationFilters";
import type { PlanFilter } from "./planTree";

// The Plan page's filters as the ADDRESS holds them (`?q=…&ownerPersonId=…&hideClosed=true`). They are state in the address and nothing else: not
// remembered, so a link shows what its sender saw and a bare visit shows the whole plan. Every other parameter of the address (the focus, later) is
// kept as it is.

const NAMES = ["q", "ownerPersonId", "hideClosed"] as const;

/** A search is at most one name long (the server caps names at 100 characters). */
export const MAX_QUERY = 100;

/** The filter a URL names: a blank or malformed value is dropped (a stale link never breaks the page); `hideClosed` is on only as the exact word `true`. */
export function parsePlanFilter(params: URLSearchParams): PlanFilter {
  return {
    q: (params.get("q") ?? "").trim().slice(0, MAX_QUERY),
    ownerPersonId: idOf(params.get("ownerPersonId")) ?? null,
    hideClosed: params.get("hideClosed") === "true",
  };
}

/** The URL's search with the filter's three parameters replaced by `filter`'s (only the set ones are written); every other parameter is kept. */
export function withPlanFilter(current: URLSearchParams, filter: PlanFilter): URLSearchParams {
  const next = new URLSearchParams(current);
  for (const name of NAMES) next.delete(name);
  const q = filter.q.trim().slice(0, MAX_QUERY);
  if (q !== "") next.set("q", q);
  if (filter.ownerPersonId !== null) next.set("ownerPersonId", String(filter.ownerPersonId));
  if (filter.hideClosed) next.set("hideClosed", "true");
  return next;
}

/** How many parts of the filter are on (the badge of the filter toggle). */
export function activeFilterCount(filter: PlanFilter): number {
  return Number(filter.q.trim() !== "") + Number(filter.ownerPersonId !== null) + Number(filter.hideClosed);
}
