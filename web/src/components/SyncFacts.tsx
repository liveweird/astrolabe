import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Table, Text } from "@mantine/core";
import type { SyncStatus } from "../api/sync";
import { useNow } from "../hooks/useNow";
import { ageText } from "../utils/deviations";
import { formatDateTime } from "../utils/formatDate";
import { isDue, nextPollText, pollingText } from "../utils/syncStatus";
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
