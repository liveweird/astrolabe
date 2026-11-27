import { useTranslation } from "react-i18next";
import { Link as RouterLink } from "react-router-dom";
import { Anchor, Badge, Group, Menu, Stack, Table, Text } from "@mantine/core";
import { IconPencil, IconTrash } from "@tabler/icons-react";
import type { TeamLoadRow, TeamLoadView } from "../api/teamLoad";
import type { TeamColour } from "../utils/teamColours";
import { entityPath, refOf } from "../utils/entityLinks";
import DestructiveMenuItem from "./DestructiveMenuItem";
import EntityLink from "./EntityLink";
import RowActionsMenu from "./RowActionsMenu";
import ScrollRegion from "./ScrollRegion";
import SortHeader, { type SortDir } from "./SortHeader";
import TeamSwatch from "./TeamSwatch";

/** One orange warning badge, only while positive (a zero figure is not a claim); `text` is the worded figure. */
function WarningBadge({ text }: { text: string | null }) {
  return text === null ? null : (
    <Badge color="orange" tt="none">
      {text}
    </Badge>
  );
}

/** The facts line: the totals exactly as the server counted them over EVERY team (never recounted from the rows a filter or the cap left). */
export function TeamsFacts({ totals }: { totals: TeamLoadView["totals"] }) {
  const { t } = useTranslation();
  return (
    <Group gap="md" role="group" aria-label={t("teams.factsAria")}>
      <Text size="sm">{t("teamLoad.facts.teams", { count: totals.teams })}</Text>
      <Text size="sm">{t("home.plan.notScheduled", { count: totals.unscheduledMilestones })}</Text>
      <WarningBadge text={totals.overloadedTeams > 0 ? t("home.roadmap.overloadedTeams", { count: totals.overloadedTeams }) : null} />
      <WarningBadge text={totals.wipExceededTeams > 0 ? t("home.roadmap.wipTeams", { count: totals.wipExceededTeams }) : null} />
    </Group>
  );
}

type RowProps = {
  row: TeamLoadRow;
  colour: TeamColour | undefined;
  /** ADMIN: the row's kebab (Edit, Delete). A UX gate only; the server decides. */
  admin: boolean;
  onEdit: (row: TeamLoadRow) => void;
  onDelete: (row: TeamLoadRow) => void;
};

function TeamRow({ row, colour, admin, onEdit, onDelete }: RowProps) {
  const { t } = useTranslation();
  return (
    <Table.Tr>
      <Table.Td>
        <Stack gap={0}>
          {/* The name is the way into the team page - a real link (the detail-link rule); its colour swatch stands before it. */}
          <Group gap="xs" wrap="nowrap">
            <TeamSwatch colour={colour} />
            <EntityLink entity={{ kind: "team", id: row.id }} name={row.name} size="sm" fw={500} />
          </Group>
          {row.description !== null && row.description !== "" && (
            <Text size="xs" c="dimmed" lineClamp={1}>
              {row.description}
            </Text>
          )}
        </Stack>
      </Table.Td>
      <Table.Td>
        <Text size="sm" c={row.managerName === null ? "dimmed" : undefined}>
          {row.managerName === null ? t("teams.noManager") : <EntityLink entity={refOf("person", row.managerPersonId)} name={row.managerName} />}
        </Text>
      </Table.Td>
      <Table.Td ta="right">
        <Text size="sm">{row.milestones}</Text>
      </Table.Td>
      <Table.Td ta="right">
        {row.unscheduledMilestones > 0 ? (
          <Anchor
            component={RouterLink}
            to={entityPath({ kind: "team", id: row.id })}
            size="sm"
            aria-label={t("teamLoad.notScheduledAria", { count: row.unscheduledMilestones, name: row.name })}
          >
            {row.unscheduledMilestones}
          </Anchor>
        ) : (
          <Text size="sm">{row.unscheduledMilestones}</Text>
        )}
      </Table.Td>
      <Table.Td>
        <WarningBadge text={row.overloadedWeeks > 0 ? t("teams.view.overloadedWeeks", { count: row.overloadedWeeks }) : null} />
      </Table.Td>
      <Table.Td>
        <WarningBadge text={row.wipExceededWeeks > 0 ? t("teams.view.wipWeeks", { count: row.wipExceededWeeks }) : null} />
      </Table.Td>
      <Table.Td>
        {row.weeksWithoutCapacity > 0 && (
          <Badge color="gray" tt="none">
            {t("teamLoad.withoutCapacity", { count: row.weeksWithoutCapacity })}
          </Badge>
        )}
      </Table.Td>
      {admin && (
        <Table.Td style={{ width: 1 }} ta="right">
          <RowActionsMenu label={t("common.table.operationsAria", { name: row.name })}>
            <Menu.Item leftSection={<IconPencil size={14} />} onClick={() => onEdit(row)} aria-label={t("common.action.editAria", { name: row.name })}>
              {t("common.action.edit")}
            </Menu.Item>
            <Menu.Divider />
            <DestructiveMenuItem
              leftSection={<IconTrash size={14} />}
              onClick={() => onDelete(row)}
              aria-label={t("common.action.deleteAria", { name: row.name })}
            >
              {t("common.action.delete")}
            </DestructiveMenuItem>
          </RowActionsMenu>
        </Table.Td>
      )}
    </Table.Tr>
  );
}

/**
 * The Teams table (1.32): one row per team of the team-load document, in the order given - the name (swatch, link, the description under it), the manager,
 * the milestones, the ones not scheduled, the three week counts, and an ADMIN's row menu. Only the name sorts (the page reverses the document's order).
 */
export default function TeamsTable({
  rows,
  colours,
  admin,
  sortDir,
  onToggleSort,
  onEdit,
  onDelete,
}: {
  rows: readonly TeamLoadRow[];
  colours: ReadonlyMap<number, TeamColour>;
  admin: boolean;
  sortDir: SortDir;
  onToggleSort: () => void;
  onEdit: (row: TeamLoadRow) => void;
  onDelete: (row: TeamLoadRow) => void;
}) {
  const { t } = useTranslation();
  return (
    <ScrollRegion label={t("teams.title")} minWidth={960}>
      <Table aria-label={t("teams.title")}>
        <Table.Thead>
          <Table.Tr>
            <SortHeader field="name" label={t("common.field.name")} activeField="name" activeDir={sortDir} onToggle={onToggleSort} />
            <Table.Th>{t("teams.column.manager")}</Table.Th>
            <Table.Th ta="right">{t("home.mine.column.milestones")}</Table.Th>
            <Table.Th ta="right">{t("home.mine.column.notScheduled")}</Table.Th>
            <Table.Th>{t("teamLoad.column.overloaded")}</Table.Th>
            <Table.Th>{t("teamLoad.column.wip")}</Table.Th>
            <Table.Th>{t("teamLoad.column.capacity")}</Table.Th>
            {admin && <Table.Th aria-label={t("common.table.operations")} style={{ width: 1 }} />}
          </Table.Tr>
        </Table.Thead>
        <Table.Tbody>
          {rows.map((row) => (
            <TeamRow key={row.id} row={row} colour={colours.get(row.id)} admin={admin} onEdit={onEdit} onDelete={onDelete} />
          ))}
        </Table.Tbody>
      </Table>
    </ScrollRegion>
  );
}
