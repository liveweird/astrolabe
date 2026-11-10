import { useRef } from "react";
import { Link as RouterLink } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { Alert, Anchor, Badge, Group, Stack, Table, Text, Title, VisuallyHidden } from "@mantine/core";
import { IconGitCompare, IconLinkOff } from "@tabler/icons-react";
import { useQueries } from "@tanstack/react-query";
import type { CapacityDeviationItem, CapacityDeviationView } from "../api/capacityDeviations";
import type { DeviationFilter } from "../api/deviations";
import { listFlowTeams } from "../api/flow";
import { useCapacityAcknowledge, type CapacityAcknowledge } from "../hooks/useCapacityAcknowledge";
import { useCapacityDeviations } from "../hooks/useCapacityDeviations";
import { capacityAckKey, hasStaleFlowSource, staleFlowConnection, verifiedFlowAt } from "../utils/capacityDeviations";
import { ageText } from "../utils/deviations";
import { deviationStatus } from "../utils/deviationFilters";
import { formatDateTime } from "../utils/formatDate";
import { teamPath } from "../utils/teamLinks";
import { CapacityAckOrphanNotice } from "./CapacityAckCell";
import CapacityDeviationList from "./CapacityDeviationList";
import CapacityDeviationsSources from "./CapacityDeviationsSources";
import EmptyState from "./EmptyState";
import ErrorAlert from "./ErrorAlert";
import LoadingBlock from "./LoadingBlock";
import ScrollRegion from "./ScrollRegion";

/**
 * The only Deviations-page filters this section takes: the team, the severity and the Status (`acknowledged`, `all`) mean the same here as in the
 * Jira list - Open, Acknowledged and All list the sprint rows by their own acknowledgement.
 */
const SHARED_FILTERS = new Set(["teamId", "severity", "acknowledged", "all"]);

/** Whether the page's URL holds a filter this section cannot honour (the Jira list's Status, plan item, kind and connection filters). */
function ignoresSomeFilter(filter: DeviationFilter): boolean {
  return Object.entries(filter).some(([key, value]) => value !== undefined && !SHARED_FILTERS.has(key));
}

/**
 * An empty section, told apart: no team is linked to Flow (asked of the connections' own team lists, the cache the connection pages share, and only
 * when it decides the wording), or every linked team is in line - a claim about a READ, so it is DATED and withheld unless every connection is
 * enabled and current.
 */
function EmptyAgreement({ view }: { view: CapacityDeviationView }) {
  const { t } = useTranslation();
  const lists = useQueries({
    queries: view.connections.map((connection) => ({ queryKey: ["flow", "teams", connection.id], queryFn: () => listFlowTeams(connection.id) })),
  });
  const failed = lists.find((list) => list.isError);
  if (failed) return <ErrorAlert error={failed.error} title={t("deviations.flowSection.empty.countFailed")} />;
  if (lists.some((list) => list.data === undefined)) return <LoadingBlock />;
  if (lists.every((list) => list.data?.items.every((team) => team.bindingId === null))) {
    return <EmptyState icon={IconLinkOff} label={t("deviations.flowSection.empty.noneLinked")} hint={t("deviations.flowSection.empty.noneLinkedHint")} />;
  }
  const readAt = verifiedFlowAt(view.connections);
  return readAt === null ? (
    <EmptyState icon={IconGitCompare} label={t("deviations.flowSection.empty.inLineSoFar")} hint={t("deviations.flowSection.empty.inLineSoFarHint")} />
  ) : (
    <EmptyState icon={IconGitCompare} label={t("deviations.flowSection.empty.inLineSince", { time: formatDateTime(readAt) })} hint={t("deviations.flowSection.empty.inLineSinceHint")} />
  );
}

/**
 * The totals under the heading: warnings (orange), infos (gray), the teams gone from Flow (orange: they are among the warnings), the acknowledged rows
 * (gray; the figures before it count OPEN rows whatever Status lists), how many teams are listed (of how many matched, when the list was cut) and, when
 * the server cut the list, the note that says so.
 */
function Totals({ view, status }: { view: CapacityDeviationView; status: ReturnType<typeof deviationStatus> }) {
  const { t } = useTranslation();
  const { totals } = view;
  return (
    <Stack gap="xs">
      <Group gap="sm" role="group" aria-label={t("deviations.flowSection.list.title")}>
        <Badge color="orange" variant="light" tt="none">
          {t("deviations.totals.warnings", { count: totals.warnings })}
        </Badge>
        <Badge color="gray" variant="light" tt="none">
          {t("deviations.totals.infos", { count: totals.infos })}
        </Badge>
        {totals.gone > 0 && (
          // `totals.warnings` already counts these (a gone team is one WARNING row), so the badge reads as part of them.
          <Badge color="orange" variant="light" tt="none">
            {t("deviations.flowSection.totals.gone", { count: totals.gone })}
          </Badge>
        )}
        <Badge color="gray" variant="light" tt="none">
          {t("deviations.flowSection.totals.acknowledged", { count: totals.acknowledged })}
        </Badge>
        <Text size="sm" c="dimmed">
          {view.truncated ? t("deviations.flowSection.totals.shownOf", { n: view.items.length, total: totals.teams }) : t("deviations.flowSection.totals.shown", { count: view.items.length })}
        </Text>
      </Group>
      {status !== "open" && (
        // The figures count the OPEN rows among the matches whatever the list shows (the server's basis), so they differ from the rows below.
        <Text size="xs" c="dimmed">
          {t("deviations.totals.openOnly")}
        </Text>
      )}
      {view.truncated && (
        <Alert color="orange" variant="light" role="note">
          {t("deviations.flowSection.totals.truncated", { count: view.items.length })}
        </Alert>
      )}
    </Stack>
  );
}

/** Whether the row's connection is disabled or not CURRENT: its figures are what was last read. */
function isStale(view: CapacityDeviationView, item: CapacityDeviationItem): boolean {
  const connection = view.connections.find((candidate) => candidate.id === item.connectionId);
  return connection !== undefined && staleFlowConnection(connection);
}

/** One team per row: the team (a link), its Flow team (with the connection's name when there are several), the differences (each with its acknowledge cell, by the item's `can`) and when the Flow team was last seen. */
function TeamsTable({ view, now, hook }: { view: CapacityDeviationView; now: number; hook: CapacityAcknowledge }) {
  const { t } = useTranslation();
  const label = t("deviations.flowSection.list.tableAria");
  const connectionName = (item: CapacityDeviationItem) => (view.connections.length > 1 ? view.connections.find((connection) => connection.id === item.connectionId)?.name : undefined);
  return (
    <ScrollRegion label={label} minWidth={900}>
      <Table aria-label={label}>
        <Table.Thead>
          <Table.Tr>
            <Table.Th>{t("deviations.flowSection.list.column.team")}</Table.Th>
            <Table.Th>{t("deviations.flowSection.list.column.flowTeam")}</Table.Th>
            <Table.Th>{t("deviations.flowSection.list.column.differences")}</Table.Th>
            <Table.Th>{t("deviations.flowSection.list.column.observed")}</Table.Th>
          </Table.Tr>
        </Table.Thead>
        <Table.Tbody>
          {view.items.map((item) => (
            <Table.Tr key={item.bindingId}>
              <Table.Td>
                <Anchor component={RouterLink} to={teamPath(item.team.id)} size="sm" fw={500} aria-label={t("deviations.flowSection.list.openTeamAria", { name: item.team.name })}>
                  {item.team.name}
                </Anchor>
              </Table.Td>
              <Table.Td>
                <Text size="sm">{item.flowTeam.name}</Text>
                {connectionName(item) && (
                  <Text size="xs" c="dimmed">
                    {connectionName(item)}
                  </Text>
                )}
              </Table.Td>
              <Table.Td>
                <CapacityDeviationList deviations={item.deviations} ack={{ can: item.can, bindingId: item.bindingId, hook }} />
              </Table.Td>
              <Table.Td>
                {item.observedAt === null ? (
                  "—"
                ) : (
                  <Text size="sm" title={formatDateTime(item.observedAt)}>
                    {ageText(item.observedAt, now, t)}
                  </Text>
                )}
                {isStale(view, item) && (
                  // The Jira table's mark: the connection is disabled or has no current refresh behind it, so the row shows what was last read.
                  <Text size="xs" c="dimmed">
                    {t("deviations.observed.stale")}
                  </Text>
                )}
              </Table.Td>
            </Table.Tr>
          ))}
        </Table.Tbody>
      </Table>
    </ScrollRegion>
  );
}

/**
 * The Deviations page's second section, **Capacity from Flow** (`GET /views/capacity-deviations`, its own document under `["flow","deviations"]`):
 * where a linked team's capacity in the plan differs from what Flow says, per current or future sprint. It is shown only when there is a Flow
 * connection (a Jira-only stack sees nothing new), takes the page's team, severity and Status filters (the rest are the Jira list's and are named as not
 * applying), says how current the figures are (the connections' derived state, a dated "in line" claim) and refreshes the same way the Jira
 * section does. A team's sprints without capacity are one folded line (`CapacityDeviationList`). The team's manager or an ADMIN (the item's
 * `can.acknowledge`) acknowledges ONE sprint at a time (`useCapacityAcknowledge`); Import capacity… on the team's page is the other remedy.
 */
export default function CapacityDeviationsSection({ filter, admin }: { filter: DeviationFilter; admin: boolean }) {
  const { t } = useTranslation();
  const own = { teamId: filter.teamId, severity: filter.severity, acknowledged: filter.acknowledged, all: filter.all };
  const { data, isError, error, dataUpdatedAt, isPlaceholderData } = useCapacityDeviations(own);
  // The focus lands on the list's heading when no row of the list can take it (tabIndex -1: never a tab stop).
  const listHeading = useRef<HTMLHeadingElement>(null);
  const ack = useCapacityAcknowledge(listHeading, JSON.stringify(own));
  if (data === undefined) {
    return isError ? (
      <Stack gap="xs">
        <Title order={3} size="h4">
          {t("deviations.flowSection.title")}
        </Title>
        <ErrorAlert error={error} title={t("deviations.flowSection.loadFailed")} />
      </Stack>
    ) : null;
  }
  // Jira-only stack: nothing of this section exists.
  if (data.connections.length === 0) return null;
  const status = deviationStatus(own);
  const narrowed = own.teamId !== undefined || own.severity !== undefined || own.acknowledged === true;
  const listedKeys = new Set(data.items.flatMap((item) => item.deviations.map((row) => capacityAckKey(item.bindingId, row.detail.sprintId))));

  return (
    <Stack gap="md">
      <Stack gap={4}>
        <Title order={3} size="h4">
          {t("deviations.flowSection.title")}
        </Title>
        <Text size="sm" c="dimmed">
          {t("deviations.flowSection.intro")}
        </Text>
      </Stack>
      {isError && (
        // A failed re-read keeps what was read (the content below is the last answer), but never silently.
        <ErrorAlert error={error} title={t("deviations.flowSection.loadFailed")} />
      )}
      <CapacityDeviationsSources connections={data.connections} admin={admin} readAt={dataUpdatedAt} />
      {hasStaleFlowSource(data.connections) && (
        <Alert color="orange" variant="light" role="note">
          {t("deviations.flowSection.staleBanner")}
        </Alert>
      )}
      {ignoresSomeFilter(filter) && (
        <Text size="sm" c="dimmed" role="note">
          {t("deviations.flowSection.filtersNote")}
        </Text>
      )}
      <Stack gap="xs">
        <Title order={4} size="h5" ref={listHeading} tabIndex={-1}>{t("deviations.flowSection.list.title")}</Title>
        <Totals view={data} status={status} />
      </Stack>
      <CapacityAckOrphanNotice hook={ack} listedKeys={listedKeys} />
      {isPlaceholderData ? (
        // The answer for these filters is still on its way: the kept one belongs to the previous filters, so it may not make an empty-state claim.
        <div role="status" aria-busy="true">
          <LoadingBlock />
          <VisuallyHidden>{t("deviations.loadingList")}</VisuallyHidden>
        </div>
      ) : data.items.length > 0 ? (
        <TeamsTable view={data} now={dataUpdatedAt} hook={ack} />
      ) : data.totals.acknowledged > 0 && status === "open" ? (
        // Acknowledged rows are hidden by Open: "nothing open" is a claim about the open rows, never "in line with Flow" while sprints still differ.
        <EmptyState icon={IconGitCompare} label={t("deviations.flowSection.empty.noOpen")} hint={t("deviations.flowSection.empty.noOpenHint", { count: data.totals.acknowledged })} />
      ) : narrowed ? (
        <EmptyState icon={IconGitCompare} label={t("deviations.flowSection.empty.noMatch")} />
      ) : (
        <EmptyAgreement view={data} />
      )}
    </Stack>
  );
}
