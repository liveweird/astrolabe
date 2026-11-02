import type { TFunction } from "i18next";
import type { Movement, MovementTotals } from "../api/baselines";

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
