import { Badge, Group, Text } from "@mantine/core";
import type { TFunction } from "i18next";
import { useTranslation } from "react-i18next";
import type { ProjectView as ProjectViewDocument } from "../api/milestones";
import { spanBadges } from "../utils/baselineOverlay";
import type { JiraMarks } from "../utils/jiraMarks";
import { conflictCount } from "../utils/projectDependencies";
import { ProjectJiraChip } from "./JiraChips";

/** One badge per non-zero drift figure: orange when the project runs LATER than its target (a warning), gray when it is ahead. */
function driftBadges(drift: NonNullable<ProjectViewDocument["drift"]>, t: TFunction): { key: string; label: string; late: boolean }[] {
  const figures = [
    { key: "end", days: drift.endDays, late: "project.drift.endLate", early: "project.drift.endEarly" },
    { key: "start", days: drift.startDays, late: "project.drift.startLate", early: "project.drift.startEarly" },
  ] as const;
  return figures
    .filter(({ days }) => days !== 0)
    .map(({ key, days, late, early }) => ({ key, late: days > 0, label: t(days > 0 ? late : early, { count: Math.abs(days) }) }));
}

/** The facts line under the title: the target window, the derived span and how the span drifts from the target. */
export default function ProjectFacts({ view, marks }: { view: ProjectViewDocument; marks: JiraMarks }) {
  const { t } = useTranslation();
  const { targetStart, targetEnd } = view.project;
  const badges = view.drift === null ? [] : driftBadges(view.drift, t);
  const conflicts = conflictCount(view);
  return (
    <Group gap="md" role="group" aria-label={t("project.factsAria")}>
      <Text size="sm">{targetStart !== null && targetEnd !== null ? t("project.windowLine", { start: targetStart, end: targetEnd }) : t("project.noWindow")}</Text>
      <Text size="sm">{view.span !== null ? t("project.spanLine", { start: view.span.start, end: view.span.end }) : t("project.nothingScheduled")}</Text>
      {view.drift !== null && badges.length === 0 && (
        <Badge color="gray">
          {t("project.drift.onTarget")}
        </Badge>
      )}
      {badges.map((badge) => (
        <Badge key={badge.key} color={badge.late ? "orange" : "gray"}>
          {badge.label}
        </Badge>
      ))}
      {view.baseline !== undefined &&
        spanBadges(view.baseline.project, t).map((badge) => (
          <Badge key={`baseline-${badge.key}`} color={badge.late ? "orange" : "gray"} tt="none">
            {badge.label}
          </Badge>
        ))}
      {conflicts > 0 && (
        <Badge color="red">
          {t("project.conflicts", { count: conflicts })}
        </Badge>
      )}
      {view.idleGaps.length > 0 && (
        <Badge color="gray">
          {t("timeline.idle.badge", { count: view.idleGaps.length })}
        </Badge>
      )}
      {/* In this row, not under it: the chip comes and goes with the links (a bind, an unlink), and nothing below may move when it does. */}
      <ProjectJiraChip projectId={view.project.id} marks={marks} />
    </Group>
  );
}
