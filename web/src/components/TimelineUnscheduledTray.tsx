import type { PointerEventHandler, ReactNode } from "react";
import { Button, Table, Text } from "@mantine/core";
import { useDraggable } from "@dnd-kit/core";
import { CSS } from "@dnd-kit/utilities";
import { IconGripVertical } from "@tabler/icons-react";
import { useTranslation } from "react-i18next";
import type { DragData } from "../hooks/useTimelinePreview";
import type { BarId } from "../utils/timelineModel";
import classes from "../theme.module.css";

export interface TrayItem {
  id: BarId;
  /** The short name (announcements, the Schedule button's name). */
  label: string;
  /** One entry per column. */
  cells: readonly ReactNode[];
  /** May the caller schedule it? (The page's `can` flag.) Without it the row has no handle and no Schedule button. */
  canSchedule: boolean;
  /** Extra controls after Schedule (the row menu). */
  actions?: ReactNode;
}

function TrayRow({ item, onSchedule }: { item: TrayItem; onSchedule: (id: BarId) => void }) {
  const { t } = useTranslation();
  const data: DragData = { kind: "tray", barId: item.id, label: item.label };
  const { setNodeRef, listeners, transform, isDragging } = useDraggable({ id: `tray:${item.id}`, data, disabled: !item.canSchedule });
  // The handle is a pointer affordance only: the Schedule button is the keyboard and screen-reader path, so only the pointer
  // activator is attached to it (never the keyboard sensor's onKeyDown).
  const pointer = { onPointerDown: listeners?.onPointerDown as PointerEventHandler<HTMLSpanElement> | undefined };
  return (
    <Table.Tr
      ref={setNodeRef}
      className={isDragging ? classes.timelineTrayRowDragging : undefined}
      style={{ transform: CSS.Translate.toString(transform) }}
    >
      <Table.Td style={{ width: 1 }}>
        {item.canSchedule && (
          <span aria-hidden="true" className={classes.timelineTrayHandle} {...pointer}>
            <IconGripVertical size={16} />
          </span>
        )}
      </Table.Td>
      {item.cells.map((cell, index) => (
        <Table.Td key={index}>{cell}</Table.Td>
      ))}
      <Table.Td style={{ width: 1, whiteSpace: "nowrap" }} ta="right">
        {item.canSchedule && (
          <Button size="compact-sm" variant="default" aria-label={t("timeline.tray.scheduleAria", { name: item.label })} onClick={() => onSchedule(item.id)}>
            {t("timeline.tray.schedule")}
          </Button>
        )}
        {item.actions}
      </Table.Td>
    </Table.Tr>
  );
}

/**
 * The Unscheduled tray: a plain table of the rows that have no dates yet. With `canSchedule` a row can be dragged (by its pointer
 * handle) onto the timeline above — it is scheduled at the day under the pointer for one calendar week — or scheduled with its
 * Schedule button, which hands the page the id and lets it choose the dates (the deterministic path). It must sit inside the
 * page's `TimelineDndContext`. It is deliberately not in a scroll region: a dragged row translates out of the table, over the
 * timeline, and a scroller would clip it.
 */
export default function TimelineUnscheduledTray({
  label,
  columns,
  items,
  emptyText,
  onSchedule,
}: {
  /** The table's accessible name. */
  label: string;
  /** Column headers, aligned with each item's `cells`. */
  columns: readonly string[];
  items: readonly TrayItem[];
  emptyText: string;
  onSchedule: (id: BarId) => void;
}) {
  const { t } = useTranslation();
  if (items.length === 0) return <Text c="dimmed">{emptyText}</Text>;
  return (
    <Table aria-label={label}>
      <Table.Thead>
        <Table.Tr>
          <Table.Th aria-label={t("timeline.tray.dragColumn")} style={{ width: 1 }} />
          {columns.map((column) => (
            <Table.Th key={column}>{column}</Table.Th>
          ))}
          <Table.Th aria-label={t("common.table.operations")} style={{ width: 1 }} />
        </Table.Tr>
      </Table.Thead>
      <Table.Tbody>
        {items.map((item) => (
          <TrayRow key={item.id} item={item} onSchedule={onSchedule} />
        ))}
      </Table.Tbody>
    </Table>
  );
}
