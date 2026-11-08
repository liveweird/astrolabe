import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Link as RouterLink, useNavigate } from "react-router-dom";
import { Anchor, Badge, Button, Group, Menu, Stack, Table, Text } from "@mantine/core";
import { IconActivity, IconExternalLink, IconPencil, IconPlus, IconTrash } from "@tabler/icons-react";
import { keepPreviousData, useQuery, useQueryClient } from "@tanstack/react-query";
import { useAdmin } from "../auth";
import { deleteFlowConnection, listFlowConnections, listFlowTeams, type FlowConnection } from "../api/flow";
import ConfirmDeleteModal from "../components/ConfirmDeleteModal";
import DestructiveMenuItem from "../components/DestructiveMenuItem";
import FlowConnectionEditorModal from "../components/FlowConnectionEditorModal";
import PageHeader from "../components/PageHeader";
import RegistryListTable from "../components/RegistryListTable";
import RowActionsMenu from "../components/RowActionsMenu";
import SortHeader from "../components/SortHeader";
import SyncStatusBadge from "../components/SyncStatusBadge";
import { useBoundedPoll } from "../hooks/useBoundedPoll";
import { useDeleteConfirm } from "../hooks/useDeleteConfirm";
import { useDialogFocus } from "../hooks/useDialogFocus";
import { useNow } from "../hooks/useNow";
import { usePagedSort } from "../hooks/usePagedSort";
import { flowReady, untestedKey } from "../utils/flowForm";
import { flowBaseHref, flowConnectionPath } from "../utils/flowLinks";
import { formatDateTime } from "../utils/formatDate";
import { refreshQueriesAfterMutation } from "../utils/queryRefresh";
import { saveErrorMessage } from "../utils/saveError";
import { IDLE_REFRESH_MS, RUN_STATE_COLOR, runState } from "../utils/syncRuns";

const SORT_FIELDS = ["name", "createdAt"] as const;
type SortField = (typeof SORT_FIELDS)[number];

const SETTINGS_KEY = "flowConnections";

/** The confirmation's body: what a delete takes with it. The count of team links comes from the teams list (any signed-in user reads it). */
function DeleteBody({ connection }: { connection: FlowConnection }) {
  const { t } = useTranslation();
  const teams = useQuery({
    queryKey: ["flow", "teams", connection.id],
    queryFn: () => listFlowTeams(connection.id),
  });
  if (teams.data === undefined) return <>{t("flow.deleteBody", { name: connection.name })}</>;
  const linked = teams.data.items.filter((team) => team.bindingId !== null).length;
  return <>{linked === 0 ? t("flow.deleteBodyNoLinks", { name: connection.name }) : t("flow.deleteBodyLinks", { name: connection.name, count: linked })}</>;
}

/** The connection's own newest run, from the registry's `lastRun` (the SERVER says whether it is running): its outcome badge and when it started. */
function LastRun({ run }: { run: FlowConnection["lastRun"] }) {
  const { t } = useTranslation();
  if (!run) {
    return (
      <Text size="sm" c="dimmed">
        —
      </Text>
    );
  }
  const state = runState(run);
  return (
    <Group gap="xs" wrap="nowrap">
      <Badge color={RUN_STATE_COLOR[state]} variant="light" tt="none">
        {t(`jira.runs.state.${state}`)}
      </Badge>
      <Text size="sm">{formatDateTime(run.startedAt)}</Text>
    </Group>
  );
}

/**
 * The Flow connections registry (`/integrations/flow`, ADMIN only: the route sits under `RequireAdmin` and the query is `enabled` only for an
 * admin): the paged list, a connection's name opens its page, the editor creates and edits, delete confirms what it unlinks. The Jira registry's
 * twin: the same Teams template, with the base URL and the time zone in place of the site and the project keys.
 */
export default function FlowConnections() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const admin = useAdmin();
  const { page, setPage, pageSize, setPageSize, sortField, sortDir, sortParam, toggleSort } = usePagedSort<SortField>("name", [], {
    key: SETTINGS_KEY,
    sortFields: SORT_FIELDS,
  });

  const poll = useBoundedPoll();
  const { data, isLoading, isError, error, dataUpdatedAt } = useQuery({
    queryKey: ["flow", "list", page, pageSize, sortParam],
    queryFn: () => listFlowConnections({ page, pageSize, sort: sortParam }),
    placeholderData: keepPreviousData,
    enabled: admin,
    // While any listed connection's newest run is running (the server's verdict), the list is re-read so its badge moves by itself.
    refetchInterval: (query) => {
      const running = query.state.data?.items.filter((c) => c.lastRun?.running).map((c) => `${c.id}:${c.lastRun?.id}`);
      // Nothing running: still re-read slowly while the page is visible, a scheduled run starts without anyone asking.
      return poll(running && running.length > 0 ? running.join(",") : null) || IDLE_REFRESH_MS;
    },
  });
  const now = useNow(60_000, dataUpdatedAt);

  const [editorTarget, setEditorTarget] = useState<FlowConnection | "new" | null>(null);
  useDialogFocus(editorTarget !== null);

  const titleRef = useRef<HTMLHeadingElement>(null);
  const remove = useDeleteConfirm<FlowConnection>({
    mutationFn: (row) => deleteFlowConnection(row.id),
    onSuccess: () => refreshQueriesAfterMutation(queryClient, ["flow"]),
    successMessage: t("flow.toast.deleted"),
    focusAfterDelete: titleRef,
  });

  const columnCount = 7;

  return (
    <Stack gap="md">
      <PageHeader
        titleRef={titleRef}
        title={t("flow.title")}
        description={t("flow.intro")}
        actions={
          <Button leftSection={<IconPlus size={16} />} onClick={() => setEditorTarget("new")}>
            {t("flow.newConnection")}
          </Button>
        }
      />

      <RegistryListTable
        label={t("flow.title")}
        errorTitle={t("flow.loadFailed")}
        error={error}
        isError={isError}
        isLoading={isLoading}
        hasData={Boolean(data)}
        rowCount={data?.items.length ?? 0}
        columnCount={columnCount}
        scrollMinWidth={980}
        emptyIcon={IconActivity}
        emptyLabel={t("flow.empty")}
        header={
          <Table.Tr>
            <SortHeader field="name" label={t("common.field.name")} activeField={sortField} activeDir={sortDir} onToggle={toggleSort} />
            <Table.Th>{t("flow.column.baseUrl")}</Table.Th>
            <Table.Th>{t("flow.column.timeZone")}</Table.Th>
            <Table.Th>{t("flow.column.lastTest")}</Table.Th>
            <Table.Th>{t("flow.column.status")}</Table.Th>
            <Table.Th>{t("flow.column.lastRun")}</Table.Th>
            <Table.Th aria-label={t("common.table.operations")} style={{ width: 1 }} />
          </Table.Tr>
        }
        rows={data?.items.map((connection) => {
          const href = flowBaseHref(connection.baseUrl);
          return (
            <Table.Tr key={connection.id}>
              <Table.Td>
                <Group gap="xs" wrap="nowrap">
                  <Anchor component={RouterLink} to={flowConnectionPath(connection.id)} fw={500} size="sm" aria-label={t("flow.openAria", { name: connection.name })}>
                    {connection.name}
                  </Anchor>
                  {!connection.enabled && (
                    <Badge color="gray" variant="light" tt="none">
                      {t("flow.disabled")}
                    </Badge>
                  )}
                </Group>
              </Table.Td>
              <Table.Td>
                {href ? (
                  <Anchor href={href} target="_blank" rel="noopener noreferrer" size="sm">
                    {connection.baseUrl.replace(/^https?:\/\//, "")}
                    <IconExternalLink size="0.85em" aria-hidden style={{ marginInlineStart: "0.25em", verticalAlign: "-0.1em" }} />
                  </Anchor>
                ) : (
                  <Text size="sm">{connection.baseUrl}</Text>
                )}
              </Table.Td>
              <Table.Td>
                <Text size="sm">{connection.timeZone}</Text>
              </Table.Td>
              <Table.Td>
                {connection.lastTestedAt === null ? (
                  <Text size="sm" c="dimmed">
                    {t(untestedKey(connection))}
                  </Text>
                ) : (
                  <Group gap="xs" wrap="nowrap">
                    <Badge color={connection.lastTestOk ? "green" : "red"} variant="light" tt="none">
                      {connection.lastTestOk ? t("jira.test.passed") : t("jira.test.notPassed")}
                    </Badge>
                    <Text size="sm">{formatDateTime(connection.lastTestedAt)}</Text>
                  </Group>
                )}
              </Table.Td>
              <Table.Td>
                <SyncStatusBadge status={connection.status} now={now} ready={flowReady(connection)} pollIntervalMinutes={connection.pollIntervalMinutes} />
              </Table.Td>
              <Table.Td>
                <LastRun run={connection.lastRun} />
              </Table.Td>
              <Table.Td style={{ width: 1 }} ta="right">
                <RowActionsMenu label={t("common.table.operationsAria", { name: connection.name })}>
                  <Menu.Item component={RouterLink} to={flowConnectionPath(connection.id)} aria-label={t("flow.openAria", { name: connection.name })}>
                    {t("flow.open")}
                  </Menu.Item>
                  <Menu.Item leftSection={<IconPencil size={14} />} onClick={() => setEditorTarget(connection)} aria-label={t("common.action.editAria", { name: connection.name })}>
                    {t("common.action.edit")}
                  </Menu.Item>
                  <Menu.Divider />
                  <DestructiveMenuItem leftSection={<IconTrash size={14} />} onClick={() => remove.requestDelete(connection)} aria-label={t("common.action.deleteAria", { name: connection.name })}>
                    {t("common.action.delete")}
                  </DestructiveMenuItem>
                </RowActionsMenu>
              </Table.Td>
            </Table.Tr>
          );
        })}
        total={data?.total ?? 0}
        page={page}
        pageSize={pageSize}
        onPageChange={setPage}
        onPageSizeChange={setPageSize}
      />

      {editorTarget !== null && (
        <FlowConnectionEditorModal
          target={editorTarget === "new" ? null : editorTarget}
          onClose={() => setEditorTarget(null)}
          onSaved={async (saved) => {
            setEditorTarget(null);
            await refreshQueriesAfterMutation(queryClient, ["flow"]);
            // A NEW connection lands on its page: test it, refresh it, link its teams.
            if (saved) navigate(flowConnectionPath(saved.id));
          }}
        />
      )}

      <ConfirmDeleteModal
        confirm={remove}
        title={t("flow.deleteTitle")}
        errorTitle={t("flow.deleteFailed")}
        errorMessage={(err) => saveErrorMessage(err, t, { failedStatus: "common.error.actionFailedStatus", failed: "common.error.actionFailed" })}
        body={(connection) => <DeleteBody connection={connection} />}
      />
    </Stack>
  );
}
