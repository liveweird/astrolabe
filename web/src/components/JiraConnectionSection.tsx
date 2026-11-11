import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Alert, Anchor, Button, Group, Stack, Table, Text, Title } from "@mantine/core";
import { IconPlayerPlay, IconPlugConnected } from "@tabler/icons-react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { testJiraConnection, type JiraConnection, type JiraTestResult } from "../api/jira";
import { isRunInProgress, requestSyncRun } from "../api/sync";
import { useSyncRuns, syncRunsKey } from "../hooks/useSyncRuns";
import { formatDateTime } from "../utils/formatDate";
import { jiraTestErrorMessage, untestedKey } from "../utils/jiraForm";
import { jiraSiteUrl } from "../utils/jiraLinks";
import { refreshQueriesAfterMutation } from "../utils/queryRefresh";
import { saveErrorMessage } from "../utils/saveError";
import { IDLE_REFRESH_MS } from "../utils/syncRuns";
import { showSuccessToast } from "../utils/toast";
import ConnectionTestBadge from "./ConnectionTestBadge";
import ConnectionTestResults from "./ConnectionTestResults";
import ConnectionTestStatus from "./ConnectionTestStatus";
import FormErrorAlert from "./FormErrorAlert";
import JiraStubBadge from "./JiraStubBadge";
import SyncRunsTable from "./SyncRunsTable";
import SyncFacts, { Fact } from "./SyncFacts";

/** The connection's own facts (never the token: only whether one is stored). */
function ConnectionFacts({ connection, readAt }: { connection: JiraConnection; readAt: number }) {
  const { t } = useTranslation();
  const site = jiraSiteUrl(connection.siteUrl);
  return (
    <Table aria-label={t("jira.details.factsAria")}>
      <Table.Tbody>
        <Fact label={t("jira.field.siteUrl")}>
          <Group gap="xs" wrap="wrap">
            {site ? (
              <Anchor href={site} target="_blank" rel="noopener noreferrer" size="sm">
                {connection.siteUrl}
              </Anchor>
            ) : (
              <Text size="sm">{connection.siteUrl}</Text>
            )}
            {connection.stub && <JiraStubBadge />}
          </Group>
        </Fact>
        <Fact label={t("jira.field.email")}>{connection.email}</Fact>
        <Fact label={t("jira.field.apiToken")}>{connection.hasApiToken ? t("jira.details.tokenStored") : t("jira.details.tokenMissing")}</Fact>
        <Fact label={t("jira.field.authScheme")}>{t(`jira.authScheme.${connection.authScheme}`)}</Fact>
        <Fact label={t("jira.field.projectKeys")}>{connection.projectKeys.join(", ")}</Fact>
        <Fact label={t("jira.column.enabled")}>{connection.enabled ? t("jira.yes") : t("jira.no")}</Fact>
        <SyncFacts status={connection.status} pollIntervalMinutes={connection.pollIntervalMinutes} ready={connection.discoveredAt !== null} readAt={readAt} />
        <Fact label={t("jira.details.lastTest")}>
          <ConnectionTestBadge lastTestOk={connection.lastTestOk} lastTestedAt={connection.lastTestedAt} untestedKey={untestedKey(connection)} layout="fact" />
        </Fact>
        <Fact label={t("jira.details.discovered")}>{connection.discoveredAt === null ? "—" : formatDateTime(connection.discoveredAt)}</Fact>
        <Fact label={t("jira.details.cloudId")}>{connection.cloudId ?? "—"}</Fact>
        <Fact label={t("jira.details.mapping")}>{connection.mappingSet ? t("jira.details.mappingSaved") : t("jira.details.mappingDefaults")}</Fact>
      </Table.Tbody>
    </Table>
  );
}

/**
 * The connection page's first section: the facts, Test connection (the STORED token; the result table with its scope hints, and the
 * discovery it stores), Refresh now (a run is claimed - 202 - and the runs table below follows it by polling) and the run history. A
 * `409 run-in-progress` is a normal state ("already running"), never an error.
 */
export default function JiraConnectionSection({ connection, readAt }: { connection: JiraConnection; readAt: number }) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const { runs, isLoading, isError, error, live } = useSyncRuns("JIRA", connection.id, true, IDLE_REFRESH_MS);
  const [testResult, setTestResult] = useState<JiraTestResult | null>(null);
  const [alreadyRunningNoted, setAlreadyRunningNoted] = useState(false);
  const [refreshError, setRefreshError] = useState<string | null>(null);

  const test = useMutation({
    mutationFn: () => testJiraConnection(connection.id),
    // A stale result must never sit under a new attempt or a new error.
    onMutate: () => setTestResult(null),
    onSuccess: async (result) => {
      setTestResult(result);
      // The verdict, the discovery and the mapping defaults all moved with a stored test.
      await refreshQueriesAfterMutation(queryClient, ["jira"]);
    },
  });
  const refresh = useMutation({
    mutationFn: () => requestSyncRun({ kind: "JIRA", connectionId: connection.id }),
    onSuccess: () => showSuccessToast(t("jira.toast.refreshStarted")),
    onError: (err) => {
      if (isRunInProgress(err)) setAlreadyRunningNoted(true);
      else setRefreshError(saveErrorMessage(err, t, { tooManyRequests: "common.error.tooManyRequests", forbidden: "jira.saveForbidden", notFound: "jira.saveGone", invalid: "jira.refresh.invalid", failedStatus: "common.error.actionFailedStatus", failed: "common.error.actionFailed" }));
    },
    // Either way the registry now holds a run: re-read it, and the list's own polling takes over while it is unfinished.
    // The connection's status and the registry moved with it too (a run that finished before the first poll never shows as live).
    onSettled: () => refreshQueriesAfterMutation(queryClient, syncRunsKey("JIRA", connection.id), ["jira", "connection", connection.id], ["jira", "list"]),
  });
  // The 409 is a state, not a failure; the note stays only while the server still says a run is running.
  const alreadyRunning = alreadyRunningNoted && live;
  // Refresh now waits for a running run (this connection's, started by a person or by the schedule). The polled runs list is the live
  // verdict; the connection's own `status` was read when the page loaded, so it only answers until the first list arrives. The list is
  // re-read every IDLE_REFRESH_MS even after the fast poll's safety net stopped, so a run the server no longer calls running frees the
  // button within one period (and a 409 "already running" covers the gap).
  const running = runs === undefined ? connection.status.lastRun?.running === true : live;
  // When the run that was going ends, the status, last success and next poll moved: re-read the connection and the registry.
  const wasRunning = useRef(false);
  useEffect(() => {
    if (wasRunning.current && !live) void refreshQueriesAfterMutation(queryClient, ["jira", "connection", connection.id], ["jira", "list"]);
    wasRunning.current = live;
  }, [live, queryClient, connection.id]);

  return (
    <Stack gap="md">
      <Title order={3} size="h4">
        {t("jira.details.connection")}
      </Title>
      <ConnectionFacts connection={connection} readAt={readAt} />

      <Group gap="sm" wrap="wrap">
        <Button variant="default" leftSection={<IconPlugConnected size={16} />} loading={test.isPending} onClick={() => test.mutate()}>
          {t("jira.testConnection")}
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
          {t("jira.refreshNow")}
        </Button>
        {!connection.enabled && (
          <Text size="sm" c="dimmed">
            {t("jira.refresh.disabled")}
          </Text>
        )}
      </Group>

      <ConnectionTestStatus result={testResult} />
      {test.isError && <FormErrorAlert>{jiraTestErrorMessage(test.error, t)}</FormErrorAlert>}
      {testResult && (
        <Stack gap="xs">
          <Title order={4} size="h5">
            {t("sync.test.resultTitle")}
          </Title>
          {!testResult.recorded && (
            <Alert color="orange" variant="light" role="note">
              {t("sync.test.notRecorded")}
            </Alert>
          )}
          <ConnectionTestResults result={testResult} />
        </Stack>
      )}

      {refreshError && <FormErrorAlert>{refreshError}</FormErrorAlert>}
      <div role="status" aria-live="polite">
        {alreadyRunning ? (
          <Text size="sm">{t("jira.refresh.alreadyRunning")}</Text>
        ) : live ? (
          <Text size="sm">{t("jira.refresh.running")}</Text>
        ) : null}
      </div>

      <Stack gap="xs">
        <Title order={4} size="h5">
          {t("sync.runs.title")}
        </Title>
        <SyncRunsTable runs={runs} isLoading={isLoading} isError={isError} error={error} />
      </Stack>
    </Stack>
  );
}
