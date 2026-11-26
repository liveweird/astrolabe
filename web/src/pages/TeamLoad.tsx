import { useTranslation } from "react-i18next";
import { Link as RouterLink, useSearchParams } from "react-router-dom";
import { Anchor, Badge, Button, Group, Select, Stack, Switch, Table, Text } from "@mantine/core";
import { IconUsersGroup } from "@tabler/icons-react";
import { useQuery } from "@tanstack/react-query";
import { getTeamLoadView, TEAM_LOAD_KEY, type TeamLoadRow, type TeamLoadView } from "../api/teamLoad";
import EmptyState from "../components/EmptyState";
import ErrorAlert from "../components/ErrorAlert";
import FilterPanel from "../components/FilterPanel";
import LoadingBlock from "../components/LoadingBlock";
import PageHeader from "../components/PageHeader";
import ScrollRegion from "../components/ScrollRegion";
import TeamLoadWeeks from "../components/TeamLoadWeeks";
import TeamSwatch from "../components/TeamSwatch";
import { useTeamColours } from "../hooks/useTeamColours";
import { earlierWeekCount, matchesWarning, parseTeamLoadFilter, teamLoadFilterParams } from "../utils/teamLoadFilters";
import { teamPath } from "../utils/teamLinks";
import type { TeamColour } from "../utils/teamColours";

const CHOICES = ["all", "overloaded", "wip", "any"] as const;
type Choice = (typeof CHOICES)[number];

/** One orange warning badge, only while positive (a zero figure is not a claim); `text` is the worded figure. */
function WarningBadge({ text }: { text: string | null }) {
  return text === null ? null : (
    <Badge color="orange" tt="none">
      {text}
    </Badge>
  );
}

/** The facts line: the totals exactly as the server counted them over EVERY team (never recounted from the rows a filter or the cap left). */
function TeamLoadFacts({ totals }: { totals: TeamLoadView["totals"] }) {
  const { t } = useTranslation();
  return (
    <Group gap="md" role="group" aria-label={t("teamLoad.factsAria")}>
      <Text size="sm">{t("teamLoad.facts.teams", { count: totals.teams })}</Text>
      <Text size="sm">{t("home.plan.notScheduled", { count: totals.unscheduledMilestones })}</Text>
      <WarningBadge text={totals.overloadedTeams > 0 ? t("home.roadmap.overloadedTeams", { count: totals.overloadedTeams }) : null} />
      <WarningBadge text={totals.wipExceededTeams > 0 ? t("home.roadmap.wipTeams", { count: totals.wipExceededTeams }) : null} />
    </Group>
  );
}

function TeamLoadTableRow({ row, colour }: { row: TeamLoadRow; colour: TeamColour | undefined }) {
  const { t } = useTranslation();
  return (
    <Table.Tr>
      <Table.Td>
        <Group gap="xs" wrap="nowrap">
          <TeamSwatch colour={colour} />
          <Anchor component={RouterLink} to={teamPath(row.id)} size="sm" fw={500} aria-label={t("teams.openAria", { name: row.name })}>
            {row.name}
          </Anchor>
        </Group>
      </Table.Td>
      <Table.Td>
        <Text size="sm" c={row.managerName === null ? "dimmed" : undefined}>
          {row.managerName ?? t("teams.noManager")}
        </Text>
      </Table.Td>
      <Table.Td ta="right">
        <Text size="sm">{row.milestones}</Text>
      </Table.Td>
      <Table.Td ta="right">
        {row.unscheduledMilestones > 0 ? (
          <Anchor
            component={RouterLink}
            to={teamPath(row.id)}
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
    </Table.Tr>
  );
}

/**
 * The Team load page (`/team-load`, everyone, read-only): every team with its milestones, how many are not scheduled, its overloaded weeks, its weeks
 * over the WIP limit and its weeks without any capacity, from the one unpaged `GET /views/team-load` (at most 200 rows; the figures are the team
 * page's own, shown as they arrive). The "warning" filter is in the URL (`utils/teamLoadFilters.ts`; a change `replace`s the entry, so Home's two
 * capacity badges, a reload and Back all restore the view) and only hides rows: the facts line always shows the totals over every team. Under the
 * teams table, "Weeks with a warning" (`components/TeamLoadWeeks.tsx`) lists the weeks behind the two warning figures from the same document
 * (1.21); it follows the filter, is absent when no week is left (never a "no warnings" claim) and a cut document says so in one line. Since 1.22 it
 * lists the weeks from the DOCUMENT's `currentWeekStart` on (the server's Monday, never the browser's clock); the "Include past weeks" switch
 * (`?past=true`) brings the earlier ones back, and while they are hidden one dimmed line counts them. The date only hides listed weeks: the teams
 * table's counts, the facts line and Home's figures still count every week.
 */
export default function TeamLoad() {
  const { t } = useTranslation();
  const [params, setParams] = useSearchParams();
  const filter = parseTeamLoadFilter(params);
  const { data, isLoading, isError, error } = useQuery({ queryKey: TEAM_LOAD_KEY, queryFn: getTeamLoadView });
  const colours = useTeamColours();

  const choose = (choice: Choice) => setParams(teamLoadFilterParams({ ...filter, warning: choice === "all" ? undefined : choice }), { replace: true });
  const choosePast = (past: boolean) => setParams(teamLoadFilterParams({ ...filter, past: past ? true : undefined }), { replace: true });
  const rows = (data?.teams ?? []).filter((row) => matchesWarning(row, filter.warning));
  // The weeks the page lists start at the document's own current week (the server's), unless the switch asks for the earlier ones.
  const from = filter.past === true ? undefined : data?.currentWeekStart;
  const hiddenWeeks = data === undefined || from === undefined ? 0 : earlierWeekCount(rows, filter.warning, from);
  // An empty list is a claim about a READ: made only from an answer, never over a failed refresh.
  const settled = data !== undefined && !isError;

  return (
    <Stack gap="md">
      <PageHeader title={t("teamLoad.title")} description={t("teamLoad.intro")} />

      <FilterPanel activeFilterCount={(filter.warning === undefined ? 0 : 1) + (filter.past === true ? 1 : 0)} storageKey="teamLoad">
        <Select
          label={t("teamLoad.filter.warning")}
          data={CHOICES.map((choice) => ({ value: choice, label: t(`teamLoad.warning.${choice}`) }))}
          value={filter.warning ?? "all"}
          onChange={(selected) => selected !== null && choose(selected as Choice)}
          allowDeselect={false}
        />
        <Switch label={t("teamLoad.filter.past")} checked={filter.past === true} onChange={(event) => choosePast(event.currentTarget.checked)} pb={6} />
      </FilterPanel>

      {isError && <ErrorAlert error={error} title={t("teamLoad.loadFailed")} />}
      {isLoading && <LoadingBlock />}
      {data && <TeamLoadFacts totals={data.totals} />}

      {settled && data.totals.teams === 0 && <EmptyState icon={IconUsersGroup} label={t("teamLoad.empty")} />}
      {settled && !data.truncated && data.totals.teams > 0 && rows.length === 0 && (
        <Stack gap="sm" align="center">
          <EmptyState icon={IconUsersGroup} label={t("teamLoad.noMatch")} />
          <Button variant="default" size="compact-sm" onClick={() => choose("all")}>
            {t("teamLoad.showAll")}
          </Button>
        </Stack>
      )}
      {data && rows.length > 0 && (
        <ScrollRegion label={t("teamLoad.tableAria")} minWidth={900}>
          <Table aria-label={t("teamLoad.tableAria")}>
            <Table.Thead>
              <Table.Tr>
                <Table.Th>{t("project.column.team")}</Table.Th>
                <Table.Th>{t("teams.column.manager")}</Table.Th>
                <Table.Th ta="right">{t("home.mine.column.milestones")}</Table.Th>
                <Table.Th ta="right">{t("home.mine.column.notScheduled")}</Table.Th>
                <Table.Th>{t("teamLoad.column.overloaded")}</Table.Th>
                <Table.Th>{t("teamLoad.column.wip")}</Table.Th>
                <Table.Th>{t("teamLoad.column.capacity")}</Table.Th>
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {rows.map((row) => (
                <TeamLoadTableRow key={row.id} row={row} colour={colours.get(row.id)} />
              ))}
            </Table.Tbody>
          </Table>
        </ScrollRegion>
      )}
      {data?.truncated && (
        <Text size="sm" c="dimmed">
          {t("teamLoad.truncated", { count: data.teams.length })}
        </Text>
      )}
      {data && <TeamLoadWeeks rows={rows} warning={filter.warning} from={from} />}
      {hiddenWeeks > 0 && (
        // Shown whether or not the section is: a team with "3 weeks overloaded" and no week below is never a riddle.
        <Text size="sm" c="dimmed">
          {t("teamLoad.weeks.earlier", { count: hiddenWeeks })}
        </Text>
      )}
      {data?.warningWeeksTruncated && (
        // Whenever the document was cut, also when the section is absent or short: an absent list is never read as "none".
        <Text size="sm" c="dimmed">
          {t("teamLoad.weeks.truncated", { count: data.teams.reduce((sum, row) => sum + row.warningWeeks.length, 0) })}
        </Text>
      )}
    </Stack>
  );
}
