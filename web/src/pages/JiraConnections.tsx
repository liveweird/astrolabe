import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Link as RouterLink, useNavigate } from "react-router-dom";
import { Anchor, Badge, Button, Group, Menu, Stack, Table, Text } from "@mantine/core";
import { IconExternalLink, IconPencil, IconPlugConnected, IconPlus, IconTrash } from "@tabler/icons-react";
import { keepPreviousData, useQuery, useQueryClient } from "@tanstack/react-query";
import { useAdmin } from "../auth";
import { deleteJiraConnection, listJiraBindings, listJiraConnections, type JiraConnection } from "../api/jira";
import ConfirmDeleteModal from "../components/ConfirmDeleteModal";
import DestructiveMenuItem from "../components/DestructiveMenuItem";
import JiraConnectionEditorModal from "../components/JiraConnectionEditorModal";
import PageHeader from "../components/PageHeader";
import RegistryListTable from "../components/RegistryListTable";
import RowActionsMenu from "../components/RowActionsMenu";
import SortHeader from "../components/SortHeader";
import { useDeleteConfirm } from "../hooks/useDeleteConfirm";
import { useDialogFocus } from "../hooks/useDialogFocus";
import { useBoundedPoll } from "../hooks/useBoundedPoll";
import { usePagedSort } from "../hooks/usePagedSort";
import { formatDateTime } from "../utils/formatDate";
import { untestedKey } from "../utils/jiraForm";
import { jiraConnectionPath, jiraSiteUrl } from "../utils/jiraLinks";
import { refreshQueriesAfterMutation } from "../utils/queryRefresh";
import { saveErrorMessage } from "../utils/saveError";
import { RUN_STATE_COLOR, runState } from "../utils/syncRuns";

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

/** The connection's own newest run, from the registry's `lastRun` (the SERVER says whether it is running): its outcome badge and when it started. */
function LastRun({ run }: { run: JiraConnection["lastRun"] }) {
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
  const { data, isLoading, isError, error } = useQuery({
    queryKey: ["jira", "list", page, pageSize, sortParam],
    queryFn: () => listJiraConnections({ page, pageSize, sort: sortParam }),
    placeholderData: keepPreviousData,
    enabled: admin,
    // While any listed connection's newest run is running (the server's verdict), the list is re-read so its badge moves by itself.
    refetchInterval: (query) => {
      const running = query.state.data?.items.filter((c) => c.lastRun?.running).map((c) => `${c.id}:${c.lastRun?.id}`);
      return poll(running && running.length > 0 ? running.join(",") : null);
    },
  });

  const [editorTarget, setEditorTarget] = useState<JiraConnection | "new" | null>(null);
  useDialogFocus(editorTarget !== null);

  const titleRef = useRef<HTMLHeadingElement>(null);
  const remove = useDeleteConfirm<JiraConnection>({
    mutationFn: (row) => deleteJiraConnection(row.id),
    onSuccess: () => refreshQueriesAfterMutation(queryClient, ["jira"]),
    successMessage: t("jira.toast.deleted"),
    focusAfterDelete: titleRef,
  });

  const columnCount = 6;

  return (
    <Stack gap="md">
      <PageHeader
        titleRef={titleRef}
        title={t("jira.title")}
        description={t("jira.intro")}
        actions={
          <Button leftSection={<IconPlus size={16} />} onClick={() => setEditorTarget("new")}>
            {t("jira.newConnection")}
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
        scrollMinWidth={860}
        emptyIcon={IconPlugConnected}
        emptyLabel={t("jira.empty")}
        header={
          <Table.Tr>
            <SortHeader field="name" label={t("common.field.name")} activeField={sortField} activeDir={sortDir} onToggle={toggleSort} />
            <Table.Th>{t("jira.column.site")}</Table.Th>
            <Table.Th>{t("jira.column.projectKeys")}</Table.Th>
            <Table.Th>{t("jira.column.lastTest")}</Table.Th>
            <Table.Th>{t("jira.column.lastRun")}</Table.Th>
            <Table.Th aria-label={t("common.table.operations")} style={{ width: 1 }} />
          </Table.Tr>
        }
        rows={data?.items.map((connection) => (
          <Table.Tr key={connection.id}>
            <Table.Td>
              <Group gap="xs" wrap="nowrap">
                <Anchor component={RouterLink} to={jiraConnectionPath(connection.id)} fw={500} size="sm" aria-label={t("jira.openAria", { name: connection.name })}>
                  {connection.name}
                </Anchor>
                {!connection.enabled && (
                  <Badge color="gray" variant="light" tt="none">
                    {t("jira.disabled")}
                  </Badge>
                )}
              </Group>
            </Table.Td>
            <Table.Td>
              {jiraSiteUrl(connection.siteUrl) ? (
                <Anchor href={jiraSiteUrl(connection.siteUrl)} target="_blank" rel="noopener noreferrer" size="sm">
                  {connection.siteUrl.replace(/^https:\/\//, "")}
                  <IconExternalLink size="0.85em" aria-hidden style={{ marginInlineStart: "0.25em", verticalAlign: "-0.1em" }} />
                </Anchor>
              ) : (
                <Text size="sm">{connection.siteUrl}</Text>
              )}
            </Table.Td>
            <Table.Td>
              <Text size="sm" lineClamp={2} maw={220} title={connection.projectKeys.join(", ")}>
                {connection.projectKeys.join(", ")}
              </Text>
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
              <LastRun run={connection.lastRun} />
            </Table.Td>
            <Table.Td style={{ width: 1 }} ta="right">
              <RowActionsMenu label={t("common.table.operationsAria", { name: connection.name })}>
                <Menu.Item component={RouterLink} to={jiraConnectionPath(connection.id)} aria-label={t("jira.openAria", { name: connection.name })}>
                  {t("jira.open")}
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
            await refreshQueriesAfterMutation(queryClient, ["jira"]);
            // A NEW connection lands on its page: test it, then map it.
            if (saved) navigate(jiraConnectionPath(saved.id));
          }}
        />
      )}

      <ConfirmDeleteModal
        confirm={remove}
        title={t("jira.deleteTitle")}
        errorTitle={t("jira.deleteFailed")}
        errorMessage={(err) => saveErrorMessage(err, t, { failedStatus: "common.error.actionFailedStatus", failed: "common.error.actionFailed" })}
        body={(connection) => <DeleteBody connection={connection} />}
      />
    </Stack>
  );
}
