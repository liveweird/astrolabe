import { Table } from "@mantine/core";
import {
  closestCenter,
  DndContext,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import { SortableContext, sortableKeyboardCoordinates, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { useTranslation } from "react-i18next";
import type { RoadmapRankedProject } from "../api/roadmap";
import { roadmapAnnouncements } from "../utils/roadmapAnnouncements";
import RoadmapProjectCells from "./RoadmapProjectCells";
import RoadmapRow, { type RoadmapRowActions } from "./RoadmapRow";
import ScrollRegion from "./ScrollRegion";

/** What the ranked table can do — present only when the caller may edit the rank (`can.editRank`). */
export type RoadmapRankedEditing = RoadmapRowActions & {
  /** The dragged project was dropped on another one. */
  dropOver: (id: number, overId: number) => void;
  busy: boolean;
};

/**
 * The ranked list: rank number, project, program, work stream, owner, target window. With `editing` it is a dnd-kit sortable
 * (pointer drag with a 5 px activation distance; the keyboard sensor on the row's handle, announced in the UI language —
 * `utils/roadmapAnnouncements.ts` — with explicit Move up / Move down buttons beside it); without it, a plain read-only table
 * with no handles or buttons.
 */
export default function RoadmapRankedTable({
  rows,
  editing,
  label,
}: {
  rows: readonly RoadmapRankedProject[];
  editing: RoadmapRankedEditing | null;
  label: string;
}) {
  const { t } = useTranslation();
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  const header = (
    <Table.Thead>
      <Table.Tr aria-rowindex={1}>
        <Table.Th style={{ width: 1 }}>{t("roadmap.column.rank")}</Table.Th>
        <Table.Th>{t("roadmap.column.project")}</Table.Th>
        <Table.Th>{t("roadmap.column.program")}</Table.Th>
        <Table.Th>{t("roadmap.column.workStream")}</Table.Th>
        <Table.Th>{t("common.field.owner")}</Table.Th>
        <Table.Th>{t("common.field.targetWindow")}</Table.Th>
        {editing && <Table.Th aria-label={t("common.table.operations")} style={{ width: 1 }} />}
      </Table.Tr>
    </Table.Thead>
  );

  if (!editing) {
    return (
      <ScrollRegion label={label} minWidth={720}>
        <Table aria-label={label}>
          {header}
          <Table.Tbody>
            {rows.map((entry) => (
              <Table.Tr key={entry.project.id}>
                <Table.Td>{entry.position}</Table.Td>
                <RoadmapProjectCells project={entry.project} />
              </Table.Tr>
            ))}
          </Table.Tbody>
        </Table>
      </ScrollRegion>
    );
  }

  const onDragEnd = ({ active, over }: DragEndEvent) => {
    if (over && active.id !== over.id) editing.dropOver(Number(active.id), Number(over.id));
  };

  return (
    <DndContext
      id="roadmap-ranked"
      sensors={sensors}
      collisionDetection={closestCenter}
      onDragEnd={onDragEnd}
      accessibility={{ announcements: roadmapAnnouncements(t, rows), screenReaderInstructions: { draggable: t("roadmap.dnd.instructions") } }}
    >
      <SortableContext items={rows.map((entry) => entry.project.id)} strategy={verticalListSortingStrategy}>
        <ScrollRegion label={label} minWidth={720}>
          <Table aria-label={label} aria-busy={editing.busy}>
            {header}
            <Table.Tbody>
              {rows.map((entry, index) => (
                <RoadmapRow key={entry.project.id} entry={entry} index={index} count={rows.length} actions={editing} />
              ))}
            </Table.Tbody>
          </Table>
        </ScrollRegion>
      </SortableContext>
    </DndContext>
  );
}
