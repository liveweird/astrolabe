import { Anchor, Stack, Table, Text } from "@mantine/core";
import { useTranslation } from "react-i18next";
import { Link as RouterLink } from "react-router-dom";
import type { DependencyListRow } from "../api/dependencyList";
import { projectPath } from "../utils/planLinks";
import { teamPath } from "../utils/teamLinks";
import { DependencyStatusBadge, DependencyLagText } from "./DependencyCells";
import ScrollRegion from "./ScrollRegion";

const NO_WRAP = { whiteSpace: "nowrap" } as const;
/** The table scrolls inside its region (1,000 rows at most, no virtualisation - a plain table, like the baseline comparison's). */
const TABLE_MAX_HEIGHT = "70vh";

/** One end: its name (a project end is worded "Project X"), under it its project and, for a milestone, its team - each a real link to its page. */
function EndCell({ end }: { end: DependencyListRow["predecessor"] }) {
  const { t } = useTranslation();
  return (
    <Stack gap={2}>
      <Text size="sm">{end.kind === "PROJECT" ? t("project.dependency.wholeProject", { name: end.name }) : end.name}</Text>
      <Anchor component={RouterLink} to={projectPath(end.projectId)} size="xs" aria-label={t("plan.openProjectAria", { name: end.projectName })}>
        {end.projectName}
      </Anchor>
      {end.teamId !== null && end.teamName !== null && (
        <Anchor component={RouterLink} to={teamPath(end.teamId)} size="xs" aria-label={t("teams.openAria", { name: end.teamName })}>
          {end.teamName}
        </Anchor>
      )}
    </Stack>
  );
}

function DependencyListTableRow({ row }: { row: DependencyListRow }) {
  const { t } = useTranslation();
  const { check } = row;
  return (
    <Table.Tr>
      <Table.Td style={NO_WRAP}>
        <DependencyStatusBadge check={check} />
      </Table.Td>
      <Table.Td>
        <EndCell end={row.predecessor} />
      </Table.Td>
      <Table.Td>{t(`project.dependency.type.${row.type}`)}</Table.Td>
      <Table.Td><DependencyLagText lagDays={row.lagDays} /></Table.Td>
      <Table.Td>
        <EndCell end={row.successor} />
      </Table.Td>
      <Table.Td style={NO_WRAP}>
        {check.requiredDate !== null && check.actualDate !== null ? t("project.dependency.dates", { required: check.requiredDate, actual: check.actualDate }) : "–"}
      </Table.Td>
    </Table.Tr>
  );
}

/** The plan's dependencies as a plain read-only table in the server's order (violated first); nothing here changes a link - the project page does. */
export default function DependencyListTable({ rows }: { rows: readonly DependencyListRow[] }) {
  const { t } = useTranslation();
  return (
    <ScrollRegion label={t("dependencyList.tableAria")} minWidth={1000} maxHeight={TABLE_MAX_HEIGHT}>
      <Table aria-label={t("dependencyList.tableAria")} stickyHeader>
        <Table.Thead>
          <Table.Tr>
            <Table.Th>{t("project.dependency.column.status")}</Table.Th>
            <Table.Th>{t("project.dependency.column.predecessor")}</Table.Th>
            <Table.Th>{t("project.dependency.column.type")}</Table.Th>
            <Table.Th>{t("project.dependency.column.lag")}</Table.Th>
            <Table.Th>{t("project.dependency.column.successor")}</Table.Th>
            <Table.Th>{t("project.dependency.column.dates")}</Table.Th>
          </Table.Tr>
        </Table.Thead>
        <Table.Tbody>
          {rows.map((row) => (
            <DependencyListTableRow key={row.id} row={row} />
          ))}
        </Table.Tbody>
      </Table>
    </ScrollRegion>
  );
}
