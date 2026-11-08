import { Badge, Table, Text } from "@mantine/core";
import { IconListDetails } from "@tabler/icons-react";
import { useTranslation } from "react-i18next";
import type { SyncKind, SyncRun } from "../api/sync";
import { formatDateTime } from "../utils/formatDate";
import { errorCodeText, RUN_STATE_COLOR, runState } from "../utils/syncRuns";
import EmptyState from "./EmptyState";
import ErrorAlert from "./ErrorAlert";
import ScrollRegion from "./ScrollRegion";
import TableLoadingRow from "./TableLoadingRow";

const COLUMN_COUNT = 8;

/**
 * The connection page's run history: the newest runs first, a bounded list (the registry keeps the last 50). The outcome is read
 * honestly - SUCCEEDED / FAILED / ABANDONED from the outcome, an unfinished row as "Running" or "Interrupted" by the SERVER's `running`
 * verdict (never by this browser's clock) - with a failed run's typed `errorCode` in words, the code kept visible.
 * `errorDetail` is the server's short hint (never a URL or a credential): plain text, clamped.
 */
export default function SyncRunsTable({
  runs,
  isLoading,
  isError,
  error,
  kind = "JIRA",
}: {
  runs: readonly SyncRun[] | undefined;
  isLoading: boolean;
  isError: boolean;
  error: unknown;
  /** The connector: words the two count columns (a Flow run observes teams, not issues) and the error codes. */
  kind?: SyncKind;
}) {
  const { t } = useTranslation();
  const label = t("jira.runs.tableAria");
  return (
    <>
      {isError && <ErrorAlert error={error} title={t("jira.runs.loadFailed")} />}
      <ScrollRegion label={label} minWidth={760}>
        <Table aria-label={label}>
          <Table.Thead>
            <Table.Tr>
              <Table.Th>{t("jira.runs.column.started")}</Table.Th>
              <Table.Th>{t("jira.runs.column.finished")}</Table.Th>
              <Table.Th>{t("jira.runs.column.trigger")}</Table.Th>
              <Table.Th>{t("jira.runs.column.outcome")}</Table.Th>
              <Table.Th ta="right">{t(kind === "FLOW" ? "flow.runs.column.observed" : "jira.runs.column.observed")}</Table.Th>
              <Table.Th ta="right">{t(kind === "FLOW" ? "flow.runs.column.gone" : "jira.runs.column.gone")}</Table.Th>
              <Table.Th ta="right">{t("jira.runs.column.calls")}</Table.Th>
              <Table.Th>{t("jira.runs.column.error")}</Table.Th>
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {isLoading && !runs ? (
              <TableLoadingRow colSpan={COLUMN_COUNT} />
            ) : runs && runs.length > 0 ? (
              runs.map((run) => {
                const state = runState(run);
                return (
                  <Table.Tr key={run.id}>
                    <Table.Td>
                      <Text size="sm">{formatDateTime(run.startedAt)}</Text>
                    </Table.Td>
                    <Table.Td>
                      <Text size="sm" c={run.finishedAt == null ? "dimmed" : undefined}>
                        {run.finishedAt == null ? "—" : formatDateTime(run.finishedAt)}
                      </Text>
                    </Table.Td>
                    <Table.Td>
                      <Text size="sm">{t(`jira.runs.trigger.${run.trigger}`)}</Text>
                    </Table.Td>
                    <Table.Td>
                      <Badge color={RUN_STATE_COLOR[state]} variant="light" tt="none">
                        {t(`jira.runs.state.${state}`)}
                      </Badge>
                      {state === "interrupted" && (
                        <Text size="xs" c="dimmed">
                          {t("jira.runs.interruptedHint")}
                        </Text>
                      )}
                    </Table.Td>
                    <Table.Td ta="right">{run.observedCount}</Table.Td>
                    <Table.Td ta="right">{run.goneCount}</Table.Td>
                    <Table.Td ta="right">
                      <Text size="sm">{run.callCount}</Text>
                      {run.rateLimitedCount > 0 && (
                        <Text size="xs" c="dimmed">
                          {t("jira.runs.rateLimited", { count: run.rateLimitedCount })}
                        </Text>
                      )}
                    </Table.Td>
                    <Table.Td>
                      {run.errorCode ? (
                        <Text size="sm">{errorCodeText(run.errorCode, t, kind)}</Text>
                      ) : (
                        <Text size="sm" c="dimmed">
                          —
                        </Text>
                      )}
                      {run.errorDetail && (
                        <Text size="xs" c="dimmed" lineClamp={2} maw={320} title={run.errorDetail}>
                          {run.errorDetail}
                        </Text>
                      )}
                    </Table.Td>
                  </Table.Tr>
                );
              })
            ) : !isError ? (
              <Table.Tr>
                <Table.Td colSpan={COLUMN_COUNT}>
                  <EmptyState icon={IconListDetails} label={t("jira.runs.empty")} />
                </Table.Td>
              </Table.Tr>
            ) : null}
          </Table.Tbody>
        </Table>
      </ScrollRegion>
    </>
  );
}
