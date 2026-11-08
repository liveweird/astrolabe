import { useTranslation } from "react-i18next";
import { Badge, Stack, Text } from "@mantine/core";
import { SYNC_STATE_COLOR, syncStatusDetail, type SyncStatusContext } from "../utils/syncStatus";

/**
 * A connection's derived sync state (the server's `SyncStatus`, nothing stored): CURRENT green, FAILED red, STALE orange, NEVER_SYNCED and
 * DISABLED gray, with the secondary line under it ("next poll in 7 min", "due now", "manual only", "3 failures in a row · TOKEN_UNREADABLE",
 * "Test the connection first"). `detail={false}` leaves the line out for a table that has columns of its own for it.
 */
export default function SyncStatusBadge({ detail = true, ...context }: SyncStatusContext & { detail?: boolean }) {
  const { t } = useTranslation();
  const line = detail ? syncStatusDetail(context, t) : null;
  return (
    <Stack gap={2} align="flex-start">
      <Badge color={SYNC_STATE_COLOR[context.status.state]} variant="light" tt="none">
        {t(`sync.status.${context.status.state}`)}
      </Badge>
      {line && (
        <Text size="xs" c="dimmed">
          {line}
        </Text>
      )}
    </Stack>
  );
}
