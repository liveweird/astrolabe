import type { TFunction } from "i18next";
import type { RoadmapLink, RoadmapProject } from "../api/roadmap";
import { shadowBar } from "./baselineOverlay";
import { jiraBar, type JiraWindow } from "./jiraBars";
import { arrowSpecsForLinks, driftBandOf, type RolledUpLinks } from "./roadmapRows";
import type { BarId, TimelineArrowData, TimelineBandData, TimelineBarData, TimelineDrawData } from "./timelineModel";

// The track of a PROJECT row, shared by the two plan pages (the roadmap and the programs tree): the bars, the drift band, the draw surface and the
// arrows between projects. ONE builder, so the target window's gestures (move, resize, draw) are on both pages at once. The server's figures
// (span, drift, link checks) are only READ here; what the viewer may change is the project's own `can.editTargetWindow`, never the session's roles.

/** The id of a project's window bar (and of the draw that makes one): the page's `onSchedule` recognises it and writes the target window. */
export const windowBarId = (projectId: number) => `window:${projectId}`;

/** The project id of a window bar's id, or `null` for any other bar. */
export function projectOfWindowBar(barId: number | string): number | null {
  const match = /^window:(\d+)$/.exec(String(barId));
  return match === null ? null : Number(match[1]);
}

/** The accessible name of a span bar, with the ", N conflicts" suffix when violated links end on its project. */
export const withConflicts = (t: TFunction, describe: string, count: number) => (count > 0 ? `${describe}, ${t("project.barConflicts", { count })}` : describe);

/**
 * The bars of a project row: its target window (the band-look bar behind - editable when the viewer may change it) and the span its milestones
 * cover (hollow, read-only, on top: the Timeline lets the pointer through a summary bar, so the window under it is grabbed where they overlap), then,
 * while a baseline is picked, the shadow bar of the span the baseline froze and, while the "Jira dates" toggle is on (`jira`, the page's window), the shadow bar of
 * the dates Jira holds (1.3; only for a project whose link carries both, cut at the window).
 */
function barsOf(project: RoadmapProject, t: TFunction, conflicts: number, jira: JiraWindow | null, critical: boolean): TimelineBarData[] {
  const { id, name, targetStart, targetEnd, span } = project;
  const bars: TimelineBarData[] = [];
  if (targetStart !== null && targetEnd !== null) {
    bars.push({
      id: windowBarId(id),
      start: targetStart,
      end: targetEnd,
      label: name,
      describe: t("timeline.bar.window", { name, start: targetStart, end: targetEnd }),
      editable: project.can.editTargetWindow,
      tone: "window",
    });
  }
  if (span !== null) {
    const describe = withConflicts(t, t("roadmap.barAria", { name, start: span.start, end: span.end }), conflicts);
    // 1.7: the target of the picked critical path and every project on its chain: the span bar is outlined (and says so), like a critical milestone's.
    bars.push(
      critical
        ? { id, start: span.start, end: span.end, label: name, describe: `${describe}, ${t("timeline.bar.critical")}`, editable: false, tone: "summary", emphasis: "critical" }
        : { id, start: span.start, end: span.end, label: name, describe, editable: false, tone: "summary" },
    );
  }
  // v0.9: with `?baseline=` a project the baseline also froze carries the span it had then - a thin shadow bar under the span bar, named with its dates and movement.
  const frozen = project.baseline;
  if (frozen?.span) bars.push(shadowBar(id, name, frozen.span, frozen.movement, t));
  const shadow = jira === null ? undefined : jiraBar(id, name, project.jira, project.flags, jira, t);
  if (shadow !== undefined) bars.push(shadow);
  return bars;
}

/** The overrun band behind a late project: from the day after its target window to the end of its span. */
function bandsOf(project: RoadmapProject, t: TFunction): TimelineBandData[] {
  const band = driftBandOf(project);
  return band === null || project.drift === null ? [] : [{ id: `drift:${project.id}`, ...band, label: t("project.driftBand", { count: project.drift.endDays }), tone: "drift" }];
}

/**
 * What a project's row draws on its track: the window and span bars, the drift band and, for a viewer who may set the window of a project that has
 * none, the draw surface (a drag across the empty row proposes `onSchedule(window:<id>, start, end)`, the same seam as moving the band).
 * `conflicts` = the violated links ending on each project (`conflictsByProject`); `jira` = the page's Jira window while the "Jira dates" toggle is on (`jiraWindow`), else `null`;
 * `critical` (1.7, the roadmap's picked critical path) = the project is the target or on its chain: its span bar gets the critical emphasis.
 */
export function projectTrack(
  project: RoadmapProject,
  t: TFunction,
  conflicts: ReadonlyMap<number, number>,
  jira: JiraWindow | null,
  critical = false,
): { bars: TimelineBarData[]; bands: TimelineBandData[]; draw?: TimelineDrawData } {
  const track = { bars: barsOf(project, t, conflicts.get(project.id) ?? 0, jira, critical), bands: bandsOf(project, t) };
  const drawable = project.can.editTargetWindow && (project.targetStart === null || project.targetEnd === null);
  return drawable ? { ...track, draw: { barId: windowBarId(project.id), label: project.name } } : track;
}

/**
 * The arrows between the projects of a page. `anchorOf` answers the bar that stands for a project on this timeline (the project's own span bar, which
 * has its id; on the programs tree, 1.16, the folded program's or work stream's summary bar when the project's row is folded away), else `null`
 * and the arrow is left out. `names` holds the names of the rows those bars sit on, by bar id (the arrows' titles). The roadmap answers only
 * its own projects with a span, so it never rolls up. `criticalPairs` (1.7, the roadmap's picked critical path) marks the arrows of those ordered
 * project pairs (`pairKey`s) `critical`.
 */
export function planArrows(
  t: TFunction,
  links: readonly RoadmapLink[],
  names: ReadonlyMap<BarId, string>,
  anchorOf: (projectId: number) => BarId | null,
  criticalPairs?: ReadonlySet<string>,
): TimelineArrowData[] {
  const nameOf = (id: BarId) => names.get(id) ?? "";
  const labels = {
    direct: (link: RoadmapLink) => `${nameOf(link.predecessorProjectId)} → ${nameOf(link.successorProjectId)}, ${link.direct?.type ?? ""}`,
    bundle: (link: RoadmapLink) =>
      t("roadmap.bundleLabel", { from: nameOf(link.predecessorProjectId), to: nameOf(link.successorProjectId), count: link.milestoneLinks.count, violated: link.milestoneLinks.violated }),
    rollup: (rolled: RolledUpLinks) => t("roadmap.rollupLabel", { from: nameOf(rolled.from), to: nameOf(rolled.to), count: rolled.count, violated: rolled.violated }),
  };
  return arrowSpecsForLinks(links, anchorOf, labels, criticalPairs);
}
