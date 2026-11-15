/**
 * `YYYY-MM-DD` ISO-date helpers shared by the metrics settings form (holidays), the reports (days
 * in the configured zone) and D1's dated Jira-user team membership (valid-from/valid-to, which are
 * calendar days in that same zone). The plain conversions are UTC; the `…InZone` ones take the
 * configured IANA zone. Neither reads the browser's local time zone (`localIsoDate` is the one deliberate exception: the UI's
 * "today"), so results are the same in every test/CI locale (the `utils/dataSourceState.ts` `formatEpochMillis` convention: never `toLocaleString()`).
 */

/** One fixed 24-hour day in millis — UTC calendar arithmetic only (zone days go through the `…InZone` helpers). */
export const DAY_MS = 86_400_000;

const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/** A real calendar date, not just the `YYYY-MM-DD` shape (rejects e.g. `2024-02-30`). */
export function isValidIsoDate(value: string): boolean {
  if (!ISO_DATE_PATTERN.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  return parsed.getUTCFullYear() === year && parsed.getUTCMonth() === month - 1 && parsed.getUTCDate() === day;
}

/** A `YYYY-MM-DD` string to its UTC midnight epoch millis. Caller validates the shape first. */
export function isoDateToEpochMillis(value: string): number {
  const [year, month, day] = value.split("-").map(Number);
  return Date.UTC(year, month - 1, day);
}

/** Epoch millis to `YYYY-MM-DD`, sliced from the UTC ISO string. */
export function epochMillisToIsoDate(epochMillis: number): string {
  return new Date(epochMillis).toISOString().slice(0, 10);
}

/**
 * The `YYYY-MM-DD` calendar date on the VIEWER'S wall calendar (the browser's local time zone) — what "today" means in the UI (the
 * timeline's today line, the Schedule button's start). Deliberately not UTC: a viewer east or west of Greenwich would otherwise see
 * yesterday or tomorrow for part of their day. Server-side dates stay plain ISO dates with no zone.
 */
export function localIsoDate(now: Date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

/** The `YYYY-MM-DD` date `days` calendar days after `iso` (negative = before), UTC. Caller validates the shape first. */
export function addDays(iso: string, days: number): string {
  return epochMillisToIsoDate(isoDateToEpochMillis(iso) + days * DAY_MS);
}

/**
 * Epoch millis to the `YYYY-MM-DD` calendar date it falls on in an IANA `timeZone` (the reports
 * read and cut their days in `metrics.settings.time_zone`, not UTC). `en-CA` because its date
 * format IS the ISO one; the parts are read individually rather than trusting that formatting.
 */
export function epochMillisToIsoDateInZone(epochMillis: number, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(
    new Date(epochMillis),
  );
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((p) => p.type === type)?.value ?? "";
  return `${part("year")}-${part("month")}-${part("day")}`;
}

/** Today's date as `YYYY-MM-DD` — in UTC by default, in `timeZone` where the caller has one (reports). */
export function todayIsoDate(timeZone = "UTC"): string {
  return epochMillisToIsoDateInZone(Date.now(), timeZone);
}
