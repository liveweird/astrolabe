import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Link as RouterLink, useNavigate } from "react-router-dom";
import { Anchor, Badge, Button, Group, Menu, Stack, Table, Text } from "@mantine/core";
import { IconActivity, IconPencil, IconPlus, IconTrash } from "@tabler/icons-react";
import { keepPreviousData, useQuery, useQueryClient } from "@tanstack/react-query";
import { useAdmin } from "../auth";
import { deleteFlowConnection, listFlowConnections, listFlowTeams, type FlowConnection } from "../api/flow";
import ConfirmDeleteModal from "../components/ConfirmDeleteModal";
import ConnectionTestBadge from "../components/ConnectionTestBadge";
import DestructiveMenuItem from "../components/DestructiveMenuItem";
import FlowConnectionEditorModal from "../components/FlowConnectionEditorModal";
import LastRunCell from "../components/LastRunCell";
import PageHeader from "../components/PageHeader";
import RegistryListTable from "../components/RegistryListTable";
import RowActionsMenu from "../components/RowActionsMenu";
import SortHeader from "../components/SortHeader";
import SyncStatusBadge from "../components/SyncStatusBadge";
import TrailingLinkIcon from "../components/TrailingLinkIcon";
import { useBoundedPoll } from "../hooks/useBoundedPoll";
import { useDeleteConfirm } from "../hooks/useDeleteConfirm";
import { useDialogFocus } from "../hooks/useDialogFocus";
import { useNow } from "../hooks/useNow";
import { useClampPage, usePagedSort } from "../hooks/usePagedSort";
import { flowReady, untestedKey } from "../utils/flowForm";
import { flowBaseHref, flowConnectionPath } from "../utils/flowLinks";
import { refreshFlowConnections } from "../utils/flowRefresh";
import { saveErrorMessage } from "../utils/saveError";
import { listRefetchInterval } from "../utils/syncRuns";

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
  const { data, isLoading, isError, error, dataUpdatedAt, isPlaceholderData } = useQuery({
    queryKey: ["flow", "list", page, pageSize, sortParam],
    queryFn: () => listFlowConnections({ page, pageSize, sort: sortParam }),
    placeholderData: keepPreviousData,
    enabled: admin,
    // While any listed connection's newest run is running (the server's verdict), the list is re-read so its badge moves by itself.
    refetchInterval: (query) => listRefetchInterval(poll, query.state.data?.items),
  });
  useClampPage(page, pageSize, setPage, data, isPlaceholderData);
  const now = useNow(60_000, dataUpdatedAt);

  const [editorTarget, setEditorTarget] = useState<FlowConnection | "new" | null>(null);
  useDialogFocus(editorTarget !== null);

  const titleRef = useRef<HTMLHeadingElement>(null);
  const remove = useDeleteConfirm<FlowConnection>({
    mutationFn: (row) => deleteFlowConnection(row.id),
    onSuccess: () => refreshFlowConnections(queryClient),
    successMessage: t("sync.connection.toast.deleted"),
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
            {t("sync.connection.newConnection")}
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
            <Table.Th>{t("sync.connection.column.lastTest")}</Table.Th>
            <Table.Th>{t("sync.connection.column.status")}</Table.Th>
            <Table.Th>{t("sync.connection.column.lastRun")}</Table.Th>
            <Table.Th aria-label={t("common.table.operations")} style={{ width: 1 }} />
          </Table.Tr>
        }
        rows={data?.items.map((connection) => {
          const href = flowBaseHref(connection.baseUrl);
          return (
            <Table.Tr key={connection.id}>
              <Table.Td>
                <Group gap="xs" wrap="nowrap">
                  <Anchor component={RouterLink} to={flowConnectionPath(connection.id)} fw={500} size="sm" aria-label={t("sync.connection.openAria", { name: connection.name })}>
                    {connection.name}
                  </Anchor>
                  {!connection.enabled && (
                    <Badge color="gray" tt="none">
                      {t("sync.connection.disabled")}
                    </Badge>
                  )}
                </Group>
              </Table.Td>
              <Table.Td>
                {href ? (
                  <Anchor href={href} target="_blank" rel="noopener noreferrer" size="sm">
                    {connection.baseUrl.replace(/^https?:\/\//, "")}
                    <TrailingLinkIcon />
                  </Anchor>
                ) : (
                  <Text size="sm">{connection.baseUrl}</Text>
                )}
              </Table.Td>
              <Table.Td>
                <Text size="sm">{connection.timeZone}</Text>
              </Table.Td>
              <Table.Td>
                <ConnectionTestBadge lastTestOk={connection.lastTestOk} lastTestedAt={connection.lastTestedAt} untestedKey={untestedKey(connection)} layout="row" />
              </Table.Td>
              <Table.Td>
                <SyncStatusBadge status={connection.status} now={now} ready={flowReady(connection)} pollIntervalMinutes={connection.pollIntervalMinutes} />
              </Table.Td>
              <Table.Td>
                <LastRunCell run={connection.lastRun} />
              </Table.Td>
              <Table.Td style={{ width: 1 }} ta="right">
                <RowActionsMenu label={t("common.table.operationsAria", { name: connection.name })}>
                  <Menu.Item component={RouterLink} to={flowConnectionPath(connection.id)} aria-label={t("sync.connection.openAria", { name: connection.name })}>
                    {t("sync.connection.open")}
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
            await refreshFlowConnections(queryClient);
            // A NEW connection lands on its page: test it, refresh it, link its teams.
            if (saved) navigate(flowConnectionPath(saved.id));
          }}
        />
      )}

      <ConfirmDeleteModal
        confirm={remove}
        title={t("sync.connection.deleteTitle")}
        errorTitle={t("sync.connection.deleteFailed")}
        errorMessage={(err) => saveErrorMessage(err, t, { failedStatus: "common.error.actionFailedStatus", failed: "common.error.actionFailed" })}
        body={(connection) => <DeleteBody connection={connection} />}
      />
    </Stack>
  );
}
