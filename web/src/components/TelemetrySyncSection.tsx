import { useTranslation } from "react-i18next";
import { Alert, Badge, Stack, Table, Text } from "@mantine/core";
import type { TelemetryCurrent, TelemetrySyncConnection } from "../api/telemetry";
import { ageText } from "../utils/deviations";
import { formatDateTime } from "../utils/formatDate";
import { nextPollText, pollingText } from "../utils/syncStatus";
import ScrollRegion from "./ScrollRegion";
import SyncStatusBadge from "./SyncStatusBadge";

function State({ connection, now }: { connection: TelemetrySyncConnection; now: number }) {
  const { t } = useTranslation();
  return (
    <>
      <SyncStatusBadge status={connection.status} now={now} detail={false} />
      {connection.status.lastRun?.running && (
        <Text size="xs" c="dimmed">
          {t("telemetry.sync.running")}
        </Text>
      )}
    </>
  );
}

function LastSuccess({ connection, now }: { connection: TelemetrySyncConnection; now: number }) {
  const { t } = useTranslation();
  const at = connection.status.lastSucceededAt;
  if (at === null) {
    return (
      <Text size="sm" c="dimmed">
        {t("telemetry.sync.never")}
      </Text>
    );
  }
  return (
    <>
      <Text size="sm">{ageText(at, now, t)}</Text>
      <Text size="xs" c="dimmed">
        {formatDateTime(at)}
      </Text>
    </>
  );
}

function Failures({ connection }: { connection: TelemetrySyncConnection }) {
  const { t } = useTranslation();
  const { status } = connection;
  if (status.consecutiveFailures === 0) return <>0</>;
  const code = status.lastRun?.errorCode;
  return (
    <>
      <Badge color="red" variant="light" tt="none">
        {t("sync.status.failuresInARow", { count: status.consecutiveFailures })}
      </Badge>
      {code && (
        <Text size="xs" c="dimmed">
          {code}
        </Text>
      )}
    </>
  );
}

/**
 * Sync: whether this process runs the scheduler and, per connection of the connector, its derived state, the age of the last success, the
 * failure streak with the newest run's code, when it is polled next and how often. Only the current figures (the server derives them per
 * read; nothing is sampled, so there is no trend). `now` is the server's own `generatedAt`, so the ages need no browser clock.
 */
export default function TelemetrySyncSection({ current }: { current: TelemetryCurrent }) {
  const { t } = useTranslation();
  const { sync, generatedAt: now } = current;
  return (
    <Stack gap="md">
      {sync.schedulerEnabled ? (
        <Text size="xs" c="dimmed">
          {t("telemetry.sync.schedulerOn", { seconds: sync.tickSeconds })}
        </Text>
      ) : (
        <Alert color="orange" variant="light" role="note">
          {t("telemetry.sync.schedulerOff")}
        </Alert>
      )}
      {sync.connections.length === 0 ? (
        <Text size="sm" c="dimmed">
          {t("telemetry.sync.none")}
        </Text>
      ) : (
        <ScrollRegion label={t("telemetry.sync.tableAria")} minWidth={640}>
          <Table aria-label={t("telemetry.sync.tableAria")} verticalSpacing="xs">
            <Table.Thead>
              <Table.Tr>
                <Table.Th>{t("telemetry.sync.column.connection")}</Table.Th>
                <Table.Th>{t("telemetry.sync.column.state")}</Table.Th>
                <Table.Th>{t("telemetry.sync.column.lastSuccess")}</Table.Th>
                <Table.Th>{t("telemetry.sync.column.failures")}</Table.Th>
                <Table.Th>{t("telemetry.sync.column.nextPoll")}</Table.Th>
                <Table.Th>{t("telemetry.sync.column.polling")}</Table.Th>
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {sync.connections.map((connection) => (
                <Table.Tr key={`${connection.kind}:${connection.connectionId}`}>
                  <Table.Td>
                    <Text size="sm" fw={500}>
                      {connection.name}
                    </Text>
                    <Text size="xs" c="dimmed">
                      {t(`telemetry.sync.kind.${connection.kind}`)}
                    </Text>
                  </Table.Td>
                  <Table.Td>
                    <State connection={connection} now={now} />
                  </Table.Td>
                  <Table.Td>
                    <LastSuccess connection={connection} now={now} />
                  </Table.Td>
                  <Table.Td>
                    <Failures connection={connection} />
                  </Table.Td>
                  <Table.Td>
                    <Text size="sm">{nextPollText({ status: connection.status, now, ready: connection.ready, pollIntervalMinutes: connection.pollIntervalMinutes }, t) ?? "—"}</Text>
                  </Table.Td>
                  <Table.Td>
                    <Text size="sm">{pollingText(connection.pollIntervalMinutes, t)}</Text>
                  </Table.Td>
                </Table.Tr>
              ))}
            </Table.Tbody>
          </Table>
        </ScrollRegion>
      )}
    </Stack>
  );
}
