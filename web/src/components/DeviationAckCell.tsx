import { useTranslation } from "react-i18next";
import { Alert, Button, Stack, Text } from "@mantine/core";
import type { DeviationItem } from "../api/deviations";
import type { Acknowledge, AckNotice } from "../hooks/useAcknowledge";
import { ackActions } from "../utils/deviations";
import { formatDate, formatDateTime } from "../utils/formatDate";
import FormErrorAlert from "./FormErrorAlert";

/** The message a write left for this row, next to its button where the user is looking: the orange stale note (`role="status"`) or the red refusal (`role="alert"`). */
export function AckNoticeAlert({ notice }: { notice: AckNotice }) {
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
 * The row's last cell: who acknowledged and when ("Acknowledged by Ada on 2026-11-06"; a stale one reads "Acknowledged on 2026-11-06 by Ada · changed
 * since" and the item is open again), then the one button the rights and the state allow. The buttons name their row by the Jira key and carry
 * `data-ack-for` for the focus rule of `useAcknowledge`; while a write is running every button is `aria-disabled` and `data-disabled` (Mantine's
 * disabled look; never the `disabled` attribute or `loading`, which would drop the focus) and ignores clicks. A write's note or refusal
 * for THIS row shows under the buttons (`AckNoticeAlert`), not at the top of the page, where a row far down would not see it.
 */
export default function DeviationAckCell({ item, ack, neighbours }: { item: DeviationItem; ack: Acknowledge; neighbours: readonly number[] }) {
  const { t } = useTranslation();
  const { acknowledgement } = item;
  const actions = ackActions(item);
  const busy = ack.busyId !== null;
  const notice = ack.notice?.bindingId === item.bindingId ? ack.notice : null;
  const date = acknowledgement === null ? "" : formatDate(acknowledgement.at);
  const by = acknowledgement?.by ?? null;
  const key = item.jira.key;
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
      {actions.acknowledge && (
        <Button size="compact-sm" variant="default" data-ack-for={item.bindingId} aria-label={t("deviations.ack.acknowledgeAria", { key })} aria-disabled={busy || undefined} data-disabled={busy || undefined} onClick={() => ack.run({ kind: "acknowledge", item }, neighbours)}>
          {t("deviations.ack.acknowledge")}
        </Button>
      )}
      {actions.unacknowledge && (
        <Button size="compact-sm" variant="default" data-ack-for={item.bindingId} aria-label={t("deviations.ack.unacknowledgeAria", { key })} aria-disabled={busy || undefined} data-disabled={busy || undefined} onClick={() => ack.run({ kind: "unacknowledge", item }, neighbours)}>
          {t("deviations.ack.unacknowledge")}
        </Button>
      )}
      {notice !== null && <AckNoticeAlert notice={notice} />}
    </Stack>
  );
}
