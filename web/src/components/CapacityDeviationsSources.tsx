import { useState } from "react";
import { Link as RouterLink } from "react-router-dom";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import { Anchor, Badge, Button, Stack, Table, Text, Title } from "@mantine/core";
import { IconPlayerPlay } from "@tabler/icons-react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { CapacityDeviationConnection } from "../api/capacityDeviations";
import { isRunInProgress, requestSyncRun } from "../api/sync";
import { useNow } from "../hooks/useNow";
import { flowConnectionPath } from "../utils/flowLinks";
import { formatDateTime } from "../utils/formatDate";
import { refreshQueriesAfterMutation } from "../utils/queryRefresh";
import { saveErrorMessage } from "../utils/saveError";
import { errorCodeText, runState } from "../utils/syncRuns";
import { showSuccessToast } from "../utils/toast";
import FormErrorAlert from "./FormErrorAlert";
import ScrollRegion from "./ScrollRegion";
import SyncStatusBadge from "./SyncStatusBadge";

/** What the connection's derived state and newest run say about how current its teams are, in words (a failed refresh never reads as current). */
function runNotes(connection: CapacityDeviationConnection, t: TFunction): string[] {
  const notes: string[] = [];
  const run = connection.status.lastRun;
  if (run === null) {
    notes.push(t("deviations.flowSection.sources.noteNever"));
  } else {
    switch (runState(run)) {
      case "failed":
        notes.push(t("deviations.sources.noteFailed", { error: run.errorCode ? errorCodeText(run.errorCode, t, "FLOW") : t("deviations.sources.noCode") }));
        break;
      case "interrupted":
        notes.push(t("deviations.sources.noteInterrupted"));
        break;
      case "abandoned":
        notes.push(t("deviations.sources.noteAbandoned"));
        break;
      default:
        if (connection.status.state === "STALE") notes.push(t("deviations.flowSection.sources.noteStale"));
    }
  }
  if (!connection.enabled) notes.push(t("deviations.flowSection.sources.noteDisabled"));
  return notes;
}

/**
 * "Data from Flow": one row per Flow connection with its derived state, when its document was last mirrored, the notes that qualify the figures
 * (never refreshed, last refresh failed, stale, disabled) and - ADMIN only - Refresh now (`POST /integrations/sync/runs`, kind FLOW). A
 * `409 run-in-progress` is a normal state, never an error. The refresh re-reads the `["flow"]` queries only.
 */
export default function CapacityDeviationsSources({ connections, admin, readAt }: { connections: readonly CapacityDeviationConnection[]; admin: boolean; readAt: number }) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const now = useNow(60_000, readAt);
  const [refreshError, setRefreshError] = useState<string | null>(null);
  const refresh = useMutation({
    mutationFn: (connection: CapacityDeviationConnection) => requestSyncRun({ kind: "FLOW", connectionId: connection.id }),
    onMutate: () => setRefreshError(null),
    onSuccess: () => showSuccessToast(t("deviations.sources.refreshStarted")),
    // A 409 run-in-progress is a normal state: the page re-reads below and its status line says a refresh is running; no error, no extra note.
    onError: (err) => {
      if (!isRunInProgress(err)) setRefreshError(saveErrorMessage(err, t, { forbidden: "deviations.sources.refreshForbidden", notFound: "deviations.sources.refreshInvalid", invalid: "deviations.sources.refreshInvalid", failedStatus: "common.error.actionFailedStatus", failed: "deviations.sources.refreshFailed" }));
    },
    // Either way the registry now holds a run: re-read the section's data, and its own polling takes over while a run is going.
    onSettled: () => refreshQueriesAfterMutation(queryClient, ["flow"]),
  });
  const running = connections.some((connection) => connection.status.lastRun?.running);
  const label = t("deviations.flowSection.sources.tableAria");

  return (
    <Stack gap="xs">
      <Title order={4} size="h5">{t("deviations.flowSection.sources.title")}</Title>
      <ScrollRegion label={label} minWidth={820}>
        <Table aria-label={label}>
          <Table.Thead>
            <Table.Tr>
              <Table.Th>{t("deviations.flowSection.sources.column.connection")}</Table.Th>
              <Table.Th>{t("deviations.flowSection.sources.column.status")}</Table.Th>
              <Table.Th>{t("deviations.flowSection.sources.column.readAt")}</Table.Th>
              <Table.Th>{t("deviations.flowSection.sources.column.notes")}</Table.Th>
              {admin && <Table.Th aria-label={t("common.table.operations")} style={{ width: 1 }} />}
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {connections.map((connection) => (
              <Table.Tr key={connection.id}>
                <Table.Td>
                  {admin ? (
                    <Anchor component={RouterLink} to={flowConnectionPath(connection.id)} size="sm" fw={500} aria-label={t("deviations.sources.openConnectionAria", { name: connection.name })}>
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
                  {connection.teamsAt === null ? (
                    <Text size="sm" c="dimmed">
                      {t("deviations.flowSection.sources.neverRead")}
                    </Text>
                  ) : (
                    <Text size="sm">{formatDateTime(connection.teamsAt)}</Text>
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
                      disabled={!connection.enabled || connection.status.lastRun?.running === true}
                      aria-label={t("deviations.sources.refreshNowAria", { name: connection.name })}
                      onClick={() => refresh.mutate(connection)}
                    >
                      {t("deviations.sources.refreshNow")}
                    </Button>
                  </Table.Td>
                )}
              </Table.Tr>
            ))}
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
