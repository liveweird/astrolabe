import type { PointerEventHandler } from "react";
import { useDraggable } from "@dnd-kit/core";
import { IconGripVertical } from "@tabler/icons-react";
import type { OrderNode } from "../utils/planOrder";
import classes from "../theme.module.css";

/** What a held handle tells the page's `PlanDndContext`: the row it belongs to and how it is named on the screen. */
export type PlanDragData = { key: string; node: OrderNode; label: string; index: number; count: number };

/**
 * The grip a work stream or program row is dragged by. A POINTER affordance only, like the Roadmap's: only the pointer activator is attached (never the keyboard
 * sensor's `onKeyDown`, no `attributes`), it is `aria-hidden`, not focusable and hidden on paper; the row's menu (Move up / Move down) is the keyboard and
 * screen-reader path. `touch-action` and `user-select` are the handle's alone (`.planRowHandle`), so the page still scrolls under a finger. It renders inside
 * the page's `PlanDndContext`, which owns the slot, the drop line and the announcements.
 */
export default function PlanRowHandle({ rowKey, node, label, index, count }: { rowKey: string; node: OrderNode; label: string; index: number; count: number }) {
  const data: PlanDragData = { key: rowKey, node, label, index, count };
  const { setNodeRef, listeners } = useDraggable({ id: `plan-row:${rowKey}`, data });
  const pointer = { onPointerDown: listeners?.onPointerDown as PointerEventHandler<HTMLSpanElement> | undefined };
  return (
    <span ref={setNodeRef} aria-hidden="true" data-plan-handle="" data-print="hide" className={classes.planRowHandle} {...pointer}>
      <IconGripVertical size={16} />
    </span>
  );
}
