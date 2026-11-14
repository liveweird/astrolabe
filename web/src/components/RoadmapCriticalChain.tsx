import { Stack, Text, Title } from "@mantine/core";
import type { ParseKeys } from "i18next";
import { useTranslation } from "react-i18next";
import type { RoadmapCriticalPath, RoadmapProject } from "../api/roadmap";
import { projectPath } from "../utils/planLinks";
import { chainProjects } from "../utils/roadmapCritical";
import UpstreamTable, { type UpstreamRow } from "./UpstreamTable";

/**
 * The "Critical path to {name}" panel of the roadmap (1.7) and the programs page (1.16) (h3, under the page's other panels while a target is set): the
 * ACCESSIBLE surface of the emphasised bars and arrows. The target's facts, then one table over the server's `criticalPath.projects` in its order (hops,
 * the project as the way into its page, program, span, slack, an "On the chain" badge), or the empty state: nothing scheduled in the target, or nothing
 * upstream of it. `projects` = every project of the page's view (`allProjects(view)` / `treeProjects(view)`). `shown` = the ids of the rows left on the
 * timeline (by the roadmap's filters, by the programs page's folds and program pick): a project that is not shown is still listed (the panel is the plan's
 * answer, the rows are the page's), dimmed with the page's `notShown` mark. `intro` and `notShown` are the page's own typed keys: "hidden by the
 * filters" does not fit a tree, "folded or not picked" does not fit a flat list.
 */
export default function RoadmapCriticalChain({
  projects,
  criticalPath: block,
  shown,
  intro,
  notShown,
}: {
  projects: readonly RoadmapProject[];
  criticalPath: RoadmapCriticalPath | undefined;
  shown: ReadonlySet<number>;
  intro: ParseKeys;
  notShown: ParseKeys;
}) {
  const { t } = useTranslation();
  if (block === undefined) return null;
  const target = projects.find((project) => project.id === block.projectId);
  if (target === undefined) return null;
  const rows: UpstreamRow[] = chainProjects(projects, block).map(({ project, slackDays, critical, hops }) => ({
    key: String(project.id),
    hops,
    name: project.name,
    to: projectPath(project.id),
    ariaLabel: t("roadmap.openProjectAria", { name: project.name }),
    context: project.programName,
    startDate: project.span?.start ?? null,
    endDate: project.span?.end ?? null,
    slackDays,
    critical,
    ...(shown.has(project.id) ? {} : { note: t(notShown) }),
  }));
  return (
    <Stack gap="xs">
      <Title order={3} size="h4">
        {t("roadmap.critical.title", { name: target.name })}
      </Title>
      <Text size="sm" c="dimmed">
        {t(intro, { name: target.name })}
      </Text>
      {target.span === null ? (
        <Text c="dimmed">{t("roadmap.critical.nothingScheduled", { name: target.name })}</Text>
      ) : (
        <Text size="sm">{t("roadmap.critical.target", { name: target.name, start: target.span.start, end: target.span.end })}</Text>
      )}
      {target.span !== null && rows.length === 0 && <Text c="dimmed">{t("roadmap.critical.noUpstream", { name: target.name })}</Text>}
      {rows.length > 0 && (
        <>
          <Text size="sm">{t("roadmap.critical.count", { total: rows.length, critical: rows.filter((row) => row.critical).length })}</Text>
          <UpstreamTable rows={rows} label={t("roadmap.critical.tableAria", { name: target.name })} contextHeader={t("roadmap.critical.column.program")} chainBadge />
        </>
      )}
    </Stack>
  );
}
