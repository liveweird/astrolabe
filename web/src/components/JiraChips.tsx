import { Link as RouterLink } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { Badge, Button, Group, Text } from "@mantine/core";
import { IconBrandJira, IconLinkOff } from "@tabler/icons-react";
import { deviationsForProjectPath, deviationsForTeamPath } from "../utils/deviationLinks";
import { markKey, type JiraMark, type JiraMarks } from "../utils/jiraMarks";
import JiraKeyLink from "./JiraKeyLink";

/** The open-flag count as a link into the Deviations page (orange when it holds a warning, gray when only infos); "No deviations seen" when there is none. */
function DeviationCount({ to, warnings, infos }: { to: string; warnings: number; infos: number }) {
  const { t } = useTranslation();
  const count = warnings + infos;
  if (count === 0) {
    return (
      <Badge color="gray" variant="light" tt="none" component={RouterLink} to={to}>
        {t("deviations.chip.inLine")}
      </Badge>
    );
  }
  return (
    <Badge color={warnings > 0 ? "orange" : "gray"} variant="light" tt="none" component={RouterLink} to={to}>
      {t("deviations.chip.count", { count })}
    </Badge>
  );
}

/**
 * The project page's Jira chip, in the facts line, built from the project VIEW's own `jira` blocks (`projectMarks`): "Jira: ABC-12" when the project
 * itself is linked, how many of its milestones are linked, and the count of open flags of both (a link into the Deviations page filtered to this
 * project). Nothing at all while nothing is linked.
 */
export function ProjectJiraChip({ projectId, marks }: { projectId: number; marks: JiraMarks }) {
  const { t } = useTranslation();
  const own = marks.byNode.get(markKey("PROJECT", projectId));
  const milestones = [...marks.byNode.keys()].filter((key) => key.startsWith("MILESTONE:")).length;
  if (own === undefined && milestones === 0) return null;
  return (
    <Group gap="xs" role="group" aria-label={t("deviations.chip.groupAria")}>
      {own !== undefined && (
        <Text size="sm">
          {t("deviations.chip.jira")} <JiraKeyLink issueKey={own.key} siteUrl={own.siteUrl} underline="always" />
        </Text>
      )}
      {milestones > 0 && <Text size="sm">{t("deviations.chip.milestones", { count: milestones })}</Text>}
      <DeviationCount to={deviationsForProjectPath(projectId)} warnings={marks.warnings} infos={marks.infos} />
    </Group>
  );
}

/** The team page's chip: how many of the team's milestones are linked and their open-flag count (a link into the page filtered to the team). */
export function TeamJiraChip({ teamId, marks }: { teamId: number; marks: JiraMarks }) {
  const { t } = useTranslation();
  if (marks.byNode.size === 0) return null;
  return (
    <Group gap="xs" role="group" aria-label={t("deviations.chip.groupAria")}>
      <Text size="sm">{t("deviations.chip.teamLinked", { count: marks.byNode.size })}</Text>
      <DeviationCount to={deviationsForTeamPath(teamId)} warnings={marks.warnings} infos={marks.infos} />
    </Group>
  );
}

/**
 * The project header's Jira action, offered with the project's own `can.edit` (the bind's and the unbind's guard is the owner chain or ADMIN, the same
 * arithmetic as `canManage`): "Link to Jira…" while the project is not linked (the view says so), "Unlink from Jira" once it is (the chip names the key).
 */
export function ProjectJiraButton({ project, marks, onLink, onUnlink }: { project: { id: number; can: { edit: boolean } }; marks: JiraMarks; onLink: () => void; onUnlink: (mark: JiraMark) => void }) {
  const { t } = useTranslation();
  if (!project.can.edit) return null;
  const own = marks.byNode.get(markKey("PROJECT", project.id));
  return own === undefined ? (
    <Button variant="default" leftSection={<IconBrandJira size={16} />} onClick={onLink}>
      {t("deviations.link.action")}
    </Button>
  ) : (
    <Button variant="default" leftSection={<IconLinkOff size={16} />} onClick={() => onUnlink(own)}>
      {t("deviations.link.unlink")}
    </Button>
  );
}
