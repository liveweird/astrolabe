import { Anchor, Stack, Table, Text, Title } from "@mantine/core";
import { useTranslation } from "react-i18next";
import { Link as RouterLink } from "react-router-dom";
import type { TeamLoadRow } from "../api/teamLoad";
import { matchesWeek, type TeamLoadWarning } from "../utils/teamLoadFilters";
import { teamPath } from "../utils/teamLinks";
import { mdText, weekLabel } from "../utils/weekLoadText";
import ScrollRegion from "./ScrollRegion";
import { WeekStatus } from "./WeekLoadCells";

const NO_WRAP = { whiteSpace: "nowrap" } as const;
const TABLE_MAX_HEIGHT = 420;

/**
 * The Team load page's second table: the weeks BEHIND the two warning figures, one row per team and week the team's page marks overloaded or over
 * the WIP limit, in the document's order (team by team, oldest week first). `rows` are the teams the page's "Show" filter keeps; `warning` narrows
 * their listed weeks the same way. The cells are the team page's own (`WeekLoadCells.tsx`), shown as they arrive. Nothing renders when no week is
 * left (zero is no claim: the document lists only warning weeks, and a cut list is the page's own line). `from` (1.22) is the document's current week:
 * the weeks before it are not listed and the sentence says from which week the list runs; unset, every listed week shows.
 */
export default function TeamLoadWeeks({
  rows,
  warning,
  from,
}: {
  rows: readonly TeamLoadRow[];
  warning: TeamLoadWarning | undefined;
  from?: string;
}) {
  const { t } = useTranslation();
  const weeks = rows.flatMap((row) => row.warningWeeks.filter((week) => matchesWeek(week, warning, from)).map((week) => ({ row, week })));
  if (weeks.length === 0) return null;
  return (
    <Stack gap="xs">
      <Title order={3} size="h4">
        {t("teamLoad.weeks.title")}
      </Title>
      <Text size="sm" c="dimmed">
        {from === undefined ? t("teamLoad.weeks.intro") : t("teamLoad.weeks.introFrom", { week: weekLabel(from) })}
      </Text>
      <ScrollRegion label={t("teamLoad.weeks.tableAria")} minWidth={720} maxHeight={TABLE_MAX_HEIGHT}>
        <Table aria-label={t("teamLoad.weeks.tableAria")} stickyHeader>
          <Table.Thead>
            <Table.Tr>
              <Table.Th>{t("project.column.team")}</Table.Th>
              <Table.Th>{t("teams.view.week")}</Table.Th>
              <Table.Th>{t("teams.view.load")}</Table.Th>
              <Table.Th>{t("teams.view.capacity")}</Table.Th>
              <Table.Th>{t("teams.view.wip")}</Table.Th>
              <Table.Th>{t("teams.view.statusColumn")}</Table.Th>
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {weeks.map(({ row, week }) => (
              <Table.Tr key={`${row.id}-${week.weekStart}`}>
                <Table.Td>
                  <Anchor component={RouterLink} to={teamPath(row.id)} size="sm" fw={500} aria-label={t("teams.openAria", { name: row.name })}>
                    {row.name}
                  </Anchor>
                </Table.Td>
                <Table.Td style={NO_WRAP}>{weekLabel(week.weekStart)}</Table.Td>
                <Table.Td>{mdText(week.load)}</Table.Td>
                <Table.Td>{week.capacity === null ? "—" : mdText(week.capacity)}</Table.Td>
                <Table.Td>{week.maxWip}</Table.Td>
                <Table.Td style={NO_WRAP}>
                  <WeekStatus week={week} />
                </Table.Td>
              </Table.Tr>
            ))}
          </Table.Tbody>
        </Table>
      </ScrollRegion>
    </Stack>
  );
}
