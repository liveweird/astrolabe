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
const ID_KEYS = ["connectionId", "workStreamId", "programId", "projectId", "teamId"] as const;

const oneOf = <T extends string>(allowed: readonly T[], value: string | null): T | undefined => allowed.find((a) => a === value);

/** A positive integer id from a URL value; anything else (blank, `0`, `1e3`, `-2`, `7abc`, out of range) is ignored. */
function idOf(value: string | null): number | undefined {
  if (value === null || !/^[1-9]\d{0,9}$/.test(value)) return undefined;
  const id = Number(value);
  return id <= 2_147_483_647 ? id : undefined;
}

/** The page's filters as read from the URL: every unknown or malformed value is dropped (a stale link never breaks the page); `all` only as the exact word `true`. */
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
  if (filter.all !== undefined) params.set("all", String(filter.all));
  return params;
}

/** How many filters narrow the list: the ones the panel shows count too; `all` widens it, so it is not counted. */
export function narrowingCount(filter: DeviationFilter): number {
  return Object.entries(filter).filter(([key, value]) => key !== "all" && value !== undefined).length;
}
