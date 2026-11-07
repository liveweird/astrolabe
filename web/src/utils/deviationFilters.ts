import type { DeviationFilter, DeviationKind, DeviationLevel, DeviationSeverity } from "../api/deviations";

const LEVELS: readonly DeviationLevel[] = ["PROGRAM", "PROJECT", "MILESTONE"];
const SEVERITIES: readonly DeviationSeverity[] = ["WARNING", "INFO"];
const KINDS: readonly DeviationKind[] = [
  "GONE",
  "LEVEL_MISMATCH",
  "PARENT_MISMATCH",
  "RENAMED",
  "START_DIFFERS",
  "END_DIFFERS",
  "TARGET_DIFFERS",
  "UNSCHEDULED_IN_PLAN",
  "UNSCHEDULED_IN_JIRA",
  "ESTIMATE_DIFFERS",
  "ESTIMATE_NOT_COMPARABLE",
  "PROGRESS_MISMATCH",
];
const BOOLEAN_KEYS = ["acknowledged", "all"] as const;
const ID_KEYS = ["connectionId", "workStreamId", "programId", "projectId", "teamId"] as const;

const oneOf = <T extends string>(allowed: readonly T[], value: string | null): T | undefined => allowed.find((a) => a === value);

/** A positive integer id from a URL value; anything else (blank, `0`, `1e3`, `-2`, `7abc`, out of range) is ignored. */
function idOf(value: string | null): number | undefined {
  if (value === null || !/^[1-9]\d{0,9}$/.test(value)) return undefined;
  const id = Number(value);
  return id <= 2_147_483_647 ? id : undefined;
}

/** The page's filters as read from the URL: every unknown or malformed value is dropped (a stale link never breaks the page); `all` as the exact word `true` / `false`, `acknowledged` only as `true`. */
export function parseDeviationFilter(params: URLSearchParams): DeviationFilter {
  const filter: DeviationFilter = {};
  for (const key of ID_KEYS) {
    const id = idOf(params.get(key));
    if (id !== undefined) filter[key] = id;
  }
  const level = oneOf(LEVELS, params.get("level"));
  if (level !== undefined) filter.level = level;
  const severity = oneOf(SEVERITIES, params.get("severity"));
  if (severity !== undefined) filter.severity = severity;
  const kind = oneOf(KINDS, params.get("kind"));
  if (kind !== undefined) filter.kind = kind;
  const all = params.get("all");
  if (all === "true" || all === "false") filter.all = all === "true";
  // Only `acknowledged=true` is a state of the page. `false` is dropped: with `all` in force it would list the clean, never-acknowledged
  // bindings too, which no Status choice means (Open is "no parameter", or the `all=false` override under a scope).
  if (params.get("acknowledged") === "true") filter.acknowledged = true;
  return filter;
}

/** The filters as URL parameters (only the set ones, in one stable order), the inverse of {@link parseDeviationFilter}. */
export function deviationFilterParams(filter: DeviationFilter): URLSearchParams {
  const params = new URLSearchParams();
  for (const key of ID_KEYS) {
    const value = filter[key];
    if (value !== undefined) params.set(key, String(value));
  }
  if (filter.level !== undefined) params.set("level", filter.level);
  if (filter.severity !== undefined) params.set("severity", filter.severity);
  if (filter.kind !== undefined) params.set("kind", filter.kind);
  for (const key of BOOLEAN_KEYS) {
    const value = filter[key];
    if (value !== undefined) params.set(key, String(value));
  }
  return params;
}

/** How many filters narrow the list: the ones the panel shows count too (the Status select's Acknowledged included); `all` widens it, so it is not counted. */
export function narrowingCount(filter: DeviationFilter): number {
  return Object.entries(filter).filter(([key, value]) => key !== "all" && value !== undefined).length;
}

/** The Status select's three choices: the OPEN items (the server's default), the currently ACKNOWLEDGED ones, or ALL of them. */
export type DeviationStatus = "open" | "acknowledged" | "all";

/**
 * The Status the filters read as. `acknowledged=true` is Acknowledged; otherwise whether `all` is in force - given, or implied by a project or team
 * scope, the server's rule - decides between All and Open.
 */
export function deviationStatus(filter: DeviationFilter): DeviationStatus {
  if (filter.acknowledged === true) return "acknowledged";
  return (filter.all ?? (filter.projectId !== undefined || filter.teamId !== undefined)) ? "all" : "open";
}

/**
 * The filter change a Status choice makes, composed as the server does. Open sends no parameter - except under a project or team scope, which
 * implies `all`, where it sends `all=false` (the override) so the list is the open items and not every link. Acknowledged sends
 * `acknowledged=true` and keeps an explicit `all=true` (the "Show everything" switch still decides about the estimate lines). All sends `all=true` and
 * drops `acknowledged`.
 */
export function deviationStatusPatch(status: DeviationStatus, filter: DeviationFilter): Partial<DeviationFilter> {
  const scoped = filter.projectId !== undefined || filter.teamId !== undefined;
  switch (status) {
    case "open":
      return { acknowledged: undefined, all: scoped ? false : undefined };
    case "acknowledged":
      // An explicit all=false has no effect on an acknowledged list (only an explicit all=true does: the estimate lines), so it is not carried over.
      return { acknowledged: true, all: filter.all === true ? true : undefined };
    case "all":
      return { acknowledged: undefined, all: true };
  }
}

const isScoped = (filter: DeviationFilter) => filter.projectId !== undefined || filter.teamId !== undefined;

/**
 * A filter change that adds or removes a project / team scope must not flip an Open the user chose, because the server implies `all` under a
 * scope. A change that names `all` or `acknowledged` itself (the Status select, the switch) is left as it is.
 *  - Open + a scope added: send the override `all=false` (the same patch the Status select sends); Open + the last scope removed: drop it again.
 *  - All that only the scope implied goes with the scope: removing the last project / team chip falls back to the default Open list (the implied
 *    `all` is the chip's - "is it linked, and how" - and not a choice; an explicit `all=true` is the user's and stays).
 *  - Acknowledged is unaffected by the implied `all`.
 */
export function keepStatus(filter: DeviationFilter, patch: Partial<DeviationFilter>): Partial<DeviationFilter> {
  if ("all" in patch || "acknowledged" in patch) return patch;
  const before = isScoped(filter);
  const after = isScoped({ ...filter, ...patch });
  if (before === after || deviationStatus(filter) !== "open") return patch;
  return { ...patch, all: after ? false : undefined };
}
