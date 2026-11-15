import { useTranslation } from "react-i18next";
import { Badge, Group, Text } from "@mantine/core";
import type { SyncStatus } from "../api/sync";
import { formatDateTime } from "../utils/formatDate";
import { RUN_STATE_COLOR, runState } from "../utils/syncRuns";

/**
 * A connection's own newest run in the registry lists (Jira, Flow), from its `lastRun` (the SERVER says whether it is running): its outcome
 * badge and when it started; a dash when no run exists.
 */
export default function LastRunCell({ run }: { run: SyncStatus["lastRun"] }) {
  const { t } = useTranslation();
  if (!run) {
    return (
      <Text size="sm" c="dimmed">
        —
      </Text>
    );
  }
  const state = runState(run);
  return (
    <Group gap="xs" wrap="nowrap">
      <Badge color={RUN_STATE_COLOR[state]} tt="none">
        {t(`sync.runs.state.${state}`)}
      </Badge>
      <Text size="sm">{formatDateTime(run.startedAt)}</Text>
    </Group>
  );
}
