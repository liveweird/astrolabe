import { useTranslation } from "react-i18next";
import { Alert, Badge, Group, Text } from "@mantine/core";
import type { JiraImportPreview, JiraImportScope } from "../api/jira";
import type { ImportRoot } from "../utils/jiraImport";

/** The "what was left out" line's key for the filter the rows were read under; null when the filter leaves nothing out. */
function leftOutKeyOf(excludeDone: boolean, days: number | null) {
  if (excludeDone) return days === null ? "jira.import.preview.leftOutDone" : "jira.import.preview.leftOutBoth";
  return days === null ? null : "jira.import.preview.leftOutQuiet";
}

/** The truncation sentence: a rooted scope has no project picker, so it names the filter (and, below a program, a project to start from). */
function truncatedKeyFor(root: ImportRoot | undefined) {
  if (root === undefined) return "jira.import.preview.truncated";
  return root.level === "PROGRAM" ? "jira.import.preview.truncatedRootProgram" : "jira.import.preview.truncatedRootProject";
}

/**
 * The preview's totals and the notes under them: what the filter left out, a truncated scope, milestones created unscheduled for lack of
 * rights, and the Jira teams that match none here. All of them are about the preview as read (`filter` is the one the rows were read under).
 */
export default function JiraImportPreviewNotes({
  totals,
  notable,
  filter,
  root,
  rights,
  unmatchedTeams,
}: {
  totals: JiraImportPreview["totals"];
  /** Orange only when a skip needs a look: rows that are simply already linked are fine. */
  notable: boolean;
  filter: JiraImportScope["filter"] | null;
  root: ImportRoot | undefined;
  rights: { count: number; of: number };
  unmatchedTeams: readonly string[];
}) {
  const { t } = useTranslation();
  const leftOutKey = filter == null ? null : leftOutKeyOf(filter.excludeDone, filter.updatedWithinDays ?? null);
  return (
    <>
      <Group gap="xs" role="group" aria-label={t("jira.import.preview.totalsAria")}>
        <Badge color="gray" variant="light" tt="none">
          {t("jira.import.preview.totalFound", { n: totals.items })}
        </Badge>
        <Badge color="gray" variant="outline" tt="none">
          {t("jira.import.preview.totalCreate", { n: totals.create })}
        </Badge>
        <Badge color="gray" variant="light" tt="none">
          {t("jira.import.preview.totalBind", { n: totals.bind })}
        </Badge>
        {totals.skip > 0 && (
          <Badge color={notable ? "orange" : "gray"} variant="light" tt="none">
            {t("jira.import.preview.totalSkip", { n: totals.skip })}
          </Badge>
        )}
      </Group>
      {filter != null && leftOutKey !== null && (
        <Text size="sm" role="note">
          {t(leftOutKey, { count: filter.updatedWithinDays ?? 0 })}
        </Text>
      )}
      {totals.truncated && (
        <Alert color="orange" variant="light" role="note">
          {t(truncatedKeyFor(root))}
        </Alert>
      )}
      {rights.count > 0 && (
        <Text size="sm" role="note">
          {t("jira.import.preview.unscheduledRights", { n: rights.count, of: rights.of })}
        </Text>
      )}
      {unmatchedTeams.length > 0 && (
        <Text size="sm" role="note">
          {t("jira.import.preview.unmatchedTeams", { names: unmatchedTeams.join(", ") })}
        </Text>
      )}
    </>
  );
}
