import { createContext, useContext } from "react";
import type { Active } from "@dnd-kit/core";
import type { DragKind } from "../utils/timelineDrag";
import type { BarId } from "../utils/timelineModel";

/** The id of the droppable covering the whole track area: a tray item dropped on it is scheduled at the pointer's day. */
export const TIMELINE_DROP_ID = "timeline-track";

/** The id of the droppable covering the whole body (left columns and track): a dragged ROW lands in the slot under the pointer. Inert for every other kind. */
export const TIMELINE_ROW_DROP_ID = "timeline-rows";

/** The viewport rectangle (client coordinates) in which a drop counts: for a tray item the scroller's visible track, right of the sticky columns and below the header; for a row the scroller from its left edge, rows from `top`. */
interface DropBounds {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

/** What the row drop zone puts in its droppable `data`: three live readers (the grid scrolls under a held row, so nothing may be a snapshot). */
export interface RowDropZoneData {
  /** The zone's top edge in client coordinates, read NOW (negative once the grid is scrolled). */
  zoneTop: () => number | null;
  /** The scroller in which a row drop counts: from its left edge; `top` is where its rows start (below the sticky header), `scrollerTop` its own top edge. */
  rowBounds: () => (DropBounds & { scrollerTop: number }) | null;
  /** How many rows the body holds, mounted or not. */
  rowCount: number;
}

/** What the track drop zone puts in its droppable `data`: the zone itself is as tall as every row, so the live visible part is asked for. */
export interface DropZoneData {
  visibleBounds: () => DropBounds | null;
  /** The zone's left edge in client coordinates, read NOW (dnd-kit's `over.rect` is a snapshot of the drag's start, stale after a scroll). */
  zoneLeft: () => number | null;
}

/** What every Timeline draggable carries in dnd-kit's `data`: which gesture it starts, on which bar, and that bar's dates now. */
export interface DragData {
  kind: DragKind;
  barId: BarId;
  label: string;
  start?: string;
  end?: string;
  /** A row handle's row: its 1-based place in the order and the row count (the announcements say them). */
  position?: number;
  count?: number;
  /**
   * A draw surface's live left edge in client coordinates (the track's left, read NOW). A drag has no `over` when it starts, and the anchor
   * day is the day under the pointer-down, so the context needs a reader of its own for that one conversion.
   */
  trackLeft?: () => number | null;
}

/** The dates a held bar or edge would take if dropped now (while a drag is running), so the bar can draw them. */
interface BarPreview {
  barId: BarId;
  kind: Exclude<DragKind, "row" | "draw">;
  start: string;
  end: string;
}

/** The span a draw gesture has dragged out so far, for the row's draw surface to paint (`barId` is the bar the row would get). */
interface DrawPreview {
  barId: BarId;
  kind: "draw";
  start: string;
  end: string;
}

/** A held row: the slot it would land in now (`null` while the pointer is where nothing lands), and the label its overlay card shows. */
interface RowPreview {
  barId: BarId;
  kind: "row";
  label: string;
  slot: number | null;
}

export type TimelinePreview = BarPreview | RowPreview | DrawPreview;

export const PreviewContext = createContext<TimelinePreview | null>(null);

/** The running drag's preview, or `null` when nothing is held. */
export function useTimelinePreview(): TimelinePreview | null {
  return useContext(PreviewContext);
}

/** The `DragData` of a dnd-kit active draggable, if it is one of ours. */
export function dragDataOf(active: Pick<Active, "data"> | null): DragData | null {
  const data = active?.data.current as Partial<DragData> | undefined;
  return data?.kind !== undefined && data.barId !== undefined ? (data as DragData) : null;
}
