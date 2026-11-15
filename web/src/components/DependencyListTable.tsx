import { memo } from "react";
import { Anchor, Menu, Stack, Table, Text } from "@mantine/core";
import { IconPencil, IconTrash } from "@tabler/icons-react";
import { useTranslation } from "react-i18next";
import { Link as RouterLink } from "react-router-dom";
import { dependencyEndpointText } from "../utils/dependencyForm";
import type { DependencyListRow } from "../utils/dependencyListRows";
import { projectPath } from "../utils/planLinks";
import { teamPath } from "../utils/teamLinks";
import { DependencyStatusBadge, DependencyLagText } from "./DependencyCells";
import DestructiveMenuItem from "./DestructiveMenuItem";
import RowActionsMenu from "./RowActionsMenu";
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

/** The row's menu, named by both ends with their projects; each item only under its own `can` flag (the project page's rule). */
function RowMenu({ row, onEdit, onDelete }: { row: DependencyListRow; onEdit: (row: DependencyListRow) => void; onDelete: (row: DependencyListRow) => void }) {
  const { t } = useTranslation();
  const name = `${dependencyEndpointText(row.predecessor, null, t)} → ${dependencyEndpointText(row.successor, null, t)}`;
  return (
    <RowActionsMenu label={t("common.table.operationsAria", { name })}>
      {row.can.edit && (
        <Menu.Item leftSection={<IconPencil size={14} />} onClick={() => onEdit(row)} aria-label={t("common.action.editAria", { name })}>
          {t("project.dependency.edit")}
        </Menu.Item>
      )}
      {row.can.delete && (
        <DestructiveMenuItem leftSection={<IconTrash size={14} />} onClick={() => onDelete(row)} aria-label={t("common.action.deleteAria", { name })}>
          {t("common.action.delete")}
        </DestructiveMenuItem>
      )}
    </RowActionsMenu>
  );
}

// Memoized: an open dialog on the page changes its state and re-renders the page, and up to 1,000 rows (each with a menu) must not follow.
const DependencyListTableRow = memo(function DependencyListTableRow({
  row,
  operations,
  onEdit,
  onDelete,
}: {
  row: DependencyListRow;
  /** The operations column is part of the table (some row offers something). */
  operations: boolean;
  onEdit: (row: DependencyListRow) => void;
  onDelete: (row: DependencyListRow) => void;
}) {
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
      {operations && (
        <Table.Td style={{ width: 1 }} ta="right">
          {(row.can.edit || row.can.delete) && <RowMenu row={row} onEdit={onEdit} onDelete={onDelete} />}
        </Table.Td>
      )}
    </Table.Tr>
  );
});

/**
 * The plan's dependencies as a plain table in the server's order (violated first). A row offers "Edit…" and "Delete" in its menu only where the
 * server's `can` says the caller may (the successor's project chain, or an administrator); when no shown row offers anything the operations
 * column is not there at all, and a row that offers nothing has an empty cell. Adding a link stays on the project page.
 */
export default function DependencyListTable({
  rows,
  onEdit,
  onDelete,
}: {
  rows: readonly DependencyListRow[];
  onEdit: (row: DependencyListRow) => void;
  onDelete: (row: DependencyListRow) => void;
}) {
  const { t } = useTranslation();
  const operations = rows.some((row) => row.can.edit || row.can.delete);
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
            {operations && <Table.Th aria-label={t("common.table.operations")} style={{ width: 1 }} />}
          </Table.Tr>
        </Table.Thead>
        <Table.Tbody>
          {rows.map((row) => (
            <DependencyListTableRow key={row.id} row={row} operations={operations} onEdit={onEdit} onDelete={onDelete} />
          ))}
        </Table.Tbody>
      </Table>
    </ScrollRegion>
  );
}
