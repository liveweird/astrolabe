import { pointerWithin, type Active, type CollisionDetection, type DragMoveEvent } from "@dnd-kit/core";
import {
  dragDataOf,
  TIMELINE_DROP_ID,
  TIMELINE_ROW_DROP_ID,
  type DragData,
  type DropZoneData,
  type RowDropZoneData,
} from "../hooks/useTimelinePreview";
import { drawOutcome, dropOutcome, rowPositionAfter, rowSlotWithin, type Span } from "./timelineDrag";
import type { TimelineScale } from "./timelineScale";

/*
 * What `components/TimelineDndContext.tsx` reads off a running drag: the live pointer, the day or slot under it, the collision rule and the
 * autoscroll zones. Pure functions of dnd-kit's event data and the zones' live readers (no React), so the context keeps only its state and handlers.
 */

/** Where the pointer was when the drag began: only a mouse/touch/pen activator has coordinates (a keyboard one does not). */
export function pointerStart(activatorEvent: Event | null): Point | null {
  if (activatorEvent === null || !("clientX" in activatorEvent)) return null;
  const { clientX, clientY } = activatorEvent as MouseEvent;
  return { x: clientX, y: clientY ?? 0 };
}

export interface Point {
  x: number;
  y: number;
}

/**
 * dnd-kit's default autoscroll zone is 20 % of the scroller on BOTH axes, which a bar near the right edge of the grid sits inside: a one-day
 * resize there scrolled the grid by days while the pointer moved 28 px (found by the e2e). The timeline only ever scrolls along time, and only
 * when the held bar really reaches the edge: a narrow horizontal zone and a hairline vertical one (never zero: dnd-kit divides by the threshold).
 */
export const BAR_AUTO_SCROLL = { threshold: { x: 0.05, y: 0.02 } };
/**
 * A tray item travels from the tray, which sits below the grid, up to it: the page (and a tall grid) may need to scroll vertically for the
 * drop to be reachable, so a tray drag gets a real vertical zone (the context swaps configs at drag start; the zone is measured on the
 * scrollers of what the item is over, so over the grid it also scrolls the grid's rows) and the same narrow horizontal one.
 */
export const TRAY_AUTO_SCROLL = { threshold: { x: 0.05, y: 0.15 } };
/**
 * A held ROW travels along the rows: a real vertical zone (holding it near the top or bottom 15 % of the grid scrolls it, rows mount as they
 * come into the window, and the slot follows the pointer against the zone's live top) and a hairline horizontal one (never zero: dnd-kit
 * divides by the threshold).
 */
export const ROW_AUTO_SCROLL = { threshold: { x: 0.02, y: 0.15 } };

/** The dragged item's data: the active draggable's own, else what was held when the drag began (see `held` below). */
export const resolveDrag = (active: Pick<Active, "data"> | null, held: { current: DragData | null }): DragData | null => dragDataOf(active) ?? held.current;

/** What the row zone says about where a held row would land: the slot under the live pointer, or `null` where nothing lands. */
export function rowSlotOf(over: DragMoveEvent["over"], pointer: Point | null): number | null {
  const zone = over?.id === TIMELINE_ROW_DROP_ID ? (over.data?.current as Partial<RowDropZoneData> | undefined) : undefined;
  return rowSlotWithin(pointer, zone?.zoneTop?.() ?? null, zone?.rowBounds?.() ?? null, zone?.rowCount);
}

/**
 * The row zone sits over the whole body, so it would also be a collision for a tray drag. A row drag collides ONLY with it — and always: where
 * the pointer really is (inside the scroller, over the sticky header, outside the grid) is `rowSlotWithin`'s question, answered from the live
 * pointer, because dnd-kit's snapshot of the zone's rectangle does not reach over the header at a scroll offset of 0. Every other kind never
 * collides with it (bars and the tray see exactly the droppables they saw before the row drag existed).
 */
export const collisionFor = (isRow: boolean): CollisionDetection => (args) => {
  if (!isRow) return pointerWithin({ ...args, droppableContainers: args.droppableContainers.filter((container) => container.id !== TIMELINE_ROW_DROP_ID) });
  const zone = args.droppableContainers.find((container) => container.id === TIMELINE_ROW_DROP_ID);
  return zone === undefined ? [] : [{ id: zone.id, data: { droppableContainer: zone, value: 0 } }];
};

/**
 * The span a DRAW has dragged out: from the anchor day (the day under the pointer-down, fixed at pick-up) to the day under the live pointer,
 * in either direction (`drawOutcome`). The day comes from the track zone's live left edge, like a tray item's; while the pointer is not over the
 * zone (the tray, the page around the grid) the last span is kept, and the pointer's day is clamped to the scale's range — the drop there still proposes what was drawn.
 */
export function drawSpanOf(over: DragMoveEvent["over"], scale: TimelineScale, pointer: Point | null, anchor: number | null, last: Span | null): Span | null {
  if (anchor === null) return last;
  const zone = over?.id === TIMELINE_DROP_ID ? (over.data?.current as Partial<DropZoneData> | undefined) : undefined;
  const left = zone?.zoneLeft?.();
  if (pointer === null || left === undefined || left === null) return last;
  // Clamped to the range: dnd-kit's zone rect is a snapshot, so after an autoscroll the pointer can sit over the sticky columns (a negative x - left).
  return drawOutcome(anchor, Math.min(Math.max(scale.dayAt(pointer.x - left), scale.from), scale.to));
}

/** The facts an announcement states about a row: its name, the position it would take with `slot` (its own without one) and the row count. */
export const rowFacts = (drag: DragData, slot: number | null) => ({
  name: drag.label,
  count: drag.count,
  position: slot === null || drag.position === undefined ? drag.position : rowPositionAfter(drag.position - 1, slot),
});

export const spanOf = (drag: DragData): Span | null => (drag.start !== undefined && drag.end !== undefined ? { start: drag.start, end: drag.end } : null);

/**
 * The dates a drag would produce right now. A bar gesture is its whole-day displacement. A tray item takes the day under the POINTER, but
 * only while it is over the track drop zone AND inside the part of it that is actually visible (the zone is as tall and wide as every row;
 * the drop must not count over the tray below, the footer or the sticky left columns). The pointer is the live one (tracked from the
 * activator on), and the zone's left edge and visible bounds are read from the DOM at that same instant: dnd-kit's own `delta` is
 * scroll-adjusted by the scroll offsets of the OVER node's scrollers once `over` is the zone, which adds the grid's whole `scrollLeft`
 * to a tray item that never lived in it (a drop landed thousands of pixels away — found by the e2e), and `over.rect` is a snapshot from
 * the drag's start that a scroll makes stale.
 */
export function outcomeOf(drag: DragData, event: Pick<DragMoveEvent, "delta" | "over">, scale: TimelineScale, pointer: Point | null): Span | null {
  if (drag.kind === "tray") {
    const zone = event.over?.id === TIMELINE_DROP_ID ? (event.over.data?.current as Partial<DropZoneData> | undefined) : undefined;
    const left = zone?.zoneLeft?.();
    if (pointer === null || left === undefined || left === null) return null;
    const bounds = zone?.visibleBounds?.();
    if (bounds === null || bounds === undefined) return null;
    if (pointer.x < bounds.left || pointer.x >= bounds.right || pointer.y < bounds.top || pointer.y >= bounds.bottom) return null;
    return dropOutcome("tray", null, 0, scale.dayAt(pointer.x - left));
  }
  return dropOutcome(drag.kind, spanOf(drag), Math.round(event.delta.x / scale.dayWidth), null);
}
