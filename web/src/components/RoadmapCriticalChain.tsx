import { Stack, Text, Title } from "@mantine/core";
import { useTranslation } from "react-i18next";
import type { RoadmapView } from "../api/roadmap";
import { projectPath } from "../utils/planLinks";
import { allProjects } from "../utils/roadmapRows";
import { chainProjects } from "../utils/roadmapCritical";
import UpstreamTable, { type UpstreamRow } from "./UpstreamTable";

/**
 * The roadmap's "Critical path to {name}" panel (1.7, h3, under the flag panel while a target is set): the ACCESSIBLE surface of the emphasised bars and
 * arrows. The target's facts, then one table over the server's `criticalPath.projects` in its order (hops, the project as the way into its page, program,
 * span, slack, an "On the chain" badge), or the empty state: nothing scheduled in the target, or nothing upstream of it. `shown` = the ids of the rows the
 * filters leave on the timeline: a hidden upstream project is still listed (the panel is the plan's answer, the rows are the filter's), dimmed "(not shown)".
 */
export default function RoadmapCriticalChain({ view, shown }: { view: RoadmapView; shown: ReadonlySet<number> }) {
  const { t } = useTranslation();
  const block = view.criticalPath;
  if (block === undefined) return null;
  const target = allProjects(view).find((project) => project.id === block.projectId);
  if (target === undefined) return null;
  const rows: UpstreamRow[] = chainProjects(view).map(({ project, slackDays, critical, hops }) => ({
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
    ...(shown.has(project.id) ? {} : { note: t("roadmap.critical.notShown") }),
  }));
  return (
    <Stack gap="xs">
      <Title order={3} size="h4">
        {t("roadmap.critical.title", { name: target.name })}
      </Title>
      <Text size="sm" c="dimmed">
        {t("roadmap.critical.intro", { name: target.name })}
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
