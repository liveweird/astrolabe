import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  DndContext,
  DragOverlay,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragMoveEvent,
  type Modifier,
} from "@dnd-kit/core";
import { useTranslation } from "react-i18next";
import { useTimelineAnnouncements, type LatestDrag } from "../hooks/useTimelineAnnouncements";
import { dragDataOf, PreviewContext, type DragData, type TimelinePreview } from "../hooks/useTimelinePreview";
import { drawOutcome, horizontalOnly, keyboardCoordinates, sameSpan, snapToDays, verticalOnly } from "../utils/timelineDrag";
import {
  BAR_AUTO_SCROLL,
  collisionFor,
  drawSpanOf,
  outcomeOf,
  pointerStart,
  resolveDrag,
  ROW_AUTO_SCROLL,
  rowSlotOf,
  spanOf,
  TRAY_AUTO_SCROLL,
  type Point,
} from "../utils/timelineDragTracking";
import type { BarId } from "../utils/timelineModel";
import type { TimelineScale } from "../utils/timelineScale";
import classes from "../theme.module.css";

/** The row card's own modifiers (the context's pass a row transform through): it only follows the pointer up and down. */
const OVERLAY_MODIFIERS: Modifier[] = [verticalOnly];

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
  const latest = useRef<LatestDrag | null>(null);
  const announced = useRef<string | null>(null);
  const announcements = useTimelineAnnouncements(t, latest, announced);
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
