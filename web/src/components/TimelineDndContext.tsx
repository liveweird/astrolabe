import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  pointerWithin,
  useSensor,
  useSensors,
  type Announcements,
  type DragEndEvent,
  type DragMoveEvent,
  type Modifier,
} from "@dnd-kit/core";
import { useTranslation } from "react-i18next";
import {
  dragDataOf,
  PreviewContext,
  TIMELINE_DROP_ID,
  type DragData,
  type DropZoneData,
  type TimelinePreview,
} from "../hooks/useTimelinePreview";
import { dropOutcome, horizontalOnly, keyboardCoordinates, sameSpan, snapToDays, type Span } from "../utils/timelineDrag";
import type { BarId } from "../utils/timelineModel";
import type { TimelineScale } from "../utils/timelineScale";

/** Where the pointer was when the drag began: only a mouse/touch/pen activator has coordinates (a keyboard one does not). */
function pointerStart(activatorEvent: Event | null): Point | null {
  if (activatorEvent === null || !("clientX" in activatorEvent)) return null;
  const { clientX, clientY } = activatorEvent as MouseEvent;
  return { x: clientX, y: clientY ?? 0 };
}

interface Point {
  x: number;
  y: number;
}

/**
 * dnd-kit's default autoscroll zone is 20 % of the scroller on BOTH axes, which a bar near the right edge of the grid sits inside: a one-day
 * resize there scrolled the grid by days while the pointer moved 28 px (found by the e2e). The timeline only ever scrolls along time, and only
 * when the held bar really reaches the edge: a narrow horizontal zone and a hairline vertical one (never zero: dnd-kit divides by the threshold).
 */
const BAR_AUTO_SCROLL = { threshold: { x: 0.05, y: 0.02 } };
/**
 * A tray item travels from the tray, which sits below the grid, up to it: the page (and a tall grid) may need to scroll vertically for the
 * drop to be reachable, so a tray drag gets a real vertical zone (the context swaps configs at drag start; the zone is measured on the
 * scrollers of what the item is over, so over the grid it also scrolls the grid's rows) and the same narrow horizontal one.
 */
const TRAY_AUTO_SCROLL = { threshold: { x: 0.05, y: 0.15 } };

const spanOf = (drag: DragData): Span | null => (drag.start !== undefined && drag.end !== undefined ? { start: drag.start, end: drag.end } : null);

/**
 * The dates a drag would produce right now. A bar gesture is its whole-day displacement. A tray item takes the day under the POINTER, but
 * only while it is over the track drop zone AND inside the part of it that is actually visible (the zone is as tall and wide as every row;
 * the drop must not count over the tray below, the footer or the sticky left columns). The pointer is the live one (tracked from the
 * activator on), and the zone's left edge and visible bounds are read from the DOM at that same instant: dnd-kit's own `delta` is
 * scroll-adjusted by the scroll offsets of the OVER node's scrollers once `over` is the zone, which adds the grid's whole `scrollLeft`
 * to a tray item that never lived in it (a drop landed thousands of pixels away — found by the e2e), and `over.rect` is a snapshot from
 * the drag's start that a scroll makes stale.
 */
function outcomeOf(drag: DragData, event: Pick<DragMoveEvent, "delta" | "over">, scale: TimelineScale, pointer: Point | null): Span | null {
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

/**
 * The ONE `DndContext` of a Timeline page: the grid's bars and handles and the Unscheduled tray all sit inside it. It turns a
 * gesture into dates (`utils/timelineDrag.ts`), previews them while the drag runs (bars read them via `useTimelinePreview`),
 * announces every step in the UI language and, on a drop that changes something, PROPOSES the new dates through `onSchedule` —
 * the page's write path decides what happens next (optimistic update, the server's verdict). A drop that changes nothing, a
 * cancelled drag and a tray item dropped outside the track propose nothing.
 */
export default function TimelineDndContext({
  scale,
  onSchedule,
  children,
}: {
  scale: TimelineScale;
  /** A PROPOSAL of new dates. Answers whether the page took it: `false` (a save is still running) is announced as "not changed", never as a drop. */
  onSchedule: (id: BarId, start: string, end: string) => boolean;
  children: ReactNode;
}) {
  const { t } = useTranslation();
  const { dayWidth } = scale;
  const [preview, setPreview] = useState<TimelinePreview | null>(null);
  // The latest outcome and the last one announced, read by the announcements (dnd-kit calls the props below BEFORE them).
  const latest = useRef<{ drag: DragData; span: Span | null; refused?: boolean } | null>(null);
  const announced = useRef<string | null>(null);
  // The live pointer of a running TRAY drag (see `outcomeOf`): a tray item's day comes from where the pointer is, not from dnd-kit's delta.
  const pointer = useRef<Point | null>(null);
  const followPointer = useCallback((event: PointerEvent) => {
    if (!event.isPrimary) return; // a second finger or pen never moves the held item
    pointer.current = { x: event.clientX, y: event.clientY };
  }, []);
  const [autoScroll, setAutoScroll] = useState(BAR_AUTO_SCROLL);
  const stopFollowingPointer = () => {
    setAutoScroll(BAR_AUTO_SCROLL);
    window.removeEventListener("pointermove", followPointer);
    pointer.current = null;
  };
  useEffect(() => () => window.removeEventListener("pointermove", followPointer), [followPointer]);

  const keyboardOptions = useMemo(() => ({ coordinateGetter: keyboardCoordinates(dayWidth), scrollBehavior: "auto" as const }), [dayWidth]);
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }), useSensor(KeyboardSensor, keyboardOptions));

  // Bars move along the time axis in whole days; a tray item follows the pointer freely.
  const modifiers = useMemo<Modifier[]>(() => {
    const snap = snapToDays(dayWidth);
    return [(args) => (dragDataOf(args.active)?.kind === "tray" ? args.transform : snap({ ...args, transform: horizontalOnly(args) }))];
  }, [dayWidth]);

  const announcements = useMemo<Announcements>(() => {
    const take = () => {
      const current = latest.current;
      latest.current = null;
      return current;
    };
    const names = (drag: DragData, span: Span | null) => ({ name: drag.label, start: span?.start, end: span?.end });
    const startKey = {
      move: "timeline.announce.startMove",
      "resize-start": "timeline.announce.startResizeStart",
      "resize-end": "timeline.announce.startResizeEnd",
      tray: "timeline.announce.startTray",
    } as const;
    return {
      onDragStart: ({ active }) => {
        const drag = dragDataOf(active);
        return drag === null ? undefined : t(startKey[drag.kind], names(drag, spanOf(drag)));
      },
      onDragMove: () => {
        const current = latest.current;
        if (current === null || current.span === null || current.drag.kind === "tray") return undefined;
        const key = `${current.span.start}/${current.span.end}`;
        if (announced.current === key) return undefined;
        announced.current = key;
        return t("timeline.announce.step", names(current.drag, current.span));
      },
      onDragOver: () => undefined,
      // A finished or cancelled drag is announced once and forgotten (the announcement runs after the handlers above).
      onDragEnd: () => {
        const current = take();
        if (current === null) return undefined;
        if (current.refused) return t("timeline.announce.dropRefused", { name: current.drag.label });
        if (current.drag.kind === "tray") {
          return current.span === null
            ? t("timeline.announce.dropNone", { name: current.drag.label })
            : t("timeline.announce.dropTray", names(current.drag, current.span));
        }
        return t("timeline.announce.drop", names(current.drag, current.span ?? spanOf(current.drag)));
      },
      onDragCancel: () => {
        const current = take();
        if (current === null) return undefined;
        return current.drag.kind === "tray"
          ? t("timeline.announce.cancelTray", { name: current.drag.label })
          : t("timeline.announce.cancel", names(current.drag, spanOf(current.drag)));
      },
    };
  }, [t]);

  const track = (drag: DragData, event: Pick<DragMoveEvent, "delta" | "over">) => {
    const span = outcomeOf(drag, event, scale, pointer.current);
    latest.current = { drag, span };
    return span;
  };

  const onDragStart = ({ active, activatorEvent }: Pick<DragMoveEvent, "active" | "activatorEvent">) => {
    const drag = dragDataOf(active);
    if (drag === null) return;
    if (drag.kind === "tray") {
      pointer.current = pointerStart(activatorEvent);
      setAutoScroll(TRAY_AUTO_SCROLL);
      window.addEventListener("pointermove", followPointer, { passive: true });
    }
    const span = spanOf(drag);
    latest.current = { drag, span };
    announced.current = span === null ? null : `${span.start}/${span.end}`;
    setPreview(span === null || drag.kind === "tray" ? null : { barId: drag.barId, kind: drag.kind, ...span });
  };

  const onDragMove = (event: DragMoveEvent) => {
    const drag = dragDataOf(event.active);
    if (drag === null) return;
    const span = track(drag, event);
    if (span === null || drag.kind === "tray") return;
    // pointer moves report many events per day: only a changed span re-renders the bars
    setPreview((prev) =>
      prev !== null && prev.barId === drag.barId && prev.kind === drag.kind && sameSpan(prev, span)
        ? prev
        : { barId: drag.barId, kind: drag.kind, ...span },
    );
  };

  const onDragEnd = (event: DragEndEvent) => {
    setPreview(null);
    const drag = dragDataOf(event.active);
    if (drag === null) return;
    const span = track(drag, event);
    stopFollowingPointer();
    if (span === null) return;
    const original = spanOf(drag);
    if (original !== null && sameSpan(span, original)) return;
    // dnd-kit announces the drop AFTER this handler: say "not changed" when the page refused the proposal.
    if (!onSchedule(drag.barId, span.start, span.end)) latest.current = { drag, span, refused: true };
  };

  const onDragCancel = () => {
    stopFollowingPointer();
    setPreview(null);
  };

  return (
    <PreviewContext.Provider value={preview}>
      <DndContext
        id="timeline"
        sensors={sensors}
        collisionDetection={pointerWithin}
        autoScroll={autoScroll}
        modifiers={modifiers}
        onDragStart={onDragStart}
        onDragMove={onDragMove}
        onDragEnd={onDragEnd}
        onDragCancel={onDragCancel}
        accessibility={{ announcements, screenReaderInstructions: { draggable: t("timeline.dnd.instructions") } }}
      >
        {children}
      </DndContext>
    </PreviewContext.Provider>
  );
}
