import type { PointerEventHandler } from "react";
import { useDraggable } from "@dnd-kit/core";
import { IconGripVertical } from "@tabler/icons-react";
import type { DragData } from "../hooks/useTimelinePreview";
import type { BarId } from "../utils/timelineModel";
import classes from "../theme.module.css";

/**
 * The grip a row is dragged by (the team page's order). A POINTER affordance only, like the tray's handle: only the pointer activator is
 * attached (never the keyboard sensor's `onKeyDown`, no `attributes`), it is `aria-hidden` and not focusable — the row's header cell stays
 * the one roving stop ("one cell, one stop"), and the row menu's Move items are the keyboard and screen-reader path. It renders inside the
 * page's `TimelineDndContext`, which holds the row, the pointer, the slot and the announcements.
 */
export default function TimelineRowHandle({ id, label, position, count }: { id: BarId; label: string; position: number; count: number }) {
  const data: DragData = { kind: "row", barId: id, label, position, count };
  const { setNodeRef, listeners } = useDraggable({ id: `row:${id}`, data });
  const pointer = { onPointerDown: listeners?.onPointerDown as PointerEventHandler<HTMLSpanElement> | undefined };
  return (
    <span ref={setNodeRef} aria-hidden="true" data-row-handle="" className={classes.timelineRowHandle} {...pointer}>
      <IconGripVertical size={16} />
    </span>
  );
}
