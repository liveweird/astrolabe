import { Badge, Stack, Text } from "@mantine/core";
import { useTranslation } from "react-i18next";
import type { DependencyListEnd, DependencyListRow } from "../utils/dependencyListRows";
import EntityLink from "./EntityLink";

/** The link's status: a red badge naming the shortfall, or a gray one - never colour alone. Shared by the project page's table and the dependency panel. */
export function DependencyStatusBadge({ check }: { check: DependencyListRow["check"] }) {
  const { t } = useTranslation();
  if (check.status === "VIOLATED") {
    return (
      // miw max-content: a badge shrinks (and clips its sentence with an ellipsis) when the table is tight; the column grows instead. tt none: the badge holds a sentence, not a label.
      <Badge color="red" tt="none" miw="max-content">
        {t("project.dependency.status.violated", { count: check.shortfallDays ?? 0 })}
      </Badge>
    );
  }
  return (
    <Badge color="gray" tt="none" miw="max-content">
      {t(check.status === "OK" ? "project.dependency.status.ok" : "project.dependency.status.unscheduled")}
    </Badge>
  );
}

/** The lag in working days; a negative one is a lead. */
export function DependencyLagText({ lagDays }: { lagDays: number }) {
  const { t } = useTranslation();
  return <>{lagDays < 0 ? `${t("project.dependency.lag", { count: lagDays })} ${t("project.dependency.lead")}` : t("project.dependency.lag", { count: lagDays })}</>;
}

/**
 * One end of a link in a table cell: its name (a whole project is worded "Project X" and is text, its project's link follows), under it its project and, for a
 * milestone, its team. The names are links (1.31): the milestone to its project page with the row marked, the project, the team.
 */
export function DependencyEndCell({ end }: { end: DependencyListEnd }) {
  const { t } = useTranslation();
  return (
    <Stack gap={2}>
      {end.kind === "PROJECT" ? (
        <Text size="sm">{t("project.dependency.wholeProject", { name: end.name })}</Text>
      ) : (
        <EntityLink entity={{ kind: "milestone", id: end.id, projectId: end.projectId }} name={end.name} size="sm" />
      )}
      <EntityLink entity={{ kind: "project", id: end.projectId }} name={end.projectName} size="xs" />
      {end.teamId !== null && end.teamName !== null && <EntityLink entity={{ kind: "team", id: end.teamId }} name={end.teamName} size="xs" />}
    </Stack>
  );
}
