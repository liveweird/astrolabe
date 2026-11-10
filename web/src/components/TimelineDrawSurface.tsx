import { useRef, type PointerEventHandler } from "react";
import { useDraggable } from "@dnd-kit/core";
import { useTimelinePreview, type DragData } from "../hooks/useTimelinePreview";
import type { TimelineDrawData } from "../utils/timelineModel";
import { toEpochDay, type TimelineScale } from "../utils/timelineScale";
import classes from "../theme.module.css";

/**
 * The draw gesture's surface: an invisible layer behind a row's bands and bars (so a bar always wins the pointer where it sits) on which a
 * pointer drag across the EMPTY stretch of the row proposes a span, previewed here as a window-toned ghost. A POINTER affordance only, the
 * `TimelineRowHandle` rule: only the pointer activator is attached (never the keyboard sensor's `onKeyDown`, no `attributes`), it is `aria-hidden`
 * and not focusable (the page's dialog is the keyboard and screen-reader path), and `touch-action: pan-x pan-y pinch-zoom` lets a finger scroll the grid
 * instead of drawing. The span is computed by the page's `TimelineDndContext`, which proposes it through `onSchedule(draw.barId, start, end)`.
 */
export default function TimelineDrawSurface({ draw, scale }: { draw: TimelineDrawData; scale: TimelineScale }) {
  const preview = useTimelinePreview();
  const node = useRef<HTMLDivElement | null>(null);
  const data: DragData = { kind: "draw", barId: draw.barId, label: draw.label, trackLeft: () => node.current?.getBoundingClientRect().left ?? null };
  const { setNodeRef, listeners } = useDraggable({ id: `draw:${draw.barId}`, data });
  const pointer = { onPointerDown: listeners?.onPointerDown as PointerEventHandler<HTMLDivElement> | undefined };
  const drawn = preview?.kind === "draw" && preview.barId === draw.barId ? preview : null;
  const start = drawn === null ? 0 : toEpochDay(drawn.start);
  return (
    <div
      ref={(element) => {
        node.current = element;
        setNodeRef(element);
      }}
      aria-hidden="true"
      data-draw-surface=""
      className={classes.timelineDrawSurface}
      {...pointer}
    >
      {drawn !== null && (
        <div
          data-draw-preview=""
          className={classes.timelineDrawGhost}
          style={{ left: scale.xOf(start), width: scale.widthOf(start, toEpochDay(drawn.end)) }}
        />
      )}
    </div>
  );
}
