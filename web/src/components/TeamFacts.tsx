import { Badge, Group, Text } from "@mantine/core";
import { useTranslation } from "react-i18next";
import type { TeamView } from "../api/teams";
import { conflictCountOf } from "../utils/dependencyArrows";

/**
 * The facts line under the title: how many milestones the team has and how many are scheduled, then the warnings — ORANGE badges for
 * the overloaded weeks and the weeks over the WIP limit (warnings, nothing moves), the RED badge for the violated dependencies (as on
 * the project page) and a gray one while the team's own order is in force.
 */
export default function TeamFacts({ view }: { view: TeamView }) {
  const { t } = useTranslation();
  const overloaded = view.weeks.filter((week) => week.overloaded).length;
  const wip = view.weeks.filter((week) => week.wipExceeded).length;
  const conflicts = conflictCountOf(view.dependencies);
  return (
    <Group gap="md" role="group" aria-label={t("teams.view.factsAria")}>
      <Text size="sm">{t("teams.view.milestones", { count: view.scheduled.length + view.unscheduled.length })}</Text>
      <Text size="sm">{t("teams.view.scheduledCount", { count: view.scheduled.length })}</Text>
      {overloaded > 0 && (
        <Badge color="orange" variant="light" tt="none">
          {t("teams.view.overloadedWeeks", { count: overloaded })}
        </Badge>
      )}
      {wip > 0 && (
        <Badge color="orange" variant="light" tt="none">
          {t("teams.view.wipWeeks", { count: wip })}
        </Badge>
      )}
      {conflicts > 0 && (
        <Badge color="red" variant="light" tt="none">
          {t("project.conflicts", { count: conflicts })}
        </Badge>
      )}
      {view.idleGaps.length > 0 && (
        <Badge color="gray" variant="light" tt="none">
          {t("timeline.idle.badge", { count: view.idleGaps.length })}
        </Badge>
      )}
      {view.order.custom && (
        <Badge color="gray" variant="light" tt="none">
          {t("teams.view.customOrder")}
        </Badge>
      )}
    </Group>
  );
}
