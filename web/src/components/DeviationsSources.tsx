import { useState } from "react";
import { Link as RouterLink } from "react-router-dom";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import { Anchor, Badge, Button, Stack, Table, Text, Title } from "@mantine/core";
import { IconPlayerPlay } from "@tabler/icons-react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { DeviationConnection } from "../api/deviations";
import { isRunInProgress, requestSyncRun } from "../api/sync";
import { useNow } from "../hooks/useNow";
import { formatDateTime } from "../utils/formatDate";
import { jiraConnectionPath } from "../utils/jiraLinks";
import { refreshQueriesAfterMutation } from "../utils/queryRefresh";
import { saveErrorMessage } from "../utils/saveError";
import { showSuccessToast } from "../utils/toast";
import { errorCodeText, RUN_STATE_COLOR, runState } from "../utils/syncRuns";
import FormErrorAlert from "./FormErrorAlert";
import ScrollRegion from "./ScrollRegion";
import SyncStatusBadge from "./SyncStatusBadge";

/** What the connection's newest run says about how current the figures are, in words ("did not succeed" never reads as current). */
function runNotes(connection: DeviationConnection, t: TFunction): string[] {
  const notes: string[] = [];
  const run = connection.lastRun;
  if (run === null) {
    notes.push(t("deviations.sources.noteNever"));
  } else {
    switch (runState(run)) {
      case "failed":
        notes.push(t("deviations.sources.noteFailed", { error: run.errorCode ? errorCodeText(run.errorCode, t) : t("deviations.sources.noCode") }));
        break;
      case "interrupted":
        notes.push(t("deviations.sources.noteInterrupted"));
        break;
      case "abandoned":
        notes.push(t("deviations.sources.noteAbandoned"));
        break;
      default:
        break;
    }
  }
  if (!connection.enabled) notes.push(t("deviations.sources.noteDisabled"));
  if (!connection.mappingOk) notes.push(t("deviations.sources.noteMapping"));
  return notes;
}

/**
 * "Data from Jira": one row per Jira connection with the state of its newest run (the SERVER's verdict, `lastRun.running`; an unfinished run
 * the server no longer counts as running reads "Interrupted"), the notes that qualify the figures (never refreshed, last refresh failed, the
 * connection disabled, the mapping not fitting the site) and - ADMIN only - Refresh now. A `409 run-in-progress` is a normal state, never an
 * error. The refresh refreshes the `["jira"]` queries only: no plan view is touched.
 */
export default function DeviationsSources({ connections, admin, readAt }: { connections: readonly DeviationConnection[]; admin: boolean; readAt: number }) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const now = useNow(60_000, readAt);
  const [refreshError, setRefreshError] = useState<string | null>(null);
  const refresh = useMutation({
    mutationFn: (connection: DeviationConnection) => requestSyncRun({ kind: "JIRA", connectionId: connection.id }),
    onMutate: () => setRefreshError(null),
    onSuccess: () => showSuccessToast(t("deviations.sources.refreshStarted")),
    // A 409 run-in-progress is a normal state: the page re-reads below and its status line says a refresh is running; no error, no extra note.
    onError: (err) => {
      if (!isRunInProgress(err)) setRefreshError(saveErrorMessage(err, t, { forbidden: "deviations.sources.refreshForbidden", notFound: "deviations.sources.refreshInvalid", invalid: "deviations.sources.refreshInvalid", failedStatus: "common.error.actionFailedStatus", failed: "deviations.sources.refreshFailed" }));
    },
    // Either way the registry now holds a run: re-read the page's data, and its own polling takes over while a run is going.
    onSettled: () => refreshQueriesAfterMutation(queryClient, ["jira"]),
  });
  const running = connections.some((connection) => connection.lastRun?.running);
  const label = t("deviations.sources.tableAria");

  return (
    <Stack gap="xs">
      <Title order={3} size="h4">
        {t("deviations.sources.title")}
      </Title>
      <ScrollRegion label={label} minWidth={820}>
        <Table aria-label={label}>
          <Table.Thead>
            <Table.Tr>
              <Table.Th>{t("deviations.sources.column.connection")}</Table.Th>
              <Table.Th>{t("deviations.sources.column.status")}</Table.Th>
              <Table.Th>{t("deviations.sources.column.lastRun")}</Table.Th>
              <Table.Th>{t("deviations.sources.column.notes")}</Table.Th>
              {admin && <Table.Th aria-label={t("common.table.operations")} style={{ width: 1 }} />}
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {connections.map((connection) => {
              const state = connection.lastRun === null ? null : runState(connection.lastRun);
              return (
                <Table.Tr key={connection.id}>
                  <Table.Td>
                    {admin ? (
                      <Anchor component={RouterLink} to={jiraConnectionPath(connection.id)} size="sm" fw={500} aria-label={t("deviations.sources.openConnectionAria", { name: connection.name })}>
                        {connection.name}
                      </Anchor>
                    ) : (
                      <Text size="sm" fw={500}>
                        {connection.name}
                      </Text>
                    )}
                    {!connection.enabled && (
                      <Badge color="gray" variant="light" tt="none" ml="xs">
                        {t("deviations.sources.disabled")}
                      </Badge>
                    )}
                  </Table.Td>
                  <Table.Td>
                    <SyncStatusBadge status={connection.status} now={now} />
                  </Table.Td>
                  <Table.Td>
                    {connection.lastRun === null || state === null ? (
                      <Text size="sm" c="dimmed">
                        {t("deviations.sources.never")}
                      </Text>
                    ) : (
                      <>
                        <Badge color={RUN_STATE_COLOR[state]} variant="light" tt="none">
                          {t(`jira.runs.state.${state}`)}
                        </Badge>
                        <Text size="xs" c="dimmed">
                          {formatDateTime(connection.lastRun.finishedAt ?? connection.lastRun.startedAt)}
                        </Text>
                      </>
                    )}
                  </Table.Td>
                  <Table.Td>
                    {runNotes(connection, t).map((note) => (
                      <Text key={note} size="sm">
                        {note}
                      </Text>
                    ))}
                  </Table.Td>
                  {admin && (
                    <Table.Td style={{ width: 1 }}>
                      <Button
                        variant="default"
                        size="compact-sm"
                        leftSection={<IconPlayerPlay size={14} />}
                        loading={refresh.isPending && refresh.variables?.id === connection.id}
                        disabled={!connection.enabled || connection.lastRun?.running === true}
                        aria-label={t("deviations.sources.refreshNowAria", { name: connection.name })}
                        onClick={() => refresh.mutate(connection)}
                      >
                        {t("deviations.sources.refreshNow")}
                      </Button>
                    </Table.Td>
                  )}
                </Table.Tr>
              );
            })}
          </Table.Tbody>
        </Table>
      </ScrollRegion>
      {refreshError && <FormErrorAlert>{refreshError}</FormErrorAlert>}
      <div role="status" aria-live="polite">
        {running ? <Text size="sm">{t("deviations.sources.running")}</Text> : null}
      </div>
    </Stack>
  );
}
