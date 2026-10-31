import { Table, Text } from "@mantine/core";
import { useTranslation } from "react-i18next";
import type { RoadmapProject } from "../api/roadmap";

/** The data cells both roadmap tables share, after their leading cell: project, program, work stream, owner, target window. */
export default function RoadmapProjectCells({ project }: { project: RoadmapProject }) {
  const { t } = useTranslation();
  return (
    <>
      <Table.Td>
        <Text size="sm" fw={500}>
          {project.name}
        </Text>
      </Table.Td>
      <Table.Td>
        <Text size="sm">{project.programName}</Text>
      </Table.Td>
      <Table.Td>
        <Text size="sm">{project.workStreamName}</Text>
      </Table.Td>
      <Table.Td>
        <Text size="sm">{project.ownerName}</Text>
      </Table.Td>
      <Table.Td>
        {project.targetStart !== null && project.targetEnd !== null ? (
          <Text size="sm">{t("plan.window", { start: project.targetStart, end: project.targetEnd })}</Text>
        ) : (
          <Text size="sm" c="dimmed">
            {t("plan.noWindow")}
          </Text>
        )}
      </Table.Td>
    </>
  );
}
