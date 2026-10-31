import { createContext, useContext } from "react";
import type { Active } from "@dnd-kit/core";
import type { DragKind } from "../utils/timelineDrag";
import type { BarId } from "../utils/timelineModel";

/** The id of the droppable covering the whole track area: a tray item dropped on it is scheduled at the pointer's day. */
export const TIMELINE_DROP_ID = "timeline-track";

/** The viewport rectangle (client coordinates) in which a tray drop counts: the scroller's visible track, right of the sticky columns and below the header. */
interface DropBounds {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

/** What the track drop zone puts in its droppable `data`: the zone itself is as tall as every row, so the live visible part is asked for. */
export interface DropZoneData {
  visibleBounds: () => DropBounds | null;
}

/** What every Timeline draggable carries in dnd-kit's `data`: which gesture it starts, on which bar, and that bar's dates now. */
export interface DragData {
  kind: DragKind;
  barId: BarId;
  label: string;
  start?: string;
  end?: string;
}

/** The dates a held bar or edge would take if dropped now (while a drag is running), so the bar can draw them. */
export interface TimelinePreview {
  barId: BarId;
  kind: DragKind;
  start: string;
  end: string;
}

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
