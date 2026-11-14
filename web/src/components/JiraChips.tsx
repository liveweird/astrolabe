import { Link as RouterLink } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { Badge, Button, Group, Text } from "@mantine/core";
import { IconBrandJira, IconFileImport, IconLinkOff } from "@tabler/icons-react";
import { deviationsForProjectPath, deviationsForTeamPath } from "../utils/deviationLinks";
import { markKey, type JiraMark, type JiraMarks } from "../utils/jiraMarks";
import JiraKeyLink from "./JiraKeyLink";

/**
 * "Jira data may be out of date" (`deviations.chip.stale`) as dimmed plain text: the chips' qualifier and, since 1.17, the Roadmap and Programs pages' facts line.
 * Not an `Alert`, not orange, not a link: the Deviations page's banner is the warning and says why.
 */
export function JiraStaleNote() {
  const { t } = useTranslation();
  return (
    <Text size="sm" c="dimmed">
      {t("deviations.chip.stale")}
    </Text>
  );
}

/**
 * The open-flag count as a link into the Deviations page (orange when it holds a warning, gray when only infos); "No deviations seen" when there is none.
 * With `stale` (1.16: a site behind the chip is not CURRENT, or its mapping does not fit: `isStaleSource`, the Deviations banner's rule too) the count is followed by dimmed "Jira data may be out of date",
 * at any count: three deviations read from a connection that failed last night are as doubtful as none. Plain text, not an alert and not orange: the
 * Deviations page's banner is the warning, the chip only qualifies.
 */
function DeviationCount({ to, warnings, infos, stale }: { to: string; warnings: number; infos: number; stale: boolean }) {
  const { t } = useTranslation();
  const count = warnings + infos;
  return (
    <>
      <Badge color={count > 0 && warnings > 0 ? "orange" : "gray"} variant="light" tt="none" component={RouterLink} to={to}>
        {count === 0 ? t("deviations.chip.inLine") : t("deviations.chip.count", { count })}
      </Badge>
      {stale && <JiraStaleNote />}
    </>
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
      <DeviationCount to={deviationsForProjectPath(projectId)} warnings={marks.warnings} infos={marks.infos} stale={marks.stale} />
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
      <DeviationCount to={deviationsForTeamPath(teamId)} warnings={marks.warnings} infos={marks.infos} stale={marks.stale} />
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

/**
 * The project header's "Import from Jira…" (1.14): the project's milestones from what Jira lists under the project's own item. Offered with the
 * project's `can.createMilestone` (the owner chain or ADMIN: the server's guard for creating under the project) and only while the view says the
 * project is linked, since the import is rooted at that link.
 */
export function ProjectJiraImportButton({ project, marks, onImport }: { project: { id: number; can: { createMilestone: boolean } }; marks: JiraMarks; onImport: () => void }) {
  const { t } = useTranslation();
  if (!project.can.createMilestone || !marks.byNode.has(markKey("PROJECT", project.id))) return null;
  return (
    <Button variant="default" leftSection={<IconFileImport size={16} />} onClick={onImport}>
      {t("jira.import.entry")}
    </Button>
  );
}
