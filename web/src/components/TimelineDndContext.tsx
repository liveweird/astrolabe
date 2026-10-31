import { useMemo, useRef, useState, type ReactNode } from "react";
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
function pointerStart(activatorEvent: Event | null): { x: number; y: number } | null {
  if (activatorEvent === null || !("clientX" in activatorEvent)) return null;
  const { clientX, clientY } = activatorEvent as MouseEvent;
  return { x: clientX, y: clientY ?? 0 };
}

const spanOf = (drag: DragData): Span | null => (drag.start !== undefined && drag.end !== undefined ? { start: drag.start, end: drag.end } : null);

/**
 * The dates a drag would produce right now. A bar gesture is its whole-day displacement; a tray item takes the day under the
 * pointer, but only while the pointer is over the track drop zone AND inside the part of it that is actually visible (the zone is
 * as tall and wide as every row; the drop must not count over the tray below, the footer or the sticky left columns). `over.rect`
 * and the scroll-adjusted `delta` are in the same frame, the one the drag started in, so the day is exact even after the grid
 * scrolled during the drag; the visible-bounds test uses that same pointer estimate (off by the scroll since the drag started —
 * only matters when the grid autoscrolls under a held tray item, and the server still decides).
 */
function outcomeOf(drag: DragData, event: Pick<DragMoveEvent, "delta" | "over" | "activatorEvent">, scale: TimelineScale): Span | null {
  if (drag.kind === "tray") {
    const start = pointerStart(event.activatorEvent);
    if (event.over?.id !== TIMELINE_DROP_ID || start === null) return null;
    const x = start.x + event.delta.x;
    const y = start.y + event.delta.y;
    const bounds = (event.over.data?.current as Partial<DropZoneData> | undefined)?.visibleBounds?.();
    if (bounds === null) return null;
    if (bounds !== undefined && (x < bounds.left || x >= bounds.right || y < bounds.top || y >= bounds.bottom)) return null;
    return dropOutcome("tray", null, 0, scale.dayAt(x - event.over.rect.left));
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
  onSchedule: (id: BarId, start: string, end: string) => void;
  children: ReactNode;
}) {
  const { t } = useTranslation();
  const { dayWidth } = scale;
  const [preview, setPreview] = useState<TimelinePreview | null>(null);
  // The latest outcome and the last one announced, read by the announcements (dnd-kit calls the props below BEFORE them).
  const latest = useRef<{ drag: DragData; span: Span | null } | null>(null);
  const announced = useRef<string | null>(null);

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

  const track = (drag: DragData, event: Pick<DragMoveEvent, "delta" | "over" | "activatorEvent">) => {
    const span = outcomeOf(drag, event, scale);
    latest.current = { drag, span };
    return span;
  };

  const onDragStart = ({ active }: { active: DragMoveEvent["active"] }) => {
    const drag = dragDataOf(active);
    if (drag === null) return;
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
    if (span === null) return;
    const original = spanOf(drag);
    if (original !== null && sameSpan(span, original)) return;
    onSchedule(drag.barId, span.start, span.end);
  };

  const onDragCancel = () => setPreview(null);

  return (
    <PreviewContext.Provider value={preview}>
      <DndContext
        id="timeline"
        sensors={sensors}
        collisionDetection={pointerWithin}
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
