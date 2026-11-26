import { idOf } from "./deviationFilters";
import { planPath } from "./planLinks";
import type { PlanFilter, PlanFocus } from "./planTree";

// The Plan page's filters and focus as the ADDRESS holds them (`?q=…&ownerPersonId=…&hideClosed=true&workStreamId=…|programId=…`). They are state in
// the address and nothing else: not remembered, so a link shows what its sender saw and a bare visit shows the whole plan. Every other parameter of
// the address is kept as it is.

const NAMES = ["q", "ownerPersonId", "hideClosed", "workStreamId", "programId"] as const;

/** A search is at most one name long (the server caps names at 100 characters). */
export const MAX_QUERY = 100;

/**
 * The foci a URL names, the one that wins first: a program wins over a work stream (a link names one); a malformed id is dropped. An address that
 * names both (a hand-edited one) is resolved against the plan by the caller: a program the plan does not hold falls back to the work stream.
 */
export function parseFoci(params: URLSearchParams): PlanFocus[] {
  const foci: PlanFocus[] = [];
  const programId = idOf(params.get("programId"));
  if (programId !== undefined) foci.push({ kind: "program", id: programId });
  const workStreamId = idOf(params.get("workStreamId"));
  if (workStreamId !== undefined) foci.push({ kind: "workStream", id: workStreamId });
  return foci;
}

/** The filter a URL names: a blank or malformed value is dropped (a stale link never breaks the page); `hideClosed` is on only as the exact word `true`. */
export function parsePlanFilter(params: URLSearchParams): PlanFilter {
  return {
    q: (params.get("q") ?? "").trim().slice(0, MAX_QUERY),
    ownerPersonId: idOf(params.get("ownerPersonId")) ?? null,
    hideClosed: params.get("hideClosed") === "true",
    focus: parseFoci(params)[0] ?? null,
  };
}

/** The URL's search with the filter's parameters replaced by `filter`'s (only the set ones are written); every other parameter is kept. */
export function withPlanFilter(current: URLSearchParams, filter: PlanFilter): URLSearchParams {
  const next = new URLSearchParams(current);
  for (const name of NAMES) next.delete(name);
  const q = filter.q.trim().slice(0, MAX_QUERY);
  if (q !== "") next.set("q", q);
  if (filter.ownerPersonId !== null) next.set("ownerPersonId", String(filter.ownerPersonId));
  if (filter.hideClosed) next.set("hideClosed", "true");
  if (filter.focus !== null) next.set(filter.focus.kind === "program" ? "programId" : "workStreamId", String(filter.focus.id));
  return next;
}

/** The Plan path with `filter` in its address (the ONE spelling of a focused or filtered Plan link: "Show only this", the breadcrumb). */
export function planFilterPath(current: URLSearchParams, filter: PlanFilter): string {
  const query = withPlanFilter(current, filter).toString();
  return query === "" ? planPath : `${planPath}?${query}`;
}

/** How many parts of the filter are on (the badge of the filter toggle; the focus has its own breadcrumb). */
export function activeFilterCount(filter: PlanFilter): number {
  return Number(filter.q.trim() !== "") + Number(filter.ownerPersonId !== null) + Number(filter.hideClosed);
}
