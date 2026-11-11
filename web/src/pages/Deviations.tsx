import { useRef } from "react";
import { Link as RouterLink, useSearchParams } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { Alert, Anchor, Badge, Button, Group, Stack, Text, Title, VisuallyHidden } from "@mantine/core";
import { IconGitCompare, IconLinkOff, IconPlugConnected } from "@tabler/icons-react";
import { useQuery } from "@tanstack/react-query";
import type { DeviationFilter, DeviationView } from "../api/deviations";
import { listJiraBindings } from "../api/jira";
import { useAdmin } from "../auth";
import { DeviationAckOrphanNotice } from "../components/DeviationAckCell";
import CapacityDeviationsSection from "../components/CapacityDeviationsSection";
import DeviationsFilters from "../components/DeviationsFilters";
import DeviationsSources from "../components/DeviationsSources";
import DeviationsTable from "../components/DeviationsTable";
import EmptyState from "../components/EmptyState";
import ErrorAlert from "../components/ErrorAlert";
import LoadingBlock from "../components/LoadingBlock";
import PageHeader from "../components/PageHeader";
import { useAcknowledge } from "../hooks/useAcknowledge";
import { useDeviations } from "../hooks/useDeviations";
import { hasStaleSource, itemAckKeys, verifiedAt } from "../utils/deviations";
import { formatDateTime } from "../utils/formatDate";
import { deviationFilterParams, deviationStatus, keepStatus, narrowingCount, parseDeviationFilter } from "../utils/deviationFilters";
import { jiraConnectionsPath } from "../utils/jiraLinks";

/** The empty list, told apart: no connection / nothing linked / the filters match nothing / agreement (only after successful refreshes) or merely "none so far". */
function EmptyList({ view, filter, onClear }: { view: DeviationView; filter: DeviationFilter; onClear: () => void }) {
  const { t } = useTranslation();
  const admin = useAdmin();
  const narrowed = narrowingCount(filter) > 0;
  // Only asked when it decides the wording: the list itself holds deviating bindings only, so it cannot say whether anything is linked at all.
  const linked = useQuery({
    queryKey: ["jira", "bindings", "count"],
    queryFn: () => listJiraBindings({ page: 1, pageSize: 1 }),
    enabled: view.connections.length > 0 && !narrowed,
  });
  if (view.connections.length === 0) {
    return (
      <Stack align="center" gap={0}>
        <EmptyState icon={IconPlugConnected} label={t("deviations.empty.noConnections")} />
        {admin ? (
          <Anchor component={RouterLink} to={jiraConnectionsPath} size="sm">
            {t("deviations.empty.noConnectionsAdmin")}
          </Anchor>
        ) : (
          <Text size="sm" c="dimmed">
            {t("deviations.empty.noConnectionsUser")}
          </Text>
        )}
      </Stack>
    );
  }
  // `totals.bindings` counts the filtered bindings, and with `all` in force (given, or implied by a project or team scope) that is every link in scope.
  // An acknowledgement filter lists a subset of those links, so only an unfiltered state can say there are none.
  const allApplies = filter.all ?? (filter.projectId !== undefined || filter.teamId !== undefined);
  if (narrowed && allApplies && filter.acknowledged === undefined && view.totals.bindings === 0) {
    return <EmptyState icon={IconLinkOff} label={t("deviations.empty.noBindingsScoped")} />;
  }
  if (narrowed) {
    return (
      <Stack align="center" gap="xs">
        <EmptyState icon={IconGitCompare} label={t("deviations.empty.noMatch")} />
        <Button variant="default" size="xs" onClick={onClear}>
          {t("deviations.filter.clearAll")}
        </Button>
      </Stack>
    );
  }
  // The open list is empty but the acknowledged items are only hidden: say so, and where they are, instead of the dated claim about the read.
  if (filter.acknowledged === undefined && !allApplies && view.totals.acknowledged > 0) {
    return <EmptyState icon={IconGitCompare} label={t("deviations.empty.noOpen")} hint={t("deviations.empty.noOpenHint", { count: view.totals.acknowledged })} />;
  }
  if (linked.data === undefined) return linked.isError ? <ErrorAlert error={linked.error} title={t("deviations.empty.countFailed")} /> : <LoadingBlock />;
  if (linked.data.total === 0) {
    return <EmptyState icon={IconLinkOff} label={t("deviations.empty.noBindings")} hint={admin ? t("deviations.empty.noBindingsAdminHint") : t("deviations.empty.noBindingsHint")} />;
  }
  // "No deviations" is a claim about a read, so it is DATED (the scheduler re-reads only the connections that poll; a manual-only one waits for
  // Refresh now) and withheld unless every connection is enabled, its mapping fits the site and its newest run succeeded.
  const readAt = verifiedAt(view.connections);
  return readAt === null ? (
    <EmptyState icon={IconGitCompare} label={t("deviations.empty.noneSoFar")} hint={t("deviations.empty.noneSoFarHint")} />
  ) : (
    <EmptyState icon={IconGitCompare} label={t("deviations.empty.noneSince", { time: formatDateTime(readAt) })} hint={t("deviations.empty.noneSinceHint")} />
  );
}

/** The totals under the heading: warnings (orange), infos (gray), gone and acknowledged items (gray) counted over every match, how many items are listed and, when the server cut the list, the note that says so. */
function Totals({ view, filter }: { view: DeviationView; filter: DeviationFilter }) {
  const { t } = useTranslation();
  const { totals } = view;
  return (
    <Stack gap="xs">
      <Group gap="sm" role="group" aria-label={t("deviations.list.title")}>
        <Badge color="orange" variant="light" tt="none">
          {t("deviations.totals.warnings", { count: totals.warnings })}
        </Badge>
        <Badge color="gray" variant="light" tt="none">
          {t("deviations.totals.infos", { count: totals.infos })}
        </Badge>
        {totals.gone > 0 && (
          <Badge color="gray" variant="light" tt="none">
            {t("deviations.totals.gone", { count: totals.gone })}
          </Badge>
        )}
        <Badge color="gray" variant="light" tt="none">
          {t("deviations.totals.acknowledged", { count: totals.acknowledged })}
        </Badge>
        <Text size="sm" c="dimmed">
          {t("deviations.totals.shown", { count: view.items.length })}
        </Text>
        <Text size="sm" c="dimmed">
          {t("deviations.asOf", { date: view.asOf })}
        </Text>
      </Group>
      {deviationStatus(filter) !== "open" && (
        // The figures count the OPEN items among the matches whatever the list shows (the server's basis), so they differ from the rows below.
        <Text size="xs" c="dimmed">
          {t("deviations.totals.openOnly")}
        </Text>
      )}
      {view.truncated && (
        <Alert color="orange" variant="light" role="note">
          {t("deviations.totals.truncated", { count: view.items.length })}
        </Alert>
      )}
    </Stack>
  );
}

/**
 * The Deviations page (`/deviations`, everyone): where the plan and the linked Jira items disagree, from `GET /views/deviations`. The filters
 * live in the URL (`?projectId=7&severity=WARNING`), so a chip's link, a reload and Back all restore them. It says how current the figures are
 * (the connections' newest runs, a failed one never reads as fresh), refetches on window focus and while a run is running. The owner of a linked
 * item (or, on a milestone, its team's manager, or an ADMIN) acknowledges its deviations line by line, or all at once, in the Deviations column (`useAcknowledge`: that write, unlike the Jira reads, re-reads the timeline
 * views too); a 409 `stale-deviations` is the inline note under the filters. Refresh now is the ADMIN's, per connection. After the Jira list comes **Capacity from Flow**, its own document and section (`CapacityDeviationsSection`; hidden without a Flow connection).
 */
export default function Deviations() {
  const { t } = useTranslation();
  const admin = useAdmin();
  const [params, setParams] = useSearchParams();
  const filter = parseDeviationFilter(params);
  const { data, isLoading, isError, error, dataUpdatedAt, isPlaceholderData } = useDeviations(filter);
  // The focus lands on the list's heading when no row of the list can take it (tabIndex -1: never a tab stop).
  const listHeading = useRef<HTMLHeadingElement>(null);
  const ack = useAcknowledge(listHeading, deviationFilterParams(filter).toString());

  const change = (patch: Partial<DeviationFilter>) => setParams(deviationFilterParams({ ...filter, ...keepStatus(filter, patch) }), { replace: true });

  return (
    <Stack gap="md">
      <PageHeader title={t("deviations.title")} description={t("deviations.intro")} />
      {isError && <ErrorAlert error={error} title={t("deviations.loadFailed")} />}
      {isLoading && !data && <LoadingBlock />}
      {data && (
        <>
          {data.connections.length > 0 && <DeviationsSources connections={data.connections} admin={admin} readAt={dataUpdatedAt} />}
          <Stack gap="md">
            <Title order={3} size="h4" ref={listHeading} tabIndex={-1}>
              {t("deviations.list.title")}
            </Title>
            {hasStaleSource(data.connections) && (
              <Alert color="orange" variant="light" role="note">
                {t("deviations.staleBanner")}
              </Alert>
            )}
            <DeviationsFilters filter={filter} connections={data.connections} onChange={change} />
            <Totals view={data} filter={filter} />
            <DeviationAckOrphanNotice ack={ack} listedKeys={new Set(data.items.flatMap((listed) => (listed.deviations.length > 0 ? itemAckKeys(listed) : [])))} />
            {isPlaceholderData ? (
              // The answer for these filters is still on its way: the kept one belongs to the previous filters, so it may not make an empty-state claim.
              <div role="status" aria-busy="true">
                <LoadingBlock />
                <VisuallyHidden>{t("deviations.loadingList")}</VisuallyHidden>
              </div>
            ) : data.items.length === 0 ? (
              <EmptyList view={data} filter={filter} onClear={() => setParams(new URLSearchParams(), { replace: true })} />
            ) : (
              <DeviationsTable items={data.items} connections={data.connections} now={dataUpdatedAt} ack={ack} />
            )}
          </Stack>
        </>
      )}
      {/* The second section, its own document: shown only when a Flow connection exists, and it takes the team and severity filters of the URL. */}
      <CapacityDeviationsSection filter={filter} admin={admin} />
    </Stack>
  );
}
