import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Link as RouterLink, useNavigate } from "react-router-dom";
import { Anchor, Badge, Button, Group, Menu, Stack, Table, Text } from "@mantine/core";
import { IconPencil, IconPlugConnected, IconPlus, IconTrash } from "@tabler/icons-react";
import { keepPreviousData, useQuery, useQueryClient } from "@tanstack/react-query";
import { useAdmin } from "../auth";
import { HOME_VIEW_KEY } from "../api/home";
import { deleteJiraConnection, listJiraBindings, listJiraConnections, type JiraConnection } from "../api/jira";
import ConfirmDeleteModal from "../components/ConfirmDeleteModal";
import ConnectionTestBadge from "../components/ConnectionTestBadge";
import DestructiveMenuItem from "../components/DestructiveMenuItem";
import JiraConnectionEditorModal from "../components/JiraConnectionEditorModal";
import JiraStubBadge from "../components/JiraStubBadge";
import LastRunCell from "../components/LastRunCell";
import PageHeader from "../components/PageHeader";
import RegistryListTable from "../components/RegistryListTable";
import RowActionsMenu from "../components/RowActionsMenu";
import SortHeader from "../components/SortHeader";
import SyncStatusBadge from "../components/SyncStatusBadge";
import TrailingLinkIcon from "../components/TrailingLinkIcon";
import { useDeleteConfirm } from "../hooks/useDeleteConfirm";
import { useDialogFocus } from "../hooks/useDialogFocus";
import { useBoundedPoll } from "../hooks/useBoundedPoll";
import { useNow } from "../hooks/useNow";
import { useClampPage, usePagedSort } from "../hooks/usePagedSort";
import { untestedKey } from "../utils/jiraForm";
import { jiraConnectionPath, jiraSiteUrl } from "../utils/jiraLinks";
import { refreshQueriesAfterMutation } from "../utils/queryRefresh";
import { saveErrorMessage } from "../utils/saveError";
import { listRefetchInterval } from "../utils/syncRuns";

const SORT_FIELDS = ["name", "createdAt"] as const;
type SortField = (typeof SORT_FIELDS)[number];

const SETTINGS_KEY = "jiraConnections";

/** The confirmation's body: what a delete takes with it. The count of links comes from the bindings list (any signed-in user reads it). */
function DeleteBody({ connection }: { connection: JiraConnection }) {
  const { t } = useTranslation();
  const links = useQuery({
    queryKey: ["jira", "bindings", "count", connection.id],
    queryFn: () => listJiraBindings({ page: 1, pageSize: 1, connectionId: connection.id }),
  });
  if (links.data === undefined) return <>{t("jira.deleteBody", { name: connection.name })}</>;
  return <>{links.data.total === 0 ? t("jira.deleteBodyNoLinks", { name: connection.name }) : t("jira.deleteBodyLinks", { name: connection.name, count: links.data.total })}</>;
}

/**
 * The Jira connections registry (`/integrations/jira`, ADMIN only: the route sits under `RequireAdmin` and the query is `enabled` only for
 * an admin): the paged list, a connection's name opens its page, the editor creates and edits, delete confirms what it unbinds. The Teams
 * template, minus the name filter (the endpoint has none).
 */
export default function JiraConnections() {
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
    queryKey: ["jira", "list", page, pageSize, sortParam],
    queryFn: () => listJiraConnections({ page, pageSize, sort: sortParam }),
    placeholderData: keepPreviousData,
    enabled: admin,
    // While any listed connection's newest run is running (the server's verdict), the list is re-read so its badge moves by itself.
    refetchInterval: (query) => listRefetchInterval(poll, query.state.data?.items),
  });
  useClampPage(page, pageSize, setPage, data, isPlaceholderData);
  const now = useNow(60_000, dataUpdatedAt);

  const [editorTarget, setEditorTarget] = useState<JiraConnection | "new" | null>(null);
  useDialogFocus(editorTarget !== null);

  const titleRef = useRef<HTMLHeadingElement>(null);
  const remove = useDeleteConfirm<JiraConnection>({
    mutationFn: (row) => deleteJiraConnection(row.id),
    onSuccess: () => refreshQueriesAfterMutation(queryClient, ["jira"], HOME_VIEW_KEY),
    successMessage: t("sync.connection.toast.deleted"),
    focusAfterDelete: titleRef,
  });

  const columnCount = 7;

  return (
    <Stack gap="md">
      <PageHeader
        titleRef={titleRef}
        title={t("jira.title")}
        description={t("jira.intro")}
        actions={
          <Button leftSection={<IconPlus size={16} />} onClick={() => setEditorTarget("new")}>
            {t("sync.connection.newConnection")}
          </Button>
        }
      />

      <RegistryListTable
        label={t("jira.title")}
        errorTitle={t("jira.loadFailed")}
        error={error}
        isError={isError}
        isLoading={isLoading}
        hasData={Boolean(data)}
        rowCount={data?.items.length ?? 0}
        columnCount={columnCount}
        scrollMinWidth={980}
        emptyIcon={IconPlugConnected}
        emptyLabel={t("jira.empty")}
        header={
          <Table.Tr>
            <SortHeader field="name" label={t("common.field.name")} activeField={sortField} activeDir={sortDir} onToggle={toggleSort} />
            <Table.Th>{t("jira.column.site")}</Table.Th>
            <Table.Th>{t("jira.column.projectKeys")}</Table.Th>
            <Table.Th>{t("sync.connection.column.lastTest")}</Table.Th>
            <Table.Th>{t("sync.connection.column.status")}</Table.Th>
            <Table.Th>{t("sync.connection.column.lastRun")}</Table.Th>
            <Table.Th aria-label={t("common.table.operations")} style={{ width: 1 }} />
          </Table.Tr>
        }
        rows={data?.items.map((connection) => (
          <Table.Tr key={connection.id}>
            <Table.Td>
              <Group gap="xs" wrap="nowrap">
                <Anchor component={RouterLink} to={jiraConnectionPath(connection.id)} fw={500} size="sm" aria-label={t("sync.connection.openAria", { name: connection.name })}>
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
              <Group gap="xs">
                {jiraSiteUrl(connection.siteUrl) ? (
                  <Anchor href={jiraSiteUrl(connection.siteUrl)} target="_blank" rel="noopener noreferrer" size="sm">
                    {connection.siteUrl.replace(/^https:\/\//, "")}
                    <TrailingLinkIcon />
                  </Anchor>
                ) : (
                  <Text size="sm">{connection.siteUrl}</Text>
                )}
                {connection.stub && <JiraStubBadge />}
              </Group>
            </Table.Td>
            <Table.Td>
              <Text size="sm" lineClamp={2} maw={220} title={connection.projectKeys.join(", ")}>
                {connection.projectKeys.join(", ")}
              </Text>
            </Table.Td>
            <Table.Td>
              <ConnectionTestBadge lastTestOk={connection.lastTestOk} lastTestedAt={connection.lastTestedAt} untestedKey={untestedKey(connection)} layout="row" />
            </Table.Td>
            <Table.Td>
              <SyncStatusBadge status={connection.status} now={now} ready={connection.discoveredAt !== null} pollIntervalMinutes={connection.pollIntervalMinutes} />
            </Table.Td>
            <Table.Td>
              <LastRunCell run={connection.lastRun} />
            </Table.Td>
            <Table.Td style={{ width: 1 }} ta="right">
              <RowActionsMenu label={t("common.table.operationsAria", { name: connection.name })}>
                <Menu.Item component={RouterLink} to={jiraConnectionPath(connection.id)} aria-label={t("sync.connection.openAria", { name: connection.name })}>
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
        ))}
        total={data?.total ?? 0}
        page={page}
        pageSize={pageSize}
        onPageChange={setPage}
        onPageSizeChange={setPageSize}
      />

      {editorTarget !== null && (
        <JiraConnectionEditorModal
          target={editorTarget === "new" ? null : editorTarget}
          onClose={() => setEditorTarget(null)}
          onSaved={async (saved) => {
            setEditorTarget(null);
            await refreshQueriesAfterMutation(queryClient, ["jira"], HOME_VIEW_KEY);
            // A NEW connection lands on its page: test it, then map it.
            if (saved) navigate(jiraConnectionPath(saved.id));
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
