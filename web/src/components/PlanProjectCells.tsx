import { Anchor, Badge, Group, Menu, VisuallyHidden } from "@mantine/core";
import { IconAlertTriangle, IconCalendarEvent, IconCalendarOff, IconExternalLink, IconInfoCircle, IconRoute } from "@tabler/icons-react";
import { Link as RouterLink } from "react-router-dom";
import { useTranslation } from "react-i18next";
import type { RoadmapProject } from "../api/roadmap";
import { projectPath } from "../utils/planLinks";
import type { FlagCounts } from "../utils/roadmapRows";
import type { RovingTarget } from "../utils/timelineModel";

// The cells a PROJECT row shares across the two plan pages (the roadmap and the programs tree), with the roll-up cell of a stream / program row:
// the flag icons, the name as the link into the project and the menu's target-window and "Open project" items.

/**
 * Flags as icons with counts: an orange warning triangle and/or a gray info circle (the words are for assistive technology; colour is never the
 * only carrier). A project row passes its own flags' counts, a work stream / program row the roll-up of its projects'. Nothing when there are none.
 * `label` replaces the counts in words with the flags' own sentences (a milestone row's, on the project and team pages).
 */
export function FlagCountsCell({ counts, label }: { counts: FlagCounts; label?: string }) {
  const { t } = useTranslation();
  const { warnings, infos } = counts;
  if (warnings + infos === 0) return null;
  const sentence = label ?? [warnings > 0 ? t("roadmap.facts.warnings", { count: warnings }) : null, infos > 0 ? t("roadmap.facts.infos", { count: infos }) : null].filter(Boolean).join(", ");
  return (
    <Group gap={4} wrap="nowrap" title={sentence} data-flags={`${warnings},${infos}`}>
      {warnings > 0 && (
        <Badge aria-hidden="true" color="orange" variant="light" size="sm" px={4} leftSection={<IconAlertTriangle size={12} />}>
          {warnings}
        </Badge>
      )}
      {infos > 0 && (
        <Badge aria-hidden="true" color="gray" variant="light" size="sm" px={4} leftSection={<IconInfoCircle size={12} />}>
          {infos}
        </Badge>
      )}
      <VisuallyHidden>{sentence}</VisuallyHidden>
    </Group>
  );
}

/** A project's name as the link into its page ("Open {{name}}" is what tests and e2e locate); `stop` makes the link the row's roving tab stop. */
export function ProjectLink({ project, stop }: { project: Pick<RoadmapProject, "id" | "name">; stop: RovingTarget }) {
  const { t } = useTranslation();
  return (
    <Anchor component={RouterLink} to={projectPath(project.id)} inherit fw={500} aria-label={t("roadmap.openProjectAria", { name: project.name })} {...stop}>
      {project.name}
    </Anchor>
  );
}

/** What a project row's menu asks of the page for the target window: open the dialog, or clear the window outright (the keyboard path of the band's drag). */
export type WindowActions = {
  edit: (project: RoadmapProject) => void;
  clear: (project: RoadmapProject) => void;
};

/**
 * "Edit target window…" and (only while the project has a window) "Clear target window", then a divider - only for a viewer who may change THIS
 * project's window (the view's own `can.editTargetWindow`, never the session's roles); nothing otherwise. The deterministic, keyboard and screen-reader
 * path of the band's move/resize and the row's draw, on both plan pages.
 */
export function TargetWindowItems({ project, actions }: { project: RoadmapProject; actions: WindowActions }) {
  const { t } = useTranslation();
  if (!project.can.editTargetWindow) return null;
  const { name } = project;
  return (
    <>
      <Menu.Item leftSection={<IconCalendarEvent size={14} />} onClick={() => actions.edit(project)} aria-label={t("roadmap.action.editWindowAria", { name })}>
        {t("roadmap.action.editWindow")}
      </Menu.Item>
      {project.targetStart !== null && (
        <Menu.Item leftSection={<IconCalendarOff size={14} />} onClick={() => actions.clear(project)} aria-label={t("roadmap.action.clearWindowAria", { name })}>
          {t("roadmap.action.clearWindow")}
        </Menu.Item>
      )}
      <Menu.Divider />
    </>
  );
}

/** The menu item that opens the project's page - the one item every viewer has. */
export function OpenProjectItem({ project }: { project: Pick<RoadmapProject, "id" | "name"> }) {
  const { t } = useTranslation();
  return (
    <Menu.Item component={RouterLink} to={projectPath(project.id)} leftSection={<IconExternalLink size={14} />} aria-label={t("roadmap.action.openProjectAria", { name: project.name })}>
      {t("roadmap.action.openProject")}
    </Menu.Item>
  );
}

/**
 * The row menu's critical-path item (1.7 roadmap, 1.16 programs): "Show critical path to this project" or, for the project that is the page's target
 * (`target`), "Hide critical path". `onToggle` is the page's (it sets or clears the page-local target); `disabled` is "a write is in flight".
 */
export function CriticalPathItem({ project, target, disabled, onToggle }: { project: Pick<RoadmapProject, "id" | "name">; target: number | null; disabled: boolean; onToggle: () => void }) {
  const { t } = useTranslation();
  const hide = target === project.id;
  return (
    <Menu.Item leftSection={<IconRoute size={14} />} disabled={disabled} onClick={onToggle} aria-label={t(hide ? "roadmap.action.hideCriticalAria" : "roadmap.action.showCriticalAria", { name: project.name })}>
      {t(hide ? "roadmap.action.hideCritical" : "roadmap.action.showCritical")}
    </Menu.Item>
  );
}
