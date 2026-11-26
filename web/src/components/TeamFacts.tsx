import { Anchor, Badge, Group, Text } from "@mantine/core";
import { Link as RouterLink } from "react-router-dom";
import { useTranslation } from "react-i18next";
import type { TeamView } from "../api/teams";
import { conflictCountOf } from "../utils/dependencyArrows";
import { dependenciesFilteredPath, violatedDependenciesPath } from "../utils/dependencyListLinks";
import BadgeLink from "./BadgeLink";

/**
 * The facts line under the title: how many milestones the team has and how many are scheduled, then the warnings — ORANGE badges for
 * the overloaded weeks and the weeks over the WIP limit (warnings, nothing moves), the RED badge for the violated dependencies (as on
 * the project page) and a gray one while the team's own order is in force. The arrows of the timeline are decoration, so their text path is here:
 * the red badge is a link to the team's violated dependencies, and "N dependencies" (only when there are some) to all of them. Both lists are the
 * Roadmap's dependency panel narrowed to this team, which keeps the links with a milestone end in it: the set `view.dependencies` already is.
 */
export default function TeamFacts({ view }: { view: TeamView }) {
  const { t } = useTranslation();
  const overloaded = view.weeks.filter((week) => week.overloaded).length;
  const wip = view.weeks.filter((week) => week.wipExceeded).length;
  const conflicts = conflictCountOf(view.dependencies);
  const links = view.dependencies.length;
  const teamId = view.team.id;
  const conflictsFigure = t("project.conflicts", { count: conflicts });
  const linksFigure = t("teams.view.dependencies", { count: links });
  return (
    <Group gap="md" role="group" aria-label={t("teams.view.factsAria")}>
      <Text size="sm">{t("teams.view.milestones", { count: view.scheduled.length + view.unscheduled.length })}</Text>
      <Text size="sm">{t("teams.view.scheduledCount", { count: view.scheduled.length })}</Text>
      {overloaded > 0 && (
        <Badge color="orange" tt="none">
          {t("teams.view.overloadedWeeks", { count: overloaded })}
        </Badge>
      )}
      {wip > 0 && (
        <Badge color="orange" tt="none">
          {t("teams.view.wipWeeks", { count: wip })}
        </Badge>
      )}
      {conflicts > 0 && (
        <BadgeLink to={violatedDependenciesPath({ teamId })} color="red" ariaLabel={t("teams.view.conflictsAria", { figure: conflictsFigure })}>
          {conflictsFigure}
        </BadgeLink>
      )}
      {view.idleGaps.length > 0 && (
        <Badge color="gray" tt="none">
          {t("timeline.idle.badge", { count: view.idleGaps.length })}
        </Badge>
      )}
      {view.order.custom && (
        <Badge color="gray" tt="none">
          {t("teams.view.customOrder")}
        </Badge>
      )}
      {links > 0 && (
        <Anchor component={RouterLink} to={dependenciesFilteredPath({ teamId })} size="sm" aria-label={t("teams.view.dependenciesAria", { figure: linksFigure })}>
          {linksFigure}
        </Anchor>
      )}
    </Group>
  );
}
