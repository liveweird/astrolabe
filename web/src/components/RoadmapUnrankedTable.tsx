import { Button, Table } from "@mantine/core";
import { useTranslation } from "react-i18next";
import type { RoadmapProject } from "../api/roadmap";
import RoadmapProjectCells from "./RoadmapProjectCells";
import ScrollRegion from "./ScrollRegion";

/**
 * The projects without a rank, by name. With `onRank` each row offers "Rank", which appends the project at the END of the
 * ranked list (it is then dragged or moved like any other row); without it the table is read-only.
 */
export default function RoadmapUnrankedTable({
  rows,
  onRank,
  label,
}: {
  rows: readonly RoadmapProject[];
  onRank: ((id: number) => void) | null;
  label: string;
}) {
  const { t } = useTranslation();
  return (
    <ScrollRegion label={label} minWidth={720}>
      <Table aria-label={label}>
        <Table.Thead>
          <Table.Tr>
            <Table.Th>{t("roadmap.column.project")}</Table.Th>
            <Table.Th>{t("roadmap.column.program")}</Table.Th>
            <Table.Th>{t("roadmap.column.workStream")}</Table.Th>
            <Table.Th>{t("common.field.owner")}</Table.Th>
            <Table.Th>{t("common.field.targetWindow")}</Table.Th>
            {onRank && <Table.Th aria-label={t("common.table.operations")} style={{ width: 1 }} />}
          </Table.Tr>
        </Table.Thead>
        <Table.Tbody>
          {rows.map((project) => (
            <Table.Tr key={project.id}>
              <RoadmapProjectCells project={project} />
              {onRank && (
                <Table.Td style={{ width: 1 }} ta="right">
                  <Button size="xs" variant="default" aria-label={t("roadmap.rankAria", { name: project.name })} onClick={() => onRank(project.id)}>
                    {t("roadmap.rank")}
                  </Button>
                </Table.Td>
              )}
            </Table.Tr>
          ))}
        </Table.Tbody>
      </Table>
    </ScrollRegion>
  );
}
