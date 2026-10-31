import { useEffect, useRef } from "react";
import { ActionIcon, Group, Table } from "@mantine/core";
import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { IconArrowDown, IconArrowUp, IconGripVertical, IconX } from "@tabler/icons-react";
import { useTranslation } from "react-i18next";
import type { RoadmapRankedProject } from "../api/roadmap";
import RoadmapProjectCells from "./RoadmapProjectCells";

export type RoadmapRowActions = {
  /** Answers whether the change was taken (a save in flight ignores it). */
  move: (id: number, delta: -1 | 1) => boolean;
  unrank: (id: number) => void;
};

/**
 * One ranked row of an EDITABLE list: a `useSortable` `<tr>` whose drag handle is a real button (Space picks up, arrows move,
 * Space drops — dnd-kit's keyboard sensor) beside the explicit Move up / Move down / Unrank buttons, the deterministic
 * keyboard path. The row's identity for dnd-kit is the project id. A Move button keeps keyboard focus across its own move
 * (the row changes place, and a disabled end button cannot hold focus): focus lands on the same button, or on its twin when
 * the row reached the end it was heading for.
 */
export default function RoadmapRow({
  entry,
  index,
  count,
  actions,
}: {
  entry: RoadmapRankedProject;
  index: number;
  count: number;
  actions: RoadmapRowActions;
}) {
  const { t } = useTranslation();
  const { project } = entry;
  const { attributes, listeners, setNodeRef, setActivatorNodeRef, transform, transition, isDragging } = useSortable({ id: project.id });
  const upRef = useRef<HTMLButtonElement>(null);
  const downRef = useRef<HTMLButtonElement>(null);
  const keepFocusOn = useRef<"up" | "down" | null>(null);
  const first = index === 0;
  const last = index === count - 1;

  // The optimistic render that follows a Move click changes this row's index: put focus back where the click was.
  useEffect(() => {
    const wanted = keepFocusOn.current;
    keepFocusOn.current = null;
    if (wanted === null) return;
    const primary = wanted === "up" ? upRef.current : downRef.current;
    const twin = wanted === "up" ? downRef.current : upRef.current;
    (primary && !primary.disabled ? primary : twin)?.focus();
  }, [index]);

  const move = (delta: -1 | 1) => {
    if (actions.move(project.id, delta)) keepFocusOn.current = delta < 0 ? "up" : "down";
  };

  return (
    <Table.Tr
      ref={setNodeRef}
      aria-rowindex={index + 2}
      style={{
        transform: CSS.Transform.toString(transform && { ...transform, x: 0 }),
        transition,
        position: isDragging ? "relative" : undefined,
        zIndex: isDragging ? 1 : undefined,
        background: isDragging ? "var(--mantine-color-body)" : undefined,
      }}
    >
      <Table.Td>{entry.position}</Table.Td>
      <RoadmapProjectCells project={project} />
      <Table.Td style={{ width: 1 }} ta="right">
        <Group gap={4} wrap="nowrap" justify="flex-end">
          <ActionIcon
            ref={setActivatorNodeRef}
            size="sm"
            aria-label={t("roadmap.dragHandleAria", { name: project.name })}
            style={{ touchAction: "none", cursor: isDragging ? "grabbing" : "grab" }}
            {...attributes}
            {...listeners}
          >
            <IconGripVertical size={16} />
          </ActionIcon>
          <ActionIcon ref={upRef} size="sm" disabled={first} aria-label={t("roadmap.moveUpAria", { name: project.name })} onClick={() => move(-1)}>
            <IconArrowUp size={16} />
          </ActionIcon>
          <ActionIcon ref={downRef} size="sm" disabled={last} aria-label={t("roadmap.moveDownAria", { name: project.name })} onClick={() => move(1)}>
            <IconArrowDown size={16} />
          </ActionIcon>
          <ActionIcon size="sm" aria-label={t("roadmap.unrankAria", { name: project.name })} onClick={() => actions.unrank(project.id)}>
            <IconX size={16} />
          </ActionIcon>
        </Group>
      </Table.Td>
    </Table.Tr>
  );
}
