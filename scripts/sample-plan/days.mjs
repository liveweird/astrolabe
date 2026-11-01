// Day arithmetic shared by the sample-plan generator, its self-test and the loader (node built-ins only).
//
// The dataset stores every date as an integer DAY OFFSET from an anchor Monday. Offset 0 is the anchor, so the weekday of an offset is
// `((d % 7) + 7) % 7` (0 = Monday ... 6 = Sunday) and the arithmetic needs no calendar. The working-day rule is the server's
// (`infra/time/WorkingCalendar.kt`, `WorkingCalendar.MON_FRI`) with an EMPTY holiday table: Monday to Friday, `workIndex` flat over a weekend and consecutive Friday -> Monday.
// The generator, its statistics (`summary.json`) and the self-test are holiday-free BY CONSTRUCTION and stay so whatever the stack's holiday
// dictionary holds: the loader's `--polish-holidays` (v0.7) only fills the server's dictionary, after which the server's own load/overload/
// dependency figures differ from `summary.json` (the measured shift: `timeline.md` "Measured figures (v0.7)"), never these helpers.

export const weekday = (d) => ((d % 7) + 7) % 7;
export const isWorking = (d) => weekday(d) < 5;
export const mondayOf = (d) => d - weekday(d);
export const nextWorkingOnOrAfter = (d) => (weekday(d) < 5 ? d : d + (7 - weekday(d)));
export const prevWorkingOnOrBefore = (d) => (weekday(d) < 5 ? d : d - (weekday(d) - 4));
export const workIndex = (d) => 5 * Math.floor(d / 7) + Math.min(weekday(d), 4);
/** The calendar offset of working-day index `w` (the inverse of `workIndex` on working days). */
export const dayOfWorkIndex = (w) => 7 * Math.floor(w / 5) + (((w % 5) + 5) % 5);
/** Working days in the inclusive span [start, end]; 0 for a span without one. */
export const workingDaysBetween = (start, end) => Math.max(0, workIndex(prevWorkingOnOrBefore(end)) - workIndex(nextWorkingOnOrAfter(start)) + 1);

const MS_PER_DAY = 86_400_000;
const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** The UTC midnight of an ISO date, or throws. */
export function parseIsoDate(text) {
  const m = ISO_DATE.exec(text);
  const ms = m ? Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : Number.NaN;
  if (!m || Number.isNaN(ms) || new Date(ms).toISOString().slice(0, 10) !== text) throw new Error(`not an ISO date (YYYY-MM-DD): ${text}`);
  return ms;
}

/** The ISO date `offset` days after the ISO date `anchor`. */
export function isoDateAt(anchor, offset) {
  return new Date(parseIsoDate(anchor) + offset * MS_PER_DAY).toISOString().slice(0, 10);
}

/** Whether the ISO date is a Monday. */
export const isMonday = (iso) => new Date(parseIsoDate(iso)).getUTCDay() === 1;

/** The Monday (ISO date) of the week containing `now`, in UTC. */
export function mondayOfWeek(now = new Date()) {
  const utc = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const sinceMonday = (new Date(utc).getUTCDay() + 6) % 7;
  return new Date(utc - sinceMonday * MS_PER_DAY).toISOString().slice(0, 10);
}

/** The server's schedule rule (`containsWorkingDay`): the inclusive span holds a Monday-Friday day (looking at no more than seven days). */
export function containsWorkingDay(start, end) {
  for (let d = start; d <= end && d < start + 7; d++) if (isWorking(d)) return true;
  return false;
}
