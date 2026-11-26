import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { DndContext, DragOverlay, PointerSensor, useSensor, useSensors, type Announcements, type DragStartEvent } from "@dnd-kit/core";
import { useTranslation } from "react-i18next";
import type { PlanView } from "../api/plan";
import { PlanDragContext } from "../hooks/usePlanDragKey";
import { siblingBlocks, siblingIds, slotAt, slotEdge, type BlockRect, type OrderNode } from "../utils/planOrder";
import type { PlanTreeRow } from "../utils/planTree";
import { isRowNoop, rowPositionAfter, verticalOnly } from "../utils/timelineDrag";
import { ROW_AUTO_SCROLL } from "../utils/timelineDragTracking";
import classes from "../theme.module.css";
import type { PlanDragData } from "./PlanRowHandle";

/** dnd-kit's own live region says nothing: the page's one status region is the single announcer (pick-up, move, drop, cancel). */
const SILENT: Announcements = {
  onDragStart: () => undefined,
  onDragMove: () => undefined,
  onDragOver: () => undefined,
  onDragEnd: () => undefined,
  onDragCancel: () => undefined,
};

const SENSOR = { activationConstraint: { distance: 5 } };

type Line = { slot: number; top: number; left: number; width: number };

/** The row of `key` in the tree (never its pinned copy), as the browser lays it out now. */
const rowRect = (key: string): DOMRect | null => document.querySelector(`tr[data-scope="tree"][data-key="${key}"]`)?.getBoundingClientRect() ?? null;

/**
 * Where the blocks are NOW and the table's left edge and width, in client coordinates; `null` when one of them is not on the screen (a refetch took its row
 * away mid-drag), where a drop does nothing. The first block's own row gives the table's horizontal extent, clamped to the window so the line never starts or
 * ends off screen.
 */
function measure(blocks: readonly { first: string; last: string }[]): { rects: BlockRect[]; left: number; width: number } | null {
  const rects: BlockRect[] = [];
  for (const block of blocks) {
    const first = rowRect(block.first);
    const last = rowRect(block.last);
    if (first === null || last === null) return null;
    rects.push({ top: first.top, bottom: last.bottom });
  }
  const table = blocks.length > 0 ? document.querySelector(`tr[data-scope="tree"][data-key="${blocks[0].first}"]`)?.closest("table")?.getBoundingClientRect() : undefined;
  const left = Math.max(table?.left ?? 0, 0);
  return { rects, left, width: Math.max(Math.min(table?.width ?? 0, window.innerWidth - left), 0) };
}

/**
 * The Plan table's drag-and-drop of work streams and programs (never projects, never into another parent), on `@dnd-kit/core`: the pointer sensor only (the
 * grips are pointer-only; the row menu is the keyboard path). The rows are not sortable items - their heights differ and a program travels with its projects -
 * so the slot comes from the blocks' MIDPOINTS (`slotAt`: a sibling's row plus the visible rows under it) against the live pointer, read from a window
 * `pointermove` listener (the Roadmap's way) and the rows' live rectangles: dnd-kit's `delta` includes the scroll adjustment of the scrollable ancestors, so after an
 * autoscroll or a wheel it is no longer the pointer's position. The held row stays where it is, at half strength; a drop line shows the gap and an
 * overlay card follows the pointer. No line for the row's own gap, and a drop outside the list's extent (from its parent's row to its last block) does nothing.
 * A proposal goes through `onDrop`, which answers whether the page took it; Escape cancels (the sensor's own). Every step is said through `announce`.
 */
export default function PlanDndContext({
  view,
  rows,
  onDrop,
  announce,
  children,
}: {
  view: PlanView;
  rows: readonly PlanTreeRow[];
  /** A PROPOSAL: put the node into the gap `slot` among its siblings (0 = before the first). Answers whether the page took it (a write in flight refuses). */
  onDrop: (node: OrderNode, slot: number) => boolean;
  announce: (text: string) => void;
  children: ReactNode;
}) {
  const { t } = useTranslation();
  const [held, setHeld] = useState<PlanDragData | null>(null);
  const [line, setLine] = useState<Line | null>(null);
  // The running drag from its start (dnd-kit swaps an active node's data for an empty one when it unmounts) and where the pointer was when it began.
  const drag = useRef<{ data: PlanDragData; startY: number; parentKey: string | null; slot: number | null } | null>(null);
  const sensors = useSensors(useSensor(PointerSensor, SENSOR));
  // The live pointer's client y while a row is held (null before it first moves: the pick-up position stands in).
  const pointerY = useRef<number | null>(null);
  const followPointer = useCallback((event: PointerEvent) => {
    if (!event.isPrimary) return; // a second finger or pen never moves the held row
    pointerY.current = event.clientY;
  }, []);
  useEffect(() => () => window.removeEventListener("pointermove", followPointer), [followPointer]);

  const slotNow = (): { slot: number | null; line: Line | null } => {
    const current = drag.current;
    if (current === null) return { slot: null, line: null };
    const { node } = current.data;
    const blocks = siblingBlocks(rows, view, node);
    const measured = measure(blocks);
    if (measured === null) return { slot: null, line: null };
    const y = pointerY.current ?? current.startY;
    const extentTop = current.parentKey === null ? undefined : (rowRect(current.parentKey)?.top ?? undefined);
    const slot = slotAt(measured.rects, y, extentTop);
    const index = siblingIds(view, node).indexOf(node.id);
    const edge = slot === null || isRowNoop(index, slot) ? null : slotEdge(measured.rects, slot);
    return { slot, line: slot === null || edge === null ? null : { slot, top: edge, left: measured.left, width: measured.width } };
  };

  const onDragStart = ({ active, activatorEvent }: DragStartEvent) => {
    const data = active.data.current as PlanDragData | undefined;
    if (data === undefined || !("clientY" in activatorEvent)) return;
    const row = rows.find((candidate) => candidate.key === data.key);
    drag.current = { data, startY: (activatorEvent as PointerEvent).clientY, parentKey: row?.parentKey ?? null, slot: null };
    pointerY.current = null;
    window.addEventListener("pointermove", followPointer, { passive: true });
    setHeld(data);
    announce(t("plan.order.announcePickedUp", { name: data.label, position: data.index + 1, count: data.count }));
  };

  // dnd-kit reports a move for a pointer move AND for a scroll under a still pointer: the slot is read afresh from the live pointer and rows either way.
  const onDragMove = () => {
    const current = drag.current;
    if (current === null) return;
    const next = slotNow();
    // One update per slot (every row or so), not one per pointer move.
    if (next.slot === current.slot) return;
    current.slot = next.slot;
    setLine(next.line);
    const { data } = current;
    if (next.slot !== null) announce(t("plan.order.announceOver", { name: data.label, position: rowPositionAfter(data.index, next.slot), count: data.count }));
  };

  const finish = () => {
    window.removeEventListener("pointermove", followPointer);
    pointerY.current = null;
    drag.current = null;
    setHeld(null);
    setLine(null);
  };

  const onDragEnd = () => {
    const current = drag.current;
    if (current === null) return;
    const { slot } = slotNow();
    const { data } = current;
    finish();
    if (slot === null) {
      announce(t("plan.order.announceOutside", { name: data.label }));
      return;
    }
    const index = siblingIds(view, data.node).indexOf(data.node.id);
    // A drop into the row's own gap changes nothing: no write, said so.
    if (isRowNoop(index, slot)) announce(t("plan.order.announceUnchanged", { name: data.label, position: index + 1, count: data.count }));
    else onDrop(data.node, slot);
  };

  const onDragCancel = () => {
    const label = drag.current?.data.label;
    finish();
    if (label !== undefined) announce(t("plan.order.announceCancelled", { name: label }));
  };

  return (
    <PlanDragContext.Provider value={held?.key ?? null}>
      <DndContext
        id="plan"
        sensors={sensors}
        autoScroll={ROW_AUTO_SCROLL}
        onDragStart={onDragStart}
        onDragMove={onDragMove}
        onDragEnd={onDragEnd}
        onDragCancel={onDragCancel}
        accessibility={{ announcements: SILENT, screenReaderInstructions: { draggable: "" } }}
      >
        {children}
        {line !== null && <div aria-hidden="true" data-plan-slot={line.slot} className={classes.planRowDropLine} style={{ top: line.top - 1, left: line.left, width: line.width }} />}
        {/* The card a held row is dragged by (the row stays put). Mounted ONLY while a row is held: a mounted DragOverlay switches every drag to "overlay mode". */}
        {held !== null && (
          <DragOverlay modifiers={[verticalOnly]} dropAnimation={null}>
            <div className={classes.timelineRowGhost}>{held.label}</div>
          </DragOverlay>
        )}
      </DndContext>
    </PlanDragContext.Provider>
  );
}
