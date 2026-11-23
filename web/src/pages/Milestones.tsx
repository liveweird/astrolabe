import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Link as RouterLink, useSearchParams } from "react-router-dom";
import { Anchor, Button, Group, Stack, Table, Text } from "@mantine/core";
import { useDebouncedValue } from "@mantine/hooks";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { IconTimelineEvent } from "@tabler/icons-react";
import { listMilestones } from "../api/milestones";
import MilestonesFilters from "../components/MilestonesFilters";
import PageHeader from "../components/PageHeader";
import RegistryListTable from "../components/RegistryListTable";
import SortHeader from "../components/SortHeader";
import { FILTER_DEBOUNCE_MS, useClampPage, usePagedSort } from "../hooks/usePagedSort";
import { milestoneFilterParams, narrowingCount, parseMilestoneFilter, type MilestoneFilter } from "../utils/milestoneFilters";
import { projectPath } from "../utils/planLinks";
import { teamPath } from "../utils/teamLinks";

const SORT_FIELDS = ["name", "projectName", "teamName"] as const;
type SortField = (typeof SORT_FIELDS)[number];

const SETTINGS_KEY = "milestones";
const COLUMN_COUNT = 6;

/**
 * The Milestones page (`/milestones`, everyone): every milestone of the plan from the paged `GET /milestones`, with the Schedule (All / Not
 * scheduled / Scheduled), team, project and name filters in the URL (`utils/milestoneFilters.ts`; a change `replace`s the entry, so a link from
 * Home, a reload and Back all restore the view). It lists and links; a milestone has no page of its own, so its project and team names are the
 * ways in, and the dates are set on the team's page.
 */
export default function Milestones() {
  const { t } = useTranslation();
  const [params, setParams] = useSearchParams();
  const filter = parseMilestoneFilter(params);
  const urlName = filter.name ?? "";

  // The typed text is authoritative: the input keeps it as typed (a trailing space included), the URL gets it trimmed at once, the request waits
  // 300 ms. `pending` lists what the input wrote that the URL has not echoed yet, so an echo (even a late one, after more typing) never overwrites
  // the text; a URL value that is not one of them came from outside (Back, a link, "Clear the filters") and replaces it - during render, effect-free.
  const [typed, setTyped] = useState(urlName);
  const [pending, setPending] = useState<string[]>([]);
  const [seenName, setSeenName] = useState(urlName);
  if (urlName !== seenName) {
    setSeenName(urlName);
    const echoed = pending.indexOf(urlName);
    if (echoed >= 0) {
      setPending(pending.slice(echoed + 1));
    } else {
      setPending([]);
      setTyped(urlName);
    }
  }
  const [debouncedName] = useDebouncedValue(typed.trim(), FILTER_DEBOUNCE_MS);

  const { page, setPage, pageSize, setPageSize, sortField, sortDir, sortParam, toggleSort } = usePagedSort<SortField>(
    "projectName",
    [debouncedName, filter.scheduled, filter.teamId, filter.projectId],
    { key: SETTINGS_KEY, sortFields: SORT_FIELDS },
  );

  // Under ["plan"]: a schedule or plan write made elsewhere in the tab refreshes the list. The dependency pickers' own reads are not this key.
  const { data, isLoading, isError, error, isPlaceholderData } = useQuery({
    queryKey: ["plan", "milestones", "list", page, pageSize, sortParam, filter.scheduled ?? null, filter.teamId ?? null, filter.projectId ?? null, debouncedName],
    queryFn: () =>
      listMilestones({
        page,
        pageSize,
        sort: sortParam,
        name: debouncedName || undefined,
        scheduled: filter.scheduled,
        teamId: filter.teamId,
        projectId: filter.projectId,
      }),
    placeholderData: keepPreviousData,
  });
  useClampPage(page, pageSize, setPage, data, isPlaceholderData);

  // The name written is the typed one, not the URL's (which may still lag a keystroke), so a select never undoes typing.
  const change = (patch: Partial<MilestoneFilter>) =>
    setParams(milestoneFilterParams({ ...filter, name: typed.trim() || undefined, ...patch }), { replace: true });
  const writeName = (value: string) => {
    const trimmed = value.trim();
    setTyped(value);
    if (trimmed !== (pending.at(-1) ?? urlName)) setPending([...pending, trimmed]);
    change({ name: value });
  };
  const narrowing = narrowingCount(filter) > 0;
  const rows = data?.items ?? [];
  // While a re-read runs, `data` is the PREVIOUS filters' answer (keepPreviousData): its rows may stay on screen, but neither its count nor an
  // empty list may be claimed for the filters now in the URL.
  const settled = Boolean(data) && !isPlaceholderData;
  const awaitingEmpty = isPlaceholderData && rows.length === 0;

  return (
    <Stack gap="md">
      <PageHeader title={t("milestoneList.title")} description={t("milestoneList.intro")} />

      <MilestonesFilters
        filter={filter}
        name={typed}
        onName={writeName}
        onChange={change}
      />

      {data && settled && (
        <Group gap="sm">
          <Text size="sm" c="dimmed">
            {t("milestoneList.count", { count: data.total })}
          </Text>
          {rows.length === 0 && narrowing && (
            <Button variant="default" size="compact-xs" onClick={() => setParams(new URLSearchParams(), { replace: true })}>
              {t("milestoneList.clear")}
            </Button>
          )}
        </Group>
      )}

      <RegistryListTable
        label={t("milestoneList.title")}
        errorTitle={t("milestoneList.loadFailed")}
        error={error}
        isError={isError}
        isLoading={isLoading || awaitingEmpty}
        hasData={Boolean(data) && !awaitingEmpty}
        rowCount={rows.length}
        columnCount={COLUMN_COUNT}
        emptyIcon={IconTimelineEvent}
        emptyLabel={narrowing ? t("milestoneList.noMatch") : t("milestoneList.empty")}
        scrollMinWidth={760}
        header={
          <Table.Tr>
            <SortHeader field="name" label={t("milestoneList.column.milestone")} activeField={sortField} activeDir={sortDir} onToggle={toggleSort} />
            <SortHeader field="projectName" label={t("roadmap.column.project")} activeField={sortField} activeDir={sortDir} onToggle={toggleSort} />
            <SortHeader field="teamName" label={t("project.column.team")} activeField={sortField} activeDir={sortDir} onToggle={toggleSort} />
            <Table.Th>{t("milestoneList.column.estimate")}</Table.Th>
            <Table.Th>{t("milestoneList.column.start")}</Table.Th>
            <Table.Th>{t("milestoneList.column.end")}</Table.Th>
          </Table.Tr>
        }
        rows={rows.map((milestone) => (
          <Table.Tr key={milestone.id}>
            <Table.Td>
              <Text size="sm" fw={500}>
                {milestone.name}
              </Text>
            </Table.Td>
            <Table.Td>
              <Anchor component={RouterLink} to={projectPath(milestone.projectId)} size="sm" aria-label={t("plan.openProjectAria", { name: milestone.projectName })}>
                {milestone.projectName}
              </Anchor>
            </Table.Td>
            <Table.Td>
              <Anchor component={RouterLink} to={teamPath(milestone.teamId)} size="sm" aria-label={t("teams.openAria", { name: milestone.teamName })}>
                {milestone.teamName}
              </Anchor>
            </Table.Td>
            <Table.Td>
              <Text size="sm">{milestone.estimateMd}</Text>
            </Table.Td>
            {milestone.startDate === null || milestone.endDate === null ? (
              // Both dates are null together: one dimmed cell across the two columns.
              <Table.Td colSpan={2}>
                <Text size="sm" c="dimmed">
                  {t("milestoneList.notScheduled")}
                </Text>
              </Table.Td>
            ) : (
              <>
                <Table.Td>
                  <Text size="sm">{milestone.startDate}</Text>
                </Table.Td>
                <Table.Td>
                  <Text size="sm">{milestone.endDate}</Text>
                </Table.Td>
              </>
            )}
          </Table.Tr>
        ))}
        total={data?.total ?? 0}
        page={page}
        pageSize={pageSize}
        onPageChange={setPage}
        onPageSizeChange={setPageSize}
      />
    </Stack>
  );
}
