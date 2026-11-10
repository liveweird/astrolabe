import type { TFunction } from "i18next";
import type { BaselineFigures, BaselineMilestone, Movement, MovementTotals, RemovedMilestone, SpanBaseline } from "../api/baselines";
import type { RemovedProject } from "../api/roadmap";
import type { TimelineBarData } from "./timelineModel";

/**
 * The words for what became of one row since a baseline (v0.9.0). Pure: the SERVER decides every figure (`Movement`: the kind and the signed
 * WORKING days on the current calendar, positive = later); this only phrases them. The comparison page and the timelines' Movement section
 * share it.
 */
export function movementSentence(movement: Movement, t: TFunction): string {
  switch (movement.kind) {
    case "ADDED":
      return t("baselines.movement.added");
    case "REMOVED":
      return t("baselines.movement.removed");
    case "SCHEDULED":
      return t("baselines.movement.scheduled");
    case "UNSCHEDULED":
      return t("baselines.movement.unscheduled");
    case "UNCHANGED":
      return t(movement.estimateDelta !== null && movement.estimateDelta !== 0 ? "baselines.movement.estimateOnly" : "baselines.movement.unchanged");
    case "MOVED":
      return movedSentence(movement.startDays ?? 0, movement.endDays ?? 0, t);
  }
}

function movedSentence(start: number, end: number, t: TFunction): string {
  // Both ends moved by the same amount: say it once.
  if (start === end && start !== 0) {
    return t(start > 0 ? "baselines.movement.bothLater" : "baselines.movement.bothEarlier", { count: Math.abs(start) });
  }
  const startPart =
    start === 0 ? t("baselines.movement.startUnchanged") : t(start > 0 ? "baselines.movement.startLater" : "baselines.movement.startEarlier", { count: Math.abs(start) });
  const endPart =
    end === 0 ? t("baselines.movement.endUnchanged") : t(end > 0 ? "baselines.movement.endLater" : "baselines.movement.endEarlier", { count: Math.abs(end) });
  return t("baselines.movement.startEnd", { start: startPart, end: endPart });
}

/** The status badge of one row: `later` is the ORANGE "Later" (a MOVED row whose END is later — the user's rule), everything else is gray. */
export function movementStatus(movement: Movement): { key: "later" | "earlier" | "moved" | "added" | "removed" | "scheduled" | "unscheduled" | "estimate" | "unchanged"; late: boolean } {
  switch (movement.kind) {
    case "MOVED": {
      const end = movement.endDays ?? 0;
      return { key: end > 0 ? "later" : end < 0 ? "earlier" : "moved", late: end > 0 };
    }
    case "ADDED":
      return { key: "added", late: false };
    case "REMOVED":
      return { key: "removed", late: false };
    case "SCHEDULED":
      return { key: "scheduled", late: false };
    case "UNSCHEDULED":
      return { key: "unscheduled", late: false };
    case "UNCHANGED":
      return { key: movement.estimateDelta !== null && movement.estimateDelta !== 0 ? "estimate" : "unchanged", late: false };
  }
}

/** One non-zero figure of a totals line; `late` marks the one ORANGE figure (rows whose end is later). */
export type TotalsPart = { key: string; label: string; late: boolean };

/**
 * The non-zero figures of a {@link MovementTotals}, in reading order: end later (orange), end earlier, moved with the end unchanged, new,
 * removed, newly scheduled, unscheduled. `later`/`earlier` are subsets of `moved`, so the rest of `moved` is what remains. Unchanged rows are
 * not a change and are left out.
 */
export function movementTotalsParts(totals: MovementTotals, t: TFunction): TotalsPart[] {
  const figures: { key: string; count: number; label: `baselines.totals.${"later" | "earlier" | "movedOther" | "added" | "removed" | "scheduled" | "unscheduled"}`; late: boolean }[] = [
    { key: "later", count: totals.later, label: "baselines.totals.later", late: true },
    { key: "earlier", count: totals.earlier, label: "baselines.totals.earlier", late: false },
    { key: "movedOther", count: totals.moved - totals.later - totals.earlier, label: "baselines.totals.movedOther", late: false },
    { key: "added", count: totals.added, label: "baselines.totals.added", late: false },
    { key: "removed", count: totals.removed, label: "baselines.totals.removed", late: false },
    { key: "scheduled", count: totals.scheduled, label: "baselines.totals.scheduled", late: false },
    { key: "unscheduled", count: totals.unscheduled, label: "baselines.totals.unscheduled", late: false },
  ];
  return figures.filter((figure) => figure.count > 0).map((figure) => ({ key: figure.key, label: t(figure.label, { count: figure.count }), late: figure.late }));
}

/** The totals as one sentence: "14 end later, 3 end earlier, 2 new, 1 removed", or "No schedule changes". */
export function movementTotalsSentence(totals: MovementTotals, t: TFunction): string {
  const parts = movementTotalsParts(totals, t);
  return parts.length === 0 ? t("baselines.totals.none") : parts.map((part) => part.label).join(", ");
}

/** A figure in the working days of a Start/End column: "+5", "−2", "0"; "—" for a row not dated on both sides. */
export function signedDays(days: number | null): string {
  if (days === null) return "—";
  if (days === 0) return "0";
  return days > 0 ? `+${days}` : `−${Math.abs(days)}`;
}

// ---- the timelines' overlay (v0.9 C9): shadow bars, appended rows, the Movement rows, the plan pages' totals. Pure; the SERVER decides every figure. ----

/** What the project view's and the team view's `baseline` blocks share. `project` is the project view's own span movement. */
export type MilestoneBaseline = {
  name: string;
  milestones: readonly BaselineMilestone[];
  removed: readonly RemovedMilestone[];
  project?: SpanBaseline | null;
};

/** The part of a live milestone (either view's row) the overlay reads. */
export type LiveMilestone = { id: number; name: string; projectId: number; projectName?: string; teamName: string; estimateMd: number; startDate: string | null; endDate: string | null };

/** The id of a shadow bar: `baseline:<id>` (a milestone's, a project's, a program's or a work stream's key), apart from every current bar. */
const baselineBarId = (key: number | string) => `baseline:${key}`;
/** The id of a row the overlay appends (a removed, unscheduled or moved-away milestone). */
const baselineRowId = (milestoneId: number) => `baseline-removed:${milestoneId}`;

/** The accessible name of a shadow bar: the dates then, and what became of the row when it did. */
function shadowDescribe(name: string, start: string, end: string, movement: Movement | null, t: TFunction): string {
  const dates = t("timeline.bar.baseline", { name, start, end });
  return movement === null || movementStatus(movement).key === "unchanged" ? dates : `${dates}, ${movementSentence(movement, t)}`;
}

/** A shadow bar: read-only, the `baseline` tone (a thin bar under the row's current one). */
export function shadowBar(key: number | string, name: string, span: { start: string; end: string }, movement: Movement | null, t: TFunction): TimelineBarData {
  return { id: baselineBarId(key), start: span.start, end: span.end, label: name, describe: shadowDescribe(name, span.start, span.end, movement, t), editable: false, tone: "baseline" };
}

/** The shadow bars of the live milestones that were scheduled in the baseline, by milestone id (a milestone without frozen dates has none). */
export function baselineBars(baseline: Pick<MilestoneBaseline, "milestones">, live: readonly { id: number; name: string }[], t: TFunction): Map<number, TimelineBarData> {
  const names = new Map(live.map((milestone) => [milestone.id, milestone.name]));
  const bars = new Map<number, TimelineBarData>();
  for (const entry of baseline.milestones) {
    const name = names.get(entry.milestoneId);
    if (name !== undefined && entry.start !== null && entry.end !== null) bars.set(entry.milestoneId, shadowBar(entry.milestoneId, name, { start: entry.start, end: entry.end }, entry.movement, t));
  }
  return bars;
}

/** A bar as a list of zero or one (to spread into a row's `bars`). */
export const barList = (bar: TimelineBarData | undefined): TimelineBarData[] => (bar === undefined ? [] : [bar]);

/** The live milestones the baseline did not freeze: new since it. */
export function newSince(baseline: Pick<MilestoneBaseline, "milestones">, live: readonly { id: number }[]): Set<number> {
  const frozen = new Set(baseline.milestones.map((entry) => entry.milestoneId));
  return new Set(live.filter((milestone) => !frozen.has(milestone.id)).map((milestone) => milestone.id));
}

/** A row the overlay appends after the current rows: only the shadow bar, dimmed; `reason` picks the suffix after its name. */
export type BaselineRow = {
  id: string;
  milestoneId: number;
  name: string;
  projectId: number;
  /** Known for a milestone that still exists (the team view's project column); a removed one carries only its project's id. */
  projectName: string | null;
  teamName: string;
  estimateMd: number;
  reason: "removed" | "unscheduled" | "moved";
  /** The team a moved-away milestone is on now (`reason` "moved"). */
  movedTo: string | null;
  bar: TimelineBarData;
};

/**
 * The rows appended after the current ones (Q7a): the baseline's milestones that are gone from this view (deleted - `removed`; on another team
 * since - `moved`) and the live tray milestones the baseline had scheduled (`unscheduled`), each with its frozen span as a shadow bar, in
 * (start, end, name) order. A milestone the baseline froze without dates has no span to draw and gets no row (the Movement table lists it).
 */
export function removedRows(baseline: Pick<MilestoneBaseline, "milestones" | "removed">, unscheduled: readonly LiveMilestone[], t: TFunction): BaselineRow[] {
  const rows: BaselineRow[] = [];
  const bar = (milestoneId: number, name: string, start: string, end: string, movement: Movement | null) => shadowBar(milestoneId, name, { start, end }, movement, t);
  for (const gone of baseline.removed) {
    if (gone.start === null || gone.end === null) continue;
    const movedTo = gone.now?.teamName ?? null;
    rows.push({
      id: baselineRowId(gone.milestoneId),
      milestoneId: gone.milestoneId,
      name: gone.name,
      projectId: gone.projectId,
      projectName: null,
      teamName: gone.teamName,
      estimateMd: gone.estimateMd,
      reason: movedTo === null ? "removed" : "moved",
      movedTo,
      bar: bar(gone.milestoneId, gone.name, gone.start, gone.end, null),
    });
  }
  const frozen = new Map(baseline.milestones.map((entry) => [entry.milestoneId, entry]));
  for (const milestone of unscheduled) {
    const entry = frozen.get(milestone.id);
    if (entry === undefined || entry.start === null || entry.end === null) continue;
    rows.push({
      id: baselineRowId(milestone.id),
      milestoneId: milestone.id,
      name: milestone.name,
      projectId: milestone.projectId,
      projectName: milestone.projectName ?? null,
      teamName: milestone.teamName,
      estimateMd: milestone.estimateMd,
      reason: "unscheduled",
      movedTo: null,
      bar: bar(milestone.id, milestone.name, entry.start, entry.end, entry.movement),
    });
  }
  const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
  return rows.sort((a, b) => compare(a.bar.start, b.bar.start) || compare(a.bar.end, b.bar.end) || a.name.toLowerCase().localeCompare(b.name.toLowerCase()) || a.milestoneId - b.milestoneId);
}

/** A row the roadmap and programs pages append for a project the baseline froze that is deleted now: only its frozen span as a shadow bar, dimmed. */
export type RemovedProjectRow = { id: string; projectId: number; name: string; programId: number; programName: string; workStreamId: number; workStreamName: string; bar: TimelineBarData };

/**
 * The appended project rows (1.10): the baseline's deleted projects that HAD a span, each as its shadow bar `baseline:<projectId>`, in (start, end,
 * name, id) order; one without a span has nothing to draw and gets no row (the comparison page lists it), like a frozen milestone without dates.
 */
export function removedProjectRows(removed: readonly RemovedProject[], t: TFunction): RemovedProjectRow[] {
  const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
  return removed
    .flatMap(({ span, ...gone }) => (span === null ? [] : [{ id: `baseline-removed-project:${gone.projectId}`, ...gone, bar: shadowBar(gone.projectId, gone.name, span, null, t) }]))
    .sort((a, b) => compare(a.bar.start, b.bar.start) || compare(a.bar.end, b.bar.end) || a.name.toLowerCase().localeCompare(b.name.toLowerCase()) || a.projectId - b.projectId);
}

/** The frozen days of the removed projects' spans: the plan pages' grow-only range covers them, so no appended shadow bar sits outside it. */
export const removedProjectDays = (removed: readonly RemovedProject[] | undefined): string[] => (removed ?? []).flatMap((gone) => (gone.span === null ? [] : [gone.span.start, gone.span.end]));

/** The dimmed text after an appended row's name. */
export function rowSuffix(row: Pick<BaselineRow, "reason" | "movedTo">, t: TFunction): string {
  if (row.reason === "removed") return t("timeline.baseline.removedMark");
  return row.reason === "unscheduled" ? t("timeline.baseline.unscheduledMark") : t("timeline.baseline.movedMark", { team: row.movedTo ?? "" });
}

/** Every frozen day a view's overlay draws (the baseline's spans, the removed ones included): the page's grow-only range covers them, so no shadow bar sits outside it. */
export function baselineDays(baseline: Pick<MilestoneBaseline, "milestones" | "removed" | "project"> | undefined): string[] {
  if (baseline === undefined) return [];
  const days = [...baseline.milestones.flatMap((entry) => [entry.start, entry.end]), ...baseline.removed.flatMap((gone) => [gone.start, gone.end]), baseline.project?.span?.start, baseline.project?.span?.end];
  return days.filter((day): day is string => typeof day === "string");
}

/**
 * The project page's facts-line badges for the project's OWN span against the baseline (`baseline.project`; `null` = the project is newer than the
 * baseline): "Ends 3 working days later than the baseline" (ORANGE exactly when the END is later, the user's rule) and the start's figure (gray), or a
 * gray sentence for a span that was (un)scheduled since. Nothing when the span did not move.
 */
export function spanBadges(project: SpanBaseline | null, t: TFunction): { key: string; label: string; late: boolean }[] {
  if (project === null) return [{ key: "new", label: t("timeline.baseline.projectNew"), late: false }];
  const { movement } = project;
  if (movement.kind === "SCHEDULED" || movement.kind === "UNSCHEDULED") return [{ key: "sentence", label: t("timeline.baseline.projectSentence", { sentence: movementSentence(movement, t) }), late: false }];
  if (movement.kind !== "MOVED") return [];
  const end = movement.endDays ?? 0;
  const start = movement.startDays ?? 0;
  const badges: { key: string; label: string; late: boolean }[] = [];
  if (end !== 0) badges.push({ key: "end", label: t(end > 0 ? "timeline.baseline.endsLater" : "timeline.baseline.endsEarlier", { count: Math.abs(end) }), late: end > 0 });
  if (start !== 0) badges.push({ key: "start", label: t(start > 0 ? "timeline.baseline.startsLater" : "timeline.baseline.startsEarlier", { count: Math.abs(start) }), late: false });
  return badges;
}

/** One row of the Movement table: a live milestone with what the baseline had of it, or a baseline milestone that is gone from the view. */
export type MovementRow = {
  key: number;
  name: string;
  projectId: number;
  projectName: string | null;
  frozen: BaselineFigures | null;
  live: BaselineFigures | null;
  movement: Movement;
  /** The status badge; a milestone that moved to another team is a gray "Moved", not a "Removed". */
  status: ReturnType<typeof movementStatus>;
  movedTo: string | null;
};

const ABSENT = { startDays: null, endDays: null, estimateDelta: null } as const;

/**
 * The Movement table's rows: every live milestone of the view (scheduled, then the tray) with the baseline's entry for it - a milestone without
 * one is `ADDED` - then the baseline's milestones that are gone from the view (`REMOVED`; on the team view one that moved teams reads "Moved").
 */
export function movementRows(baseline: Pick<MilestoneBaseline, "milestones" | "removed">, live: readonly LiveMilestone[]): MovementRow[] {
  const frozen = new Map(baseline.milestones.map((entry) => [entry.milestoneId, entry]));
  const rows: MovementRow[] = live.map((milestone) => {
    const entry = frozen.get(milestone.id);
    const movement: Movement = entry?.movement ?? { kind: "ADDED", ...ABSENT };
    return {
      key: milestone.id,
      name: milestone.name,
      projectId: milestone.projectId,
      projectName: milestone.projectName ?? null,
      frozen: entry === undefined ? null : { start: entry.start, end: entry.end, estimateMd: entry.estimateMd },
      live: { start: milestone.startDate, end: milestone.endDate, estimateMd: milestone.estimateMd },
      movement,
      status: movementStatus(movement),
      movedTo: null,
    };
  });
  for (const gone of baseline.removed) {
    const movement: Movement = { kind: "REMOVED", ...ABSENT };
    const movedTo = gone.now?.teamName ?? null;
    rows.push({
      key: gone.milestoneId,
      name: gone.name,
      projectId: gone.projectId,
      projectName: null,
      frozen: { start: gone.start, end: gone.end, estimateMd: gone.estimateMd },
      live: null,
      movement,
      status: movedTo === null ? movementStatus(movement) : { key: "moved", late: false },
      movedTo,
    });
  }
  return rows;
}

/** Did the row change? An estimate-only change IS a change (its status key is "estimate"); only "unchanged" is not. */
export const rowChanged = (row: Pick<MovementRow, "status">) => row.status.key !== "unchanged";

/** The counts of rows by movement kind, for a view that does not carry them (the project and team pages): `later`/`earlier` are the `moved` rows whose END is later/earlier. */
export function movementTotalsOf(movements: readonly Movement[]): MovementTotals {
  const totals = { unchanged: 0, moved: 0, later: 0, earlier: 0, scheduled: 0, unscheduled: 0, added: 0, removed: 0 };
  for (const movement of movements) {
    switch (movement.kind) {
      case "UNCHANGED":
        totals.unchanged += 1;
        break;
      case "MOVED":
        totals.moved += 1;
        if ((movement.endDays ?? 0) > 0) totals.later += 1;
        if ((movement.endDays ?? 0) < 0) totals.earlier += 1;
        break;
      case "SCHEDULED":
        totals.scheduled += 1;
        break;
      case "UNSCHEDULED":
        totals.unscheduled += 1;
        break;
      case "ADDED":
        totals.added += 1;
        break;
      case "REMOVED":
        totals.removed += 1;
        break;
    }
  }
  return totals;
}

/**
 * The plan pages' totals over their projects: a project row without a `baseline` block is new since the baseline, one with it counts by its span's
 * movement, and `removed` is the number of the baseline's projects that are gone (both plan views list them since 1.10 and pass the count).
 */
export function projectTotals(projects: readonly { baseline?: { movement: Movement } }[], removed: number): MovementTotals {
  const added: Movement = { kind: "ADDED", ...ABSENT };
  const totals = movementTotalsOf(projects.map((project) => project.baseline?.movement ?? added));
  return { ...totals, removed: totals.removed + removed };
}

/** How the ranks of the plan pages' projects moved since a baseline (v0.9 Q8): `up`/`down` = ranked on both sides at a better/worse position; `ranked` = unranked then, ranked now; `unranked` = the reverse. */
export type RankTotals = { up: number; down: number; ranked: number; unranked: number };

/**
 * The rank movement over the roadmap's projects, from the frozen `rankPosition` already on the wire (smaller = better): a project without a
 * `baseline` block is new since the baseline and has no movement to count, one whose rank did not change adds nothing.
 */
export function rankTotals(projects: readonly { rankPosition: number | null; baseline?: { rankPosition: number | null } }[]): RankTotals {
  const totals: RankTotals = { up: 0, down: 0, ranked: 0, unranked: 0 };
  for (const { rankPosition: now, baseline } of projects) {
    if (baseline === undefined || baseline.rankPosition === now) continue;
    const then = baseline.rankPosition;
    if (then === null) totals.ranked += 1;
    else if (now === null) totals.unranked += 1;
    else if (now < then) totals.up += 1;
    else totals.down += 1;
  }
  return totals;
}

/** The non-zero figures of {@link rankTotals} as labels, in reading order ("2 moved up in rank", "1 moved down in rank", …). */
export function rankTotalsParts(totals: RankTotals, t: TFunction): { key: string; label: string }[] {
  const figures = [
    { key: "up", count: totals.up, label: "baselines.totals.rankUp" },
    { key: "down", count: totals.down, label: "baselines.totals.rankDown" },
    { key: "ranked", count: totals.ranked, label: "baselines.totals.rankAdded" },
    { key: "unranked", count: totals.unranked, label: "baselines.totals.rankRemoved" },
  ] as const;
  return figures.filter((figure) => figure.count > 0).map((figure) => ({ key: figure.key, label: t(figure.label, { count: figure.count }) }));
}
