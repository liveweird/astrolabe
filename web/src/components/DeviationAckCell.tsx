import { useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { Alert, Button, Group, Stack, Text } from "@mantine/core";
import type { DeviationItem, DeviationLine } from "../api/deviations";
import type { Acknowledge } from "../hooks/useAcknowledge";
import { deviationAckAllKey, deviationAckKey, deviationKindLabel, splitLines } from "../utils/deviations";
import { formatDate, formatDateTime } from "../utils/formatDate";
import FormErrorAlert from "./FormErrorAlert";

/**
 * The message a write left for this row, next to its button where the user is looking: the orange stale note (`role="status"`) or the red refusal
 * (`role="alert"`). Structural, so the Jira `AckNotice` and the Flow capacity `CapacityAckNotice` (`CapacityAckCell`) both fit.
 */
export function AckNoticeAlert({ notice }: { notice: { kind: "stale" } | { kind: "failure"; text: string } }) {
  const { t } = useTranslation();
  return notice.kind === "stale" ? (
    <Alert color="orange" variant="light" role="status" p="xs">
      <Text size="xs">{t("deviations.ack.staleNote")}</Text>
    </Alert>
  ) : (
    <FormErrorAlert p="xs">
      <Text size="xs">{notice.text}</Text>
    </FormErrorAlert>
  );
}

/**
 * One LINE's acknowledgement (1.12), under its badge and sentence in the Deviations cell: who acknowledged and when ("Acknowledged by Ada on 2026-11-06";
 * a stale stamp reads "Acknowledged on 2026-11-06 by Ada · changed since" and the line is open again), then the one button the rights and the state
 * allow - Acknowledge for an open line, Unacknowledge for a current one, both only with the item's `can.acknowledge`. The buttons name the line by the
 * Jira key and its kind ("Acknowledge E2E-3: End") and carry `data-ack-for` (`<bindingId>:<KIND>`) for the focus rule of `useAcknowledge`; while a write
 * is running every button is `aria-disabled` and `data-disabled` (Mantine's disabled look; never the `disabled` attribute or `loading`, which would drop
 * the focus) and ignores clicks. A write's note or refusal for THIS line shows under its button, not at the top of the page, where a row far down would
 * not see it. `neighbours` are the control keys the focus falls back on.
 */
export default function DeviationAckCell({ item, line, ack, neighbours }: { item: DeviationItem; line: DeviationLine; ack: Acknowledge; neighbours: readonly string[] }) {
  const { t } = useTranslation();
  const { acknowledgement } = line;
  const key = deviationAckKey(item.bindingId, line.kind);
  const busy = ack.busyKey !== null;
  const notice = ack.notice?.key === key ? ack.notice : null;
  const date = acknowledgement === null ? "" : formatDate(acknowledgement.at);
  const by = acknowledgement?.by ?? null;
  const jiraKey = item.jira.key;
  const kind = deviationKindLabel(line.kind, t);
  const current = acknowledgement?.current === true;
  const sentence =
    acknowledgement === null
      ? null
      : acknowledgement.current
        ? by === null ? t("deviations.ack.doneUnknown", { date }) : t("deviations.ack.done", { name: by, date })
        : by === null ? t("deviations.ack.staleUnknown", { date }) : t("deviations.ack.stale", { name: by, date });
  return (
    <Stack gap={6} align="flex-start">
      {sentence !== null && acknowledgement !== null && (
        <Text size="sm" title={formatDateTime(acknowledgement.at)}>
          {sentence}
        </Text>
      )}
      {item.can.acknowledge && !current && (
        <Button size="compact-sm" variant="default" data-ack-for={key} aria-label={t("deviations.ack.acknowledgeLineAria", { key: jiraKey, kind })} aria-disabled={busy || undefined} data-disabled={busy || undefined} onClick={() => ack.run({ kind: "acknowledge", item, line }, neighbours)}>
          {t("deviations.ack.acknowledge")}
        </Button>
      )}
      {item.can.acknowledge && current && (
        <Button size="compact-sm" variant="default" data-ack-for={key} aria-label={t("deviations.ack.unacknowledgeLineAria", { key: jiraKey, kind })} aria-disabled={busy || undefined} data-disabled={busy || undefined} onClick={() => ack.run({ kind: "unacknowledge", item, line }, neighbours)}>
          {t("deviations.ack.unacknowledge")}
        </Button>
      )}
      {notice !== null && <AckNoticeAlert notice={notice} />}
    </Stack>
  );
}

/**
 * The head of an item's lines (1.12), the port of Flow's `CapacityAckAll`: **Acknowledge all (N)** - one request with no kind, stamping every line that has
 * no current acknowledgement - offered with `can.acknowledge` and only when at least two of the LISTED lines are open (a stale stamp counts as open; one
 * open line has its own button); **Withdraw all (N)** beside it - one kind-less DELETE clearing every stored stamp of the binding - offered with
 * `can.acknowledge` and at least two listed lines currently acknowledged. Both carry the binding's all-key (`data-ack-for`, busy, notice) and are
 * `aria-disabled` while any write runs, never `disabled` (the focus stays). N counts the lines the item lists. A note or refusal the batch left shows
 * under the buttons, whether or not they are still there; with the item off the list, `DeviationAckOrphanNotice` shows it instead.
 */
export function DeviationAckAll({ item, ack, order }: { item: DeviationItem; ack: Acknowledge; order: readonly string[] }) {
  const { t } = useTranslation();
  const key = deviationAckAllKey(item.bindingId);
  const { open, acknowledged } = splitLines(item);
  const notice = ack.notice?.key === key ? ack.notice : null;
  const offered = item.can.acknowledge && open.length >= 2;
  const withdrawable = item.can.acknowledge && acknowledged.length >= 2;
  if (!offered && !withdrawable && notice === null) return null;
  const busy = ack.busyKey !== null;
  const jiraKey = item.jira.key;
  return (
    <Stack gap={6} align="flex-start">
      {(offered || withdrawable) && (
        <Group gap="xs">
          {offered && (
            <Button size="compact-sm" variant="default" data-ack-for={key} aria-label={t("deviations.ack.acknowledgeAllAria", { count: open.length, key: jiraKey })} aria-disabled={busy || undefined} data-disabled={busy || undefined} onClick={() => ack.run({ kind: "acknowledgeAll", item }, order)}>
              {t("deviations.ack.acknowledgeAll", { count: open.length })}
            </Button>
          )}
          {withdrawable && (
            <Button size="compact-sm" variant="default" data-ack-for={key} aria-label={t("deviations.ack.withdrawAllAria", { count: acknowledged.length, key: jiraKey })} aria-disabled={busy || undefined} data-disabled={busy || undefined} onClick={() => ack.run({ kind: "unacknowledgeAll", item }, order)}>
              {t("deviations.ack.withdrawAll", { count: acknowledged.length })}
            </Button>
          )}
        </Group>
      )}
      {notice !== null && <AckNoticeAlert notice={notice} />}
    </Stack>
  );
}

/**
 * A write's message for a control that has LEFT the list (a line that disappeared on the re-read, a 409 that dropped its row): its place is gone, so the
 * page shows the message above the table and brings it into view. A message for a control that is still listed is under that control. `listedKeys` are
 * the keys the rendered rows hold (`itemAckKeys` of every listed item that has lines).
 */
export function DeviationAckOrphanNotice({ ack, listedKeys }: { ack: Acknowledge; listedKeys: ReadonlySet<string> }) {
  const ref = useRef<HTMLDivElement>(null);
  const { notice } = ack;
  const orphaned = notice !== null && !listedKeys.has(notice.key);
  useEffect(() => {
    if (orphaned) ref.current?.scrollIntoView?.({ block: "nearest" });
  }, [orphaned, notice]);
  return orphaned ? (
    <div ref={ref}>
      <AckNoticeAlert notice={notice} />
    </div>
  ) : null;
}
