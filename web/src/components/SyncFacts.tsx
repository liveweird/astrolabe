import type { ReactNode } from "react";
import type { ParseKeys } from "i18next";
import { useTranslation } from "react-i18next";
import { Table, Text } from "@mantine/core";
import type { SyncStatus } from "../api/sync";
import { useNow } from "../hooks/useNow";
import { ageText } from "../utils/deviations";
import { formatDateTime } from "../utils/formatDate";
import { isDue, nextPollText, pollingText } from "../utils/syncStatus";
import ConnectionTestBadge from "./ConnectionTestBadge";
import SyncStatusBadge from "./SyncStatusBadge";

/** One row of a connection's facts table: a row header and its value. */
export function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <Table.Tr>
      <Table.Th scope="row" w="30%">
        {label}
      </Table.Th>
      <Table.Td style={{ overflowWrap: "anywhere" }}>{children}</Table.Td>
    </Table.Tr>
  );
}

/** A connection page's facts table: the table and its accessible name; the rows are the caller's (the connector's own facts, then the shared ones). */
export function FactsTable({ children }: { children: ReactNode }) {
  const { t } = useTranslation();
  return (
    <Table aria-label={t("sync.connection.details.factsAria")}>
      <Table.Tbody>{children}</Table.Tbody>
    </Table>
  );
}

/** The API-token row: never the token, only whether one is stored (the label is the connector's). */
export function TokenFact({ label, stored }: { label: string; stored: boolean }) {
  const { t } = useTranslation();
  return <Fact label={label}>{stored ? t("sync.connection.details.tokenStored") : t("sync.connection.details.tokenMissing")}</Fact>;
}

/** The "Enabled" row: yes or no. */
export function EnabledFact({ enabled }: { enabled: boolean }) {
  const { t } = useTranslation();
  return <Fact label={t("sync.connection.column.enabled")}>{enabled ? t("sync.connection.yes") : t("sync.connection.no")}</Fact>;
}

/** The last-test row: the stored verdict, or the connector's "no verdict" sentence (`untestedKey`). */
export function LastTestFact({ lastTestOk, lastTestedAt, untestedKey }: { lastTestOk: boolean | null; lastTestedAt: number | null; untestedKey: ParseKeys }) {
  const { t } = useTranslation();
  return (
    <Fact label={t("sync.connection.details.lastTest")}>
      <ConnectionTestBadge lastTestOk={lastTestOk} lastTestedAt={lastTestedAt} untestedKey={untestedKey} layout="fact" />
    </Fact>
  );
}

/**
 * The sync facts shared by the connection pages (Jira, Flow): the derived state, the last success (when the data is as of), when the next poll is
 * and the interval itself. `ready` is the connector's "pollable" verdict (a Jira discovery; a passing Flow test or a mirrored Flow document).
 */
export default function SyncFacts({
  status,
  pollIntervalMinutes,
  ready,
  readAt,
}: {
  status: SyncStatus;
  pollIntervalMinutes: number | null;
  ready: boolean;
  readAt: number;
}) {
  const { t } = useTranslation();
  const now = useNow(60_000, readAt);
  const context = { status, now, ready, pollIntervalMinutes };
  const nextText = nextPollText(context, t);
  return (
    <>
      <Fact label={t("sync.details.status")}>
        <SyncStatusBadge {...context} />
      </Fact>
      <Fact label={t("sync.details.lastSuccess")}>
        {status.lastSucceededAt === null ? (
          "—"
        ) : (
          <>
            <Text size="sm">{formatDateTime(status.lastSucceededAt)}</Text>
            <Text size="xs" c="dimmed">
              {ageText(status.lastSucceededAt, now, t)}
            </Text>
          </>
        )}
      </Fact>
      <Fact label={t("sync.details.nextPoll")}>
        {status.nextPollAt === null || isDue(status, now) ? (
          // Nothing to date: not polled, or due this moment ("due now" alone; the past instant it was due since would only mislead).
          (nextText ?? "—")
        ) : (
          <>
            <Text size="sm">{formatDateTime(status.nextPollAt)}</Text>
            <Text size="xs" c="dimmed">
              {nextText}
            </Text>
          </>
        )}
      </Fact>
      <Fact label={t("sync.details.polling")}>{pollingText(pollIntervalMinutes, t)}</Fact>
    </>
  );
}
