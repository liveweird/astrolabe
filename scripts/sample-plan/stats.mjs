// A JS port of the team view's load / capacity / WIP arithmetic (`planning/LoadKernels.kt`, `.claude/docs/planning-model.md`), over day
// OFFSETS (days.mjs). It serves two purposes only: the generator tunes each capacity period and WIP limit against the schedule it just
// drew (so the dataset shows overloaded and WIP-exceeded weeks at a chosen rate), and the self-test measures those rates on the written
// files. The server's kernel stays the truth; the one rounding per figure is `Math.round(x * 100) / 100` (HALF_UP for these positives).
import { isWorking, mondayOf, nextWorkingOnOrAfter, prevWorkingOnOrBefore, workIndex, workingDaysBetween } from "./days.mjs";

const round2 = (x) => Math.round(x * 100) / 100;

/** The period in force on `day` (the greatest `from` not after it), or null before the first. `periods` is sorted by `from`. */
export function periodOn(day, periods) {
  let found = null;
  for (const p of periods) {
    if (p.from > day) break;
    found = p;
  }
  return found;
}

/** A week's capacity: null when no period is in force on any of its working days, else the per-day sum over five, rounded. */
export function weekCapacity(monday, periods) {
  let sum = 0;
  let covered = false;
  for (let i = 0; i < 5; i++) {
    const p = periodOn(monday + i, periods);
    if (p) {
      covered = true;
      sum += p.mdPerWeek;
    }
  }
  return covered ? round2(sum / 5) : null;
}

/** The scheduled milestones' share of each ISO week, keyed by Monday offset: `items` = [{start, end, estimateMd}]. */
export function weeklyLoads(items) {
  const loads = new Map();
  for (const it of items) {
    const n = workingDaysBetween(it.start, it.end);
    if (n <= 0) continue;
    for (let mon = mondayOf(it.start); mon <= it.end; mon += 7) {
      const days = workingDaysBetween(Math.max(it.start, mon), Math.min(it.end, mon + 6));
      if (days > 0) loads.set(mon, (loads.get(mon) ?? 0) + (it.estimateMd * days) / n);
    }
  }
  return loads;
}

/** Milestones in progress per working day (the effective span covers the day), keyed by day offset. */
export function dailyWip(items) {
  const wip = new Map();
  for (const it of items) {
    const first = nextWorkingOnOrAfter(it.start);
    const last = prevWorkingOnOrBefore(it.end);
    for (let d = first; d <= last; d++) if (isWorking(d)) wip.set(d, (wip.get(d) ?? 0) + 1);
  }
  return wip;
}

/** One row per ISO week from the earliest start's Monday to the latest end's: {monday, load, capacity, overloaded, maxWip, wipExceeded}. */
export function weeklyRows(items, periods) {
  if (items.length === 0) return [];
  const loads = weeklyLoads(items);
  const wip = dailyWip(items);
  const first = mondayOf(Math.min(...items.map((i) => i.start)));
  const last = mondayOf(Math.max(...items.map((i) => i.end)));
  const rows = [];
  for (let monday = first; monday <= last; monday += 7) {
    let maxWip = 0;
    let wipExceeded = false;
    for (let i = 0; i < 5; i++) {
      const count = wip.get(monday + i) ?? 0;
      maxWip = Math.max(maxWip, count);
      const limit = periodOn(monday + i, periods)?.wipLimit ?? null;
      if (limit !== null && count > limit) wipExceeded = true;
    }
    const load = round2(loads.get(monday) ?? 0);
    const capacity = weekCapacity(monday, periods);
    rows.push({ monday, load, capacity, overloaded: capacity !== null && load > capacity, maxWip, wipExceeded });
  }
  return rows;
}

/** The q-quantile (0..1) of a non-empty list of numbers, by the nearest rank. */
export function quantile(values, q) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1))];
}

/** Rates over the LOADED weeks (load > 0) of every team: {weeks, overloaded, wipExceeded}. */
export function overallRates(perTeamRows) {
  let weeks = 0;
  let overloaded = 0;
  let wipExceeded = 0;
  for (const rows of perTeamRows) {
    for (const r of rows) {
      if (r.load <= 0) continue;
      weeks++;
      if (r.overloaded) overloaded++;
      if (r.wipExceeded) wipExceeded++;
    }
  }
  return { weeks, overloaded, wipExceeded };
}

/**
 * The working days by which the successor span falls short of a link (`DependencyKernels.check`): positive = violated, 0 or less = ok;
 * 0 for an unscheduled end. Spans are {start, end} offsets; FS/SS/FF as in the server's table (SF is not generated).
 */
export function linkShortfall(type, lagDays, predecessor, successor) {
  if (!predecessor || !successor) return 0;
  const effStart = (s) => nextWorkingOnOrAfter(s.start);
  const effEnd = (s) => prevWorkingOnOrBefore(s.end);
  if (type === "FS") return workIndex(effEnd(predecessor)) + 1 + lagDays - workIndex(effStart(successor));
  if (type === "SS") return workIndex(effStart(predecessor)) + lagDays - workIndex(effStart(successor));
  if (type === "FF") return workIndex(effEnd(predecessor)) + lagDays - workIndex(effEnd(successor));
  throw new Error(`unsupported link type ${type}`);
}
