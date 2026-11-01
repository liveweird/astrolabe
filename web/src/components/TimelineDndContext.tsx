import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  DndContext,
  DragOverlay,
  KeyboardSensor,
  PointerSensor,
  pointerWithin,
  useSensor,
  useSensors,
  type Active,
  type Announcements,
  type CollisionDetection,
  type DragEndEvent,
  type DragMoveEvent,
  type Modifier,
} from "@dnd-kit/core";
import { useTranslation } from "react-i18next";
import {
  dragDataOf,
  PreviewContext,
  TIMELINE_DROP_ID,
  TIMELINE_ROW_DROP_ID,
  type DragData,
  type DropZoneData,
  type RowDropZoneData,
  type TimelinePreview,
} from "../hooks/useTimelinePreview";
import {
  drawOutcome,
  dropOutcome,
  horizontalOnly,
  isRowNoop,
  keyboardCoordinates,
  rowPositionAfter,
  rowSlotWithin,
  sameSpan,
  snapToDays,
  verticalOnly,
  type Span,
} from "../utils/timelineDrag";
import type { BarId } from "../utils/timelineModel";
import type { TimelineScale } from "../utils/timelineScale";
import classes from "../theme.module.css";

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
/**
 * A held ROW travels along the rows: a real vertical zone (holding it near the top or bottom 15 % of the grid scrolls it, rows mount as they
 * come into the window, and the slot follows the pointer against the zone's live top) and a hairline horizontal one (never zero: dnd-kit
 * divides by the threshold).
 */
const ROW_AUTO_SCROLL = { threshold: { x: 0.02, y: 0.15 } };
/** The row card's own modifiers (the context's pass a row transform through): it only follows the pointer up and down. */
const OVERLAY_MODIFIERS: Modifier[] = [verticalOnly];

/** The dragged item's data: the active draggable's own, else what was held when the drag began (see `held` below). */
const resolveDrag = (active: Pick<Active, "data"> | null, held: { current: DragData | null }): DragData | null => dragDataOf(active) ?? held.current;

/** What the row zone says about where a held row would land: the slot under the live pointer, or `null` where nothing lands. */
function rowSlotOf(over: DragMoveEvent["over"], pointer: Point | null): number | null {
  const zone = over?.id === TIMELINE_ROW_DROP_ID ? (over.data?.current as Partial<RowDropZoneData> | undefined) : undefined;
  return rowSlotWithin(pointer, zone?.zoneTop?.() ?? null, zone?.rowBounds?.() ?? null, zone?.rowCount);
}

/**
 * The row zone sits over the whole body, so it would also be a collision for a tray drag. A row drag collides ONLY with it — and always: where
 * the pointer really is (inside the scroller, over the sticky header, outside the grid) is `rowSlotWithin`'s question, answered from the live
 * pointer, because dnd-kit's snapshot of the zone's rectangle does not reach over the header at a scroll offset of 0. Every other kind never
 * collides with it (bars and the tray see exactly the droppables they saw before the row drag existed).
 */
const collisionFor = (isRow: boolean): CollisionDetection => (args) => {
  if (!isRow) return pointerWithin({ ...args, droppableContainers: args.droppableContainers.filter((container) => container.id !== TIMELINE_ROW_DROP_ID) });
  const zone = args.droppableContainers.find((container) => container.id === TIMELINE_ROW_DROP_ID);
  return zone === undefined ? [] : [{ id: zone.id, data: { droppableContainer: zone, value: 0 } }];
};

/**
 * The span a DRAW has dragged out: from the anchor day (the day under the pointer-down, fixed at pick-up) to the day under the live pointer,
 * in either direction (`drawOutcome`). The day comes from the track zone's live left edge, like a tray item's; while the pointer is not over the
 * zone (the tray, the page around the grid) the last span is kept, and the pointer's day is clamped to the scale's range — the drop there still proposes what was drawn.
 */
function drawSpanOf(over: DragMoveEvent["over"], scale: TimelineScale, pointer: Point | null, anchor: number | null, last: Span | null): Span | null {
  if (anchor === null) return last;
  const zone = over?.id === TIMELINE_DROP_ID ? (over.data?.current as Partial<DropZoneData> | undefined) : undefined;
  const left = zone?.zoneLeft?.();
  if (pointer === null || left === undefined || left === null) return last;
  // Clamped to the range: dnd-kit's zone rect is a snapshot, so after an autoscroll the pointer can sit over the sticky columns (a negative x - left).
  return drawOutcome(anchor, Math.min(Math.max(scale.dayAt(pointer.x - left), scale.from), scale.to));
}

/** The facts an announcement states about a row: its name, the position it would take with `slot` (its own without one) and the row count. */
const rowFacts = (drag: DragData, slot: number | null) => ({
  name: drag.label,
  count: drag.count,
  position: slot === null || drag.position === undefined ? drag.position : rowPositionAfter(drag.position - 1, slot),
});

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
 *
 * It learns a fourth gesture family, `kind: "row"` (a team page's row handle): no dates, a SLOT between rows from the live pointer
 * (`rowSlotOf`), previewed by the insertion line and an overlay card (the rows themselves never move) and proposed through `onReorder`.
 * dnd-kit's hooks bind to the NEAREST context, so one context has to serve bars, the tray and rows.
 *
 * And a fifth, `kind: "draw"` (a row's pointer-only draw surface, `TimelineDrawSurface`): the span from the day under the pointer-down to the
 * day under the live pointer (`drawSpanOf`), proposed through the SAME `onSchedule(barId, start, end)` as a bar move — `barId` being the bar the
 * row would get — so a page handles move, resize and draw in one branch.
 */
export default function TimelineDndContext({
  scale,
  onSchedule,
  onReorder,
  children,
}: {
  scale: TimelineScale;
  /** A PROPOSAL of new dates. Answers whether the page took it: `false` (a save is still running) is announced as "not changed", never as a drop. */
  onSchedule: (id: BarId, start: string, end: string) => boolean;
  /** A PROPOSAL to move a row into the gap `slot` (0 = above the first row). Answers like `onSchedule`; absent on pages whose rows cannot be reordered. */
  onReorder?: (id: BarId, slot: number) => boolean;
  children: ReactNode;
}) {
  const { t } = useTranslation();
  const { dayWidth } = scale;
  const [preview, setPreview] = useState<TimelinePreview | null>(null);
  // The latest outcome and the last one announced, read by the announcements (dnd-kit calls the props below BEFORE them).
  const latest = useRef<{ drag: DragData; span: Span | null; slot?: number | null; refused?: boolean } | null>(null);
  const announced = useRef<string | null>(null);
  // The running drag's data from its start: dnd-kit swaps an active node's data for an empty one when the node unmounts mid-drag, which a
  // virtualised row's handle does when autoscroll carries its row out of the window (the drop must still know what was held).
  const held = useRef<DragData | null>(null);
  // The live pointer of a running TRAY or ROW drag (see `outcomeOf`, `rowSlotOf`): a tray item's day and a row's slot come from where the pointer is, not from dnd-kit's delta.
  const pointer = useRef<Point | null>(null);
  // The epoch day a running DRAW began on (the day under the pointer-down, fixed at pick-up: the grid may scroll under the held pointer).
  const drawAnchor = useRef<number | null>(null);
  const followPointer = useCallback((event: PointerEvent) => {
    if (!event.isPrimary) return; // a second finger or pen never moves the held item
    pointer.current = { x: event.clientX, y: event.clientY };
  }, []);
  const [autoScroll, setAutoScroll] = useState(BAR_AUTO_SCROLL);
  const stopFollowingPointer = () => {
    setAutoScroll(BAR_AUTO_SCROLL);
    window.removeEventListener("pointermove", followPointer);
    pointer.current = null;
    held.current = null;
    drawAnchor.current = null;
  };
  useEffect(() => () => window.removeEventListener("pointermove", followPointer), [followPointer]);

  const keyboardOptions = useMemo(() => ({ coordinateGetter: keyboardCoordinates(dayWidth), scrollBehavior: "auto" as const }), [dayWidth]);
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }), useSensor(KeyboardSensor, keyboardOptions));

  // Bars move along the time axis in whole days; a tray item follows the pointer freely, and so does a row's transform (its overlay card
  // applies `verticalOnly` itself; no row ever gets a transform of its own) and a draw's (its surface never moves).
  const modifiers = useMemo<Modifier[]>(() => {
    const snap = snapToDays(dayWidth);
    return [
      (args) => {
        const kind = resolveDrag(args.active, held)?.kind;
        return kind === "tray" || kind === "row" || kind === "draw" ? args.transform : snap({ ...args, transform: horizontalOnly(args) });
      },
    ];
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
      row: "timeline.announce.startRow",
      draw: "timeline.announce.startDraw",
    } as const;
    return {
      onDragStart: ({ active }) => {
        const drag = dragDataOf(active);
        if (drag === null) return undefined;
        return drag.kind === "row" ? t(startKey.row, rowFacts(drag, null)) : t(startKey[drag.kind], names(drag, spanOf(drag)));
      },
      onDragMove: () => {
        const current = latest.current;
        if (current === null) return undefined;
        if (current.drag.kind === "row") {
          // once per distinct slot; nowhere to land says nothing (the drop will)
          if (current.slot === undefined || current.slot === null) return undefined;
          const key = `slot:${current.slot}`;
          if (announced.current === key) return undefined;
          announced.current = key;
          return t("timeline.announce.stepRow", rowFacts(current.drag, current.slot));
        }
        if (current.span === null || current.drag.kind === "tray") return undefined;
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
        if (current.drag.kind === "row") {
          const slot = current.slot ?? null;
          const stays = slot === null || (current.drag.position !== undefined && isRowNoop(current.drag.position - 1, slot));
          return stays ? t("timeline.announce.dropRowNone", rowFacts(current.drag, null)) : t("timeline.announce.dropRow", rowFacts(current.drag, slot));
        }
        if (current.drag.kind === "draw") {
          return current.span === null ? t("timeline.announce.cancelDraw", { name: current.drag.label }) : t("timeline.announce.dropDraw", names(current.drag, current.span));
        }
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
        if (current.drag.kind === "row") return t("timeline.announce.cancelRow", rowFacts(current.drag, null));
        if (current.drag.kind === "draw") return t("timeline.announce.cancelDraw", { name: current.drag.label });
        return current.drag.kind === "tray"
          ? t("timeline.announce.cancelTray", { name: current.drag.label })
          : t("timeline.announce.cancel", names(current.drag, spanOf(current.drag)));
      },
    };
  }, [t]);

  const track = (drag: DragData, event: Pick<DragMoveEvent, "delta" | "over">) => {
    const span =
      drag.kind === "draw"
        ? drawSpanOf(event.over, scale, pointer.current, drawAnchor.current, latest.current?.span ?? null)
        : outcomeOf(drag, event, scale, pointer.current);
    latest.current = { drag, span };
    return span;
  };

  const onDragStart = ({ active, activatorEvent }: Pick<DragMoveEvent, "active" | "activatorEvent">) => {
    const drag = dragDataOf(active);
    if (drag === null) return;
    held.current = drag;
    if (drag.kind === "tray" || drag.kind === "row" || drag.kind === "draw") {
      pointer.current = pointerStart(activatorEvent);
      // a draw keeps the bars' autoscroll (along time only); a tray item and a row each swap in their own
      if (drag.kind !== "draw") setAutoScroll(drag.kind === "row" ? ROW_AUTO_SCROLL : TRAY_AUTO_SCROLL);
      window.addEventListener("pointermove", followPointer, { passive: true });
    }
    if (drag.kind === "draw") {
      // The anchor is the day under the pointer-down, read against the surface's own live left edge (there is no `over` at pick-up yet).
      const left = drag.trackLeft?.();
      drawAnchor.current = pointer.current === null || left === undefined || left === null ? null : scale.dayAt(pointer.current.x - left);
    }
    if (drag.kind === "row") {
      latest.current = { drag, span: null, slot: null };
      announced.current = null;
      setPreview({ barId: drag.barId, kind: "row", label: drag.label, slot: null });
      return;
    }
    const span = drag.kind === "draw" ? (drawAnchor.current === null ? null : drawOutcome(drawAnchor.current, drawAnchor.current)) : spanOf(drag);
    latest.current = { drag, span };
    announced.current = span === null ? null : `${span.start}/${span.end}`;
    setPreview(span === null || drag.kind === "tray" ? null : { barId: drag.barId, kind: drag.kind, ...span });
  };

  /** The slot a held row would land in now; the live pointer and the zone's live readers, as for a tray item's day. */
  const trackRow = (drag: DragData, event: Pick<DragMoveEvent, "over">) => {
    const slot = rowSlotOf(event.over, pointer.current);
    latest.current = { drag, span: null, slot };
    return slot;
  };

  const onDragMove = (event: DragMoveEvent) => {
    const drag = resolveDrag(event.active, held);
    if (drag === null) return;
    if (drag.kind === "row") {
      const slot = trackRow(drag, event);
      // one update per slot (every 36 px), not one per pointer move
      setPreview((prev) => (prev !== null && prev.kind === "row" && prev.barId === drag.barId && prev.slot === slot ? prev : { barId: drag.barId, kind: "row", label: drag.label, slot }));
      return;
    }
    const span = track(drag, event);
    const { kind } = drag;
    if (span === null || kind === "tray") return;
    // pointer moves report many events per day: only a changed span re-renders the bars
    setPreview((prev) =>
      prev !== null && prev.kind !== "row" && prev.barId === drag.barId && prev.kind === kind && sameSpan(prev, span)
        ? prev
        : { barId: drag.barId, kind, ...span },
    );
  };

  const onDragEnd = (event: DragEndEvent) => {
    setPreview(null);
    const drag = resolveDrag(event.active, held);
    if (drag === null) return;
    if (drag.kind === "row") {
      const slot = trackRow(drag, event);
      stopFollowingPointer();
      if (slot === null) return;
      // The page decides whether the slot changes anything against the order it shows NOW (a refetch mid-drag may have moved the row since
      // pick-up, so the pick-up position is only used for the announcements); a refusal is "not changed" (dnd-kit announces AFTER this handler).
      if (onReorder?.(drag.barId, slot) === false) latest.current = { drag, span: null, slot, refused: true };
      return;
    }
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
        collisionDetection={(args) => collisionFor(resolveDrag(args.active, held)?.kind === "row")(args)}
        autoScroll={autoScroll}
        modifiers={modifiers}
        onDragStart={onDragStart}
        onDragMove={onDragMove}
        onDragEnd={onDragEnd}
        onDragCancel={onDragCancel}
        accessibility={{ announcements, screenReaderInstructions: { draggable: t("timeline.dnd.instructions") } }}
      >
        {children}
        {/* The card a held ROW is dragged by (rows never move). Mounted ONLY while a row is held: dnd-kit renders a mounted DragOverlay for every
            drag (even with no children), which switches the drag to "overlay mode" — no scroll compensation of the dragged node — and puts a
            fixed wrapper over a bar. */}
        {preview?.kind === "row" && (
          <DragOverlay modifiers={OVERLAY_MODIFIERS} dropAnimation={null}>
            <div className={classes.timelineRowGhost}>{preview.label}</div>
          </DragOverlay>
        )}
      </DndContext>
    </PreviewContext.Provider>
  );
}
