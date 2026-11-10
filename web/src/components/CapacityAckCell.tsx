import { useEffect, useRef } from "react";
import type { TFunction } from "i18next";
import { useTranslation } from "react-i18next";
import { Button, Stack, Text } from "@mantine/core";
import type { CapacityDeviation, CapacityDeviationCan } from "../api/capacityDeviations";
import type { CapacityAcknowledge } from "../hooks/useCapacityAcknowledge";
import { capacityAckKey, isOpen } from "../utils/capacityDeviations";
import { formatDate, formatDateTime } from "../utils/formatDate";
import { AckNoticeAlert } from "./DeviationAckCell";

/** What a list needs to offer the acknowledge on its rows: the item's `can`, the binding the rows belong to and the write's state machine. */
export type CapacityAckContext = { can: CapacityDeviationCan; bindingId: number; hook: CapacityAcknowledge };

/** The row's name in a button's accessible name: Flow's sprint name, "Sprint 90002" when it has none, "the team's own row" for the gone team. */
function rowName(row: CapacityDeviation, t: TFunction): string {
  const { sprintId, sprintName } = row.detail;
  if (sprintId === null) return t("deviations.capacity.ack.teamRow");
  return sprintName ?? t("deviations.capacity.sprintId", { id: sprintId });
}

/**
 * One sprint row's acknowledge cell: who acknowledged and when ("Acknowledged by Ada on 2026-11-06"; a stale one reads "Acknowledged on 2026-11-06 by
 * Ada · changed since" and the row is open again - the Jira cell's sentences, the same words), then the one button the rights and the state allow:
 * Acknowledge for an open row, Unacknowledge for a current one - both only with `can.acknowledge`. The buttons name their row by the sprint and
 * carry `data-ack-for` (`<bindingId>:<sprintId|team>`) for the focus rule of `useCapacityAcknowledge`; while a write is running every button is
 * `aria-disabled` and `data-disabled` (never the `disabled` attribute or `loading`, which would drop the focus) and ignores clicks. A write's note or
 * refusal for THIS row shows under the buttons, not at the top of the page, where a row far down would not see it.
 */
export default function CapacityAckCell({ row, ack, neighbours }: { row: CapacityDeviation; ack: CapacityAckContext; neighbours: readonly string[] }) {
  const { t } = useTranslation();
  const { acknowledgement } = row;
  const { bindingId, can, hook } = ack;
  const key = capacityAckKey(bindingId, row.detail.sprintId);
  const busy = hook.busyKey !== null;
  const notice = hook.notice?.key === key ? hook.notice : null;
  const date = acknowledgement === null ? "" : formatDate(acknowledgement.at);
  const by = acknowledgement?.by ?? null;
  const sentence =
    acknowledgement === null
      ? null
      : acknowledgement.current
        ? by === null ? t("deviations.ack.doneUnknown", { date }) : t("deviations.ack.done", { name: by, date })
        : by === null ? t("deviations.ack.staleUnknown", { date }) : t("deviations.ack.stale", { name: by, date });
  const sprint = rowName(row, t);
  const open = isOpen(row);
  return (
    <Stack gap={6} align="flex-start">
      {sentence !== null && acknowledgement !== null && (
        <Text size="sm" title={formatDateTime(acknowledgement.at)}>
          {sentence}
        </Text>
      )}
      {can.acknowledge && open && (
        <Button size="compact-sm" variant="default" data-ack-for={key} aria-label={t("deviations.capacity.ack.acknowledgeAria", { sprint })} aria-disabled={busy || undefined} data-disabled={busy || undefined} onClick={() => hook.run({ kind: "acknowledge", bindingId, row }, neighbours)}>
          {t("deviations.ack.acknowledge")}
        </Button>
      )}
      {can.acknowledge && !open && (
        <Button size="compact-sm" variant="default" data-ack-for={key} aria-label={t("deviations.capacity.ack.unacknowledgeAria", { sprint })} aria-disabled={busy || undefined} data-disabled={busy || undefined} onClick={() => hook.run({ kind: "unacknowledge", bindingId, row }, neighbours)}>
          {t("deviations.ack.unacknowledge")}
        </Button>
      )}
      {notice !== null && <AckNoticeAlert notice={notice} />}
    </Stack>
  );
}

/**
 * A write's message for a row that has LEFT the list (an acknowledged row leaving Open, a 409 that dropped it): the row's cell is gone, so the list
 * shows it above itself and brings it into view. A message for a row that is still listed is in that row's cell (`CapacityAckCell`).
 */
export function CapacityAckOrphanNotice({ hook, listedKeys }: { hook: CapacityAcknowledge; listedKeys: ReadonlySet<string> }) {
  const ref = useRef<HTMLDivElement>(null);
  const { notice } = hook;
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
