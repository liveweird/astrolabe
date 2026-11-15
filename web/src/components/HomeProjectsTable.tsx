import { Anchor, Table } from "@mantine/core";
import { useTranslation } from "react-i18next";
import { Link as RouterLink } from "react-router-dom";
import type { HomeMe } from "../api/home";
import { violatedDependenciesPath } from "../utils/dependencyListLinks";
import { unscheduledMilestonesPath } from "../utils/milestoneLinks";
import { projectPath } from "../utils/planLinks";
import BadgeLink from "./BadgeLink";
import HomeFlagBadges from "./HomeFlagBadges";
import ScrollRegion from "./ScrollRegion";

/**
 * "Your projects": every project the person may manage through the owner chain (what they own and everything under a work stream or program they own),
 * each row naming its owner. The Roadmap row's flags and rank with the project page's milestone figures and conflicts badge, as the server derives them.
 * A positive "Not scheduled" count is the link to the Milestones page's list for this project (the same set), named with its row.
 */
export default function HomeProjectsTable({ projects }: { projects: HomeMe["projects"] }) {
  const { t } = useTranslation();
  const label = t("home.mine.projects");
  return (
    <ScrollRegion label={label} minWidth={860}>
      <Table aria-label={label}>
        <Table.Thead>
          <Table.Tr>
            <Table.Th>{t("roadmap.column.project")}</Table.Th>
            <Table.Th>{t("home.mine.column.program")}</Table.Th>
            <Table.Th>{t("home.mine.column.owner")}</Table.Th>
            <Table.Th>{t("home.mine.column.rank")}</Table.Th>
            <Table.Th ta="right">{t("home.mine.column.milestones")}</Table.Th>
            <Table.Th ta="right">{t("home.mine.column.notScheduled")}</Table.Th>
            <Table.Th>{t("roadmap.column.flags")}</Table.Th>
            <Table.Th>{t("home.mine.column.conflicts")}</Table.Th>
          </Table.Tr>
        </Table.Thead>
        <Table.Tbody>
          {projects.map((project) => (
            <Table.Tr key={project.id}>
              <Table.Td>
                <Anchor component={RouterLink} to={projectPath(project.id)} size="sm" fw={500} aria-label={t("plan.openProjectAria", { name: project.name })}>
                  {project.name}
                </Anchor>
              </Table.Td>
              <Table.Td>{project.programName}</Table.Td>
              <Table.Td>{project.ownerName}</Table.Td>
              <Table.Td>{project.rankPosition ?? t("roadmap.unrankedDivider")}</Table.Td>
              <Table.Td ta="right">{project.milestones}</Table.Td>
              <Table.Td ta="right">
                {project.unscheduledMilestones > 0 ? (
                  <Anchor
                    component={RouterLink}
                    to={unscheduledMilestonesPath({ projectId: project.id })}
                    size="sm"
                    aria-label={t("home.mine.notScheduledAria", { count: project.unscheduledMilestones, name: project.name })}
                  >
                    {project.unscheduledMilestones}
                  </Anchor>
                ) : (
                  project.unscheduledMilestones
                )}
              </Table.Td>
              <Table.Td>
                <HomeFlagBadges flags={project.flags} />
              </Table.Td>
              <Table.Td>
                {project.conflicts > 0 && (
                  <BadgeLink
                    to={violatedDependenciesPath({ projectId: project.id })}
                    color="red"
                    ariaLabel={t("home.mine.conflictsAria", { figure: t("project.conflicts", { count: project.conflicts }), name: project.name })}
                  >
                    {t("project.conflicts", { count: project.conflicts })}
                  </BadgeLink>
                )}
              </Table.Td>
            </Table.Tr>
          ))}
        </Table.Tbody>
      </Table>
    </ScrollRegion>
  );
}
