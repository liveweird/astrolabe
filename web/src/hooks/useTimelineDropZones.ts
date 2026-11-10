import { useRef, type RefObject } from "react";
import { useDroppable } from "@dnd-kit/core";
import { TIMELINE_DROP_ID, TIMELINE_ROW_DROP_ID, type DropZoneData, type RowDropZoneData } from "./useTimelinePreview";

/**
 * The Timeline's two invisible drop zones over its body; the frame spreads the returned callback refs onto the two `aria-hidden` divs.
 * The track zone is as large as every row; a tray drop only counts inside what the scroller actually shows of it. The row zone spans the
 * WHOLE body (left cells too): a held ROW lands in the slot under the pointer (the context excludes it for every other kind). The readers
 * of both are live: the grid scrolls under a held item, so a zone's top and the scroller's bounds are read at the event, never snapshotted.
 * `head` is the sticky header's height and `leftWidth` the sticky columns' width, both measured by the frame.
 */
export function useTimelineDropZones({
  scrollRef,
  head,
  leftWidth,
  rowCount,
}: {
  scrollRef: RefObject<HTMLDivElement | null>;
  head: number;
  leftWidth: number;
  rowCount: number;
}): { zoneRef: (node: HTMLDivElement | null) => void; rowZoneRef: (node: HTMLDivElement | null) => void } {
  const zoneNode = useRef<HTMLDivElement | null>(null);
  const zoneData: DropZoneData = {
    visibleBounds: () => {
      const rect = scrollRef.current?.getBoundingClientRect();
      return rect === undefined ? null : { left: rect.left + leftWidth, right: rect.right, top: rect.top + head, bottom: rect.bottom };
    },
    zoneLeft: () => zoneNode.current?.getBoundingClientRect().left ?? null,
  };
  const { setNodeRef: dropRef } = useDroppable({ id: TIMELINE_DROP_ID, data: zoneData });
  const rowZoneNode = useRef<HTMLDivElement | null>(null);
  const rowZoneData: RowDropZoneData = {
    zoneTop: () => rowZoneNode.current?.getBoundingClientRect().top ?? null,
    rowBounds: () => {
      const rect = scrollRef.current?.getBoundingClientRect();
      return rect === undefined ? null : { left: rect.left, right: rect.right, top: rect.top + head, bottom: rect.bottom, scrollerTop: rect.top };
    },
    rowCount,
  };
  const { setNodeRef: rowDropRef } = useDroppable({ id: TIMELINE_ROW_DROP_ID, data: rowZoneData });
  return {
    zoneRef: (node) => {
      zoneNode.current = node;
      dropRef(node);
    },
    rowZoneRef: (node) => {
      rowZoneNode.current = node;
      rowDropRef(node);
    },
  };
}
