import { Text } from "@mantine/core";
import type { ProjectMilestone } from "../api/milestones";

/**
 * The name with the description as dimmed text after it; one line (rows are a fixed height), the cell clips the rest. `mark` (a milestone new since the
 * baseline) goes right after the name, then `note` (a tray row's "Jira: start to end").
 */
export default function NameCell({ milestone, mark, note }: { milestone: ProjectMilestone; mark?: string; note?: string }) {
  return (
    <Text component="span" size="sm" truncate>
      <Text span fw={500}>
        {milestone.name}
      </Text>
      {mark !== undefined && (
        <Text span c="dimmed">
          {" "}
          {mark}
        </Text>
      )}
      {note !== undefined && (
        <Text span c="dimmed">
          {" "}
          {note}
        </Text>
      )}
      {milestone.description && (
        <Text span c="dimmed">
          {" "}
          {milestone.description}
        </Text>
      )}
    </Text>
  );
}
