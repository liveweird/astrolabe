import type { KeyboardCoordinateGetter, Modifier } from "@dnd-kit/core";
import { toEpochDay, toIsoDate } from "./timelineScale";

/**
 * The Timeline's drag arithmetic, pure: what a drop MEANS in dates (`dropOutcome`), the dnd-kit keyboard coordinate getter
 * (one day per arrow, a week with Shift) and the two modifiers that keep a bar on its row and on whole days. Dates are ISO
 * `YYYY-MM-DD` strings; no `@dnd-kit/modifiers` dependency (three lines each).
 */

export type DragKind = "move" | "resize-start" | "resize-end" | "tray";

export interface Span {
  start: string;
  end: string;
}

/** A milestone scheduled from the tray (or its Schedule button) gets one calendar week: start + 6 days. */
const TRAY_SPAN_DAYS = 6;

/** Keyboard step: one day per arrow, seven with Shift. */
const KEYBOARD_WEEK_DAYS = 7;

/**
 * The dates a drop produces. `deltaDays` is the whole-day displacement of the dragged bar (or edge); `dayAtPointer` is the
 * epoch day under the pointer, used only by the tray kind (a tray item has no dates of its own). A resize never crosses the
 * opposite edge (a one-day bar is the minimum); a tray drop without a day answers `null`.
 */
export function dropOutcome(kind: DragKind, bar: Span | null, deltaDays: number, dayAtPointer: number | null): Span | null {
  if (kind === "tray") {
    if (dayAtPointer === null) return null;
    return { start: toIsoDate(dayAtPointer), end: toIsoDate(dayAtPointer + TRAY_SPAN_DAYS) };
  }
  if (bar === null) return null;
  const start = toEpochDay(bar.start);
  const end = toEpochDay(bar.end);
  switch (kind) {
    case "move":
      return { start: toIsoDate(start + deltaDays), end: toIsoDate(end + deltaDays) };
    case "resize-start":
      return { start: toIsoDate(Math.min(start + deltaDays, end)), end: bar.end };
    case "resize-end":
      return { start: bar.start, end: toIsoDate(Math.max(end + deltaDays, start)) };
  }
}

/** The whole-day displacement a gesture may reach: a resize never crosses the opposite edge (a one-day bar is the minimum). */
function clampDays(kind: DragKind, span: Span | null, days: number): number {
  if (span === null) return days;
  const length = toEpochDay(span.end) - toEpochDay(span.start);
  if (kind === "resize-start") return Math.min(days, length);
  if (kind === "resize-end") return Math.max(days, -length);
  return days;
}

export const sameSpan = (a: Span, b: Span) => a.start === b.start && a.end === b.end;

/**
 * dnd-kit's `coordinateGetter` for the KeyboardSensor: ←/→ move the held bar one day (Shift: seven), the other keys do nothing
 * while a bar is held (↑/↓ are swallowed so the page does not scroll under a held bar). dnd-kit reads `event.code`.
 */
export function keyboardCoordinates(dayWidth: number): KeyboardCoordinateGetter {
  /** One step from where the held bar is now, stepped from the CLAMPED displacement so ← after an overshoot is not silent. */
  const stepped = (event: KeyboardEvent, current: { x: number; y: number }, context: Parameters<KeyboardCoordinateGetter>[1]["context"] | undefined, sign: 1 | -1) => {
    const days = (event.shiftKey ? KEYBOARD_WEEK_DAYS : 1) * sign;
    const origin = context?.draggingNodeRect?.left;
    const data = context?.active?.data.current as { kind?: DragKind; start?: string; end?: string } | undefined;
    if (origin === undefined || data?.kind === undefined) return { x: current.x + days * dayWidth, y: current.y };
    const span = data.start !== undefined && data.end !== undefined ? { start: data.start, end: data.end } : null;
    const here = clampDays(data.kind, span, Math.round((current.x - origin) / dayWidth));
    const displacement = clampDays(data.kind, span, here + days);
    return { x: origin + displacement * dayWidth, y: current.y };
  };
  return (event, { currentCoordinates, context }) => {
    switch (event.code) {
      case "ArrowRight":
        event.preventDefault();
        return stepped(event, currentCoordinates, context, 1);
      case "ArrowLeft":
        event.preventDefault();
        return stepped(event, currentCoordinates, context, -1);
      case "ArrowUp":
      case "ArrowDown":
        event.preventDefault();
        return undefined;
      default:
        return undefined;
    }
  };
}

/** A bar only moves along the time axis. */
export const horizontalOnly: Modifier = ({ transform }) => ({ ...transform, y: 0 });

/** A bar moves in whole days. */
export const snapToDays =
  (dayWidth: number): Modifier =>
  ({ transform }) => ({ ...transform, x: Math.round(transform.x / dayWidth) * dayWidth });
