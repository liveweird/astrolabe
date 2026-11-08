import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Alert, Anchor, Button, Group, Stack, Table, Text, Title } from "@mantine/core";
import { IconPlayerPlay, IconPlugConnected } from "@tabler/icons-react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { testFlowConnection, type FlowConnection, type FlowTestResult } from "../api/flow";
import { isRunInProgress, requestSyncRun } from "../api/sync";
import { useSyncRuns, syncRunsKey } from "../hooks/useSyncRuns";
import { flowReady, flowTestErrorMessage, untestedKey } from "../utils/flowForm";
import { flowBaseHref } from "../utils/flowLinks";
import { formatDateTime } from "../utils/formatDate";
import { refreshQueriesAfterMutation } from "../utils/queryRefresh";
import { saveErrorMessage } from "../utils/saveError";
import { IDLE_REFRESH_MS } from "../utils/syncRuns";
import { showSuccessToast } from "../utils/toast";
import ConnectionTestBadge from "./ConnectionTestBadge";
import ConnectionTestResults from "./ConnectionTestResults";
import ConnectionTestStatus from "./ConnectionTestStatus";
import FormErrorAlert from "./FormErrorAlert";
import SyncFacts, { Fact } from "./SyncFacts";
import SyncRunsTable from "./SyncRunsTable";

/** The connection's own facts (never the token: only whether one is stored). */
function ConnectionFacts({ connection, readAt }: { connection: FlowConnection; readAt: number }) {
  const { t } = useTranslation();
  const href = flowBaseHref(connection.baseUrl);
  return (
    <Table aria-label={t("flow.details.factsAria")}>
      <Table.Tbody>
        <Fact label={t("flow.field.baseUrl")}>
          {href ? (
            <Anchor href={href} target="_blank" rel="noopener noreferrer" size="sm">
              {connection.baseUrl}
            </Anchor>
          ) : (
            connection.baseUrl
          )}
        </Fact>
        <Fact label={t("flow.field.timeZone")}>{connection.timeZone}</Fact>
        <Fact label={t("flow.field.apiToken")}>{connection.hasApiToken ? t("flow.details.tokenStored") : t("flow.details.tokenMissing")}</Fact>
        <Fact label={t("flow.column.enabled")}>{connection.enabled ? t("flow.yes") : t("flow.no")}</Fact>
        <SyncFacts status={connection.status} pollIntervalMinutes={connection.pollIntervalMinutes} ready={flowReady(connection)} readAt={readAt} />
        <Fact label={t("flow.details.lastTest")}>
          <ConnectionTestBadge lastTestOk={connection.lastTestOk} lastTestedAt={connection.lastTestedAt} untestedKey={untestedKey(connection)} layout="fact" />
        </Fact>
        <Fact label={t("flow.details.teamsAt")}>{connection.teamsAt === null ? "—" : formatDateTime(connection.teamsAt)}</Fact>
      </Table.Tbody>
    </Table>
  );
}

/**
 * The connection page's first section (the Jira section's twin): the facts, Test connection (the STORED token; the result table with the
 * document's size), Refresh now (a run is claimed - 202 - and the runs table below follows it by polling) and the run history. A
 * `409 run-in-progress` is a normal state ("already running"), never an error. A test writes no mirror: the run is the only writer, so a
 * passing test makes the connection pollable and the first Refresh now (or the next tick) fills the Teams section.
 */
export default function FlowConnectionSection({ connection, readAt }: { connection: FlowConnection; readAt: number }) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const { runs, isLoading, isError, error, live } = useSyncRuns("FLOW", connection.id, true, IDLE_REFRESH_MS);
  const [testResult, setTestResult] = useState<FlowTestResult | null>(null);
  const [alreadyRunningNoted, setAlreadyRunningNoted] = useState(false);
  const [refreshError, setRefreshError] = useState<string | null>(null);

  const test = useMutation({
    mutationFn: () => testFlowConnection(connection.id),
    // A stale result must never sit under a new attempt or a new error.
    onMutate: () => setTestResult(null),
    onSuccess: async (result) => {
      setTestResult(result);
      // The verdict moved with a stored test (and with it whether the connection is polled).
      await refreshQueriesAfterMutation(queryClient, ["flow", "connection", connection.id], ["flow", "list"]);
    },
  });
  const refresh = useMutation({
    mutationFn: () => requestSyncRun({ kind: "FLOW", connectionId: connection.id }),
    onSuccess: () => showSuccessToast(t("flow.toast.refreshStarted")),
    onError: (err) => {
      if (isRunInProgress(err)) setAlreadyRunningNoted(true);
      else setRefreshError(saveErrorMessage(err, t, { forbidden: "flow.saveForbidden", notFound: "flow.saveGone", invalid: "flow.refresh.invalid", failedStatus: "common.error.actionFailedStatus", failed: "common.error.actionFailed" }));
    },
    // Either way the registry now holds a run: re-read it, and the list's own polling takes over while it is unfinished.
    // The connection's status and the registry moved with it too (a run that finished before the first poll never shows as live).
    onSettled: () => refreshQueriesAfterMutation(queryClient, syncRunsKey("FLOW", connection.id), ["flow", "connection", connection.id], ["flow", "list"], ["flow", "teams", connection.id]),
  });
  // The 409 is a state, not a failure; the note stays only while the server still says a run is running.
  const alreadyRunning = alreadyRunningNoted && live;
  // Refresh now waits for a running run (this connection's, started by a person or by the schedule). The polled runs list is the live
  // verdict; the connection's own `status` was read when the page loaded, so it only answers until the first list arrives.
  const running = runs === undefined ? connection.status.lastRun?.running === true : live;
  // When the run that was going ends, the status, last success, next poll and the mirrored teams moved: re-read them.
  const wasRunning = useRef(false);
  useEffect(() => {
    if (wasRunning.current && !live) {
      void refreshQueriesAfterMutation(queryClient, ["flow", "connection", connection.id], ["flow", "list"], ["flow", "teams", connection.id]);
    }
    wasRunning.current = live;
  }, [live, queryClient, connection.id]);

  return (
    <Stack gap="md">
      <Title order={3} size="h4">
        {t("flow.details.connection")}
      </Title>
      <ConnectionFacts connection={connection} readAt={readAt} />

      <Group gap="sm" wrap="wrap">
        <Button variant="default" leftSection={<IconPlugConnected size={16} />} loading={test.isPending} onClick={() => test.mutate()}>
          {t("flow.testConnection")}
        </Button>
        <Button
          variant="default"
          leftSection={<IconPlayerPlay size={16} />}
          loading={refresh.isPending}
          disabled={!connection.enabled || running}
          onClick={() => {
            setRefreshError(null);
            setAlreadyRunningNoted(false);
            refresh.mutate();
          }}
        >
          {t("flow.refreshNow")}
        </Button>
        {!connection.enabled && (
          <Text size="sm" c="dimmed">
            {t("flow.refresh.disabled")}
          </Text>
        )}
      </Group>

      <ConnectionTestStatus result={testResult} />
      {test.isError && <FormErrorAlert>{flowTestErrorMessage(test.error, t)}</FormErrorAlert>}
      {testResult && (
        <Stack gap="xs">
          <Title order={4} size="h5">
            {t("jira.test.resultTitle")}
          </Title>
          {!testResult.recorded && (
            <Alert color="orange" variant="light" role="note">
              {t("jira.test.notRecorded")}
            </Alert>
          )}
          <ConnectionTestResults result={testResult} kind="FLOW" />
        </Stack>
      )}

      {refreshError && <FormErrorAlert>{refreshError}</FormErrorAlert>}
      <div role="status" aria-live="polite">
        {alreadyRunning ? (
          <Text size="sm">{t("flow.refresh.alreadyRunning")}</Text>
        ) : live ? (
          <Text size="sm">{t("flow.refresh.running")}</Text>
        ) : null}
      </div>

      <Stack gap="xs">
        <Title order={4} size="h5">
          {t("jira.runs.title")}
        </Title>
        <SyncRunsTable runs={runs} isLoading={isLoading} isError={isError} error={error} kind="FLOW" />
      </Stack>
    </Stack>
  );
}
