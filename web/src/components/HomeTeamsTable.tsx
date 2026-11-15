import { Anchor, Badge, Group, Table } from "@mantine/core";
import { useTranslation } from "react-i18next";
import { Link as RouterLink } from "react-router-dom";
import type { HomeMe } from "../api/home";
import { violatedDependenciesPath } from "../utils/dependencyListLinks";
import { deviationsForTeamPath } from "../utils/deviationLinks";
import { unscheduledMilestonesPath } from "../utils/milestoneLinks";
import { teamPath } from "../utils/teamLinks";
import BadgeLink from "./BadgeLink";
import { DeviationCount } from "./JiraChips";
import ScrollRegion from "./ScrollRegion";
import TeamFlags from "./TeamFlags";

/**
 * "Your teams": the figures of the team page's header and facts line. Capacity is its two orange badges, Jira its chip's count badge (a link into the
 * Deviations page filtered to the team, only when positive; "may be out of date" is said once by the section) and Flow the header's sentence badge.
 * A positive "Not scheduled" count is the link to the Milestones page's list for this team (the same set), named with its row; the capacity badges stay
 * badges (the team's name opens the page that shows them first).
 */
export default function HomeTeamsTable({ teams }: { teams: HomeMe["teams"] }) {
  const { t } = useTranslation();
  const label = t("home.mine.teams");
  return (
    <ScrollRegion label={label} minWidth={820}>
      <Table aria-label={label}>
        <Table.Thead>
          <Table.Tr>
            <Table.Th>{t("home.mine.column.team")}</Table.Th>
            <Table.Th ta="right">{t("home.mine.column.milestones")}</Table.Th>
            <Table.Th ta="right">{t("home.mine.column.notScheduled")}</Table.Th>
            <Table.Th>{t("home.mine.column.capacity")}</Table.Th>
            <Table.Th>{t("home.mine.column.conflicts")}</Table.Th>
            <Table.Th>{t("home.mine.column.jira")}</Table.Th>
            <Table.Th>{t("home.mine.column.flow")}</Table.Th>
          </Table.Tr>
        </Table.Thead>
        <Table.Tbody>
          {teams.map((team) => (
            <Table.Tr key={team.id}>
              <Table.Td>
                <Anchor component={RouterLink} to={teamPath(team.id)} size="sm" fw={500} aria-label={t("teams.openAria", { name: team.name })}>
                  {team.name}
                </Anchor>
              </Table.Td>
              <Table.Td ta="right">{team.milestones}</Table.Td>
              <Table.Td ta="right">
                {team.unscheduledMilestones > 0 ? (
                  <Anchor
                    component={RouterLink}
                    to={unscheduledMilestonesPath({ teamId: team.id })}
                    size="sm"
                    aria-label={t("home.mine.notScheduledAria", { count: team.unscheduledMilestones, name: team.name })}
                  >
                    {team.unscheduledMilestones}
                  </Anchor>
                ) : (
                  team.unscheduledMilestones
                )}
              </Table.Td>
              <Table.Td>
                <Group gap="xs" wrap="wrap">
                  {team.overloadedWeeks > 0 && (
                    <Badge color="orange" variant="light" tt="none">
                      {t("teams.view.overloadedWeeks", { count: team.overloadedWeeks })}
                    </Badge>
                  )}
                  {team.wipExceededWeeks > 0 && (
                    <Badge color="orange" variant="light" tt="none">
                      {t("teams.view.wipWeeks", { count: team.wipExceededWeeks })}
                    </Badge>
                  )}
                </Group>
              </Table.Td>
              <Table.Td>
                {team.conflicts > 0 && (
                  <BadgeLink
                    to={violatedDependenciesPath({ teamId: team.id })}
                    color="red"
                    ariaLabel={t("home.mine.conflictsAria", { figure: t("project.conflicts", { count: team.conflicts }), name: team.name })}
                  >
                    {t("project.conflicts", { count: team.conflicts })}
                  </BadgeLink>
                )}
              </Table.Td>
              <Table.Td>
                {team.jira.warnings + team.jira.infos > 0 && (
                  <Group gap="xs">
                    <DeviationCount
                      to={deviationsForTeamPath(team.id)}
                      warnings={team.jira.warnings}
                      infos={team.jira.infos}
                      stale={false}
                      ariaLabel={t("home.mine.jiraAria", { deviations: t("deviations.chip.count", { count: team.jira.warnings + team.jira.infos }), name: team.name })}
                    />
                  </Group>
                )}
              </Table.Td>
              <Table.Td>
                <TeamFlags flags={team.flags} />
              </Table.Td>
            </Table.Tr>
          ))}
        </Table.Tbody>
      </Table>
    </ScrollRegion>
  );
}
