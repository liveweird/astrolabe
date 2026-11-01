import type { TFunction } from "i18next";
import type { RoadmapLink, RoadmapProject } from "../api/roadmap";
import { arrowSpecsForLinks, driftBandOf } from "./roadmapRows";
import type { TimelineArrowData, TimelineBandData, TimelineBarData } from "./timelineModel";

// The track of a PROJECT row, shared by the two plan pages (the roadmap and the programs tree): the bars, the drift band and the arrows between
// projects. ONE builder, so a gesture added to the project row later (the target window's editing) lands on both pages at once. The server's
// figures (span, drift, link checks) are only READ here.

/** The accessible name of a span bar, with the ", N conflicts" suffix when violated links end on its project. */
const withConflicts = (t: TFunction, describe: string, count: number) => (count > 0 ? `${describe}, ${t("project.barConflicts", { count })}` : describe);

/** The bars of a project row: its target window (a read-only band-look bar behind) and the span its milestones cover (hollow, on top). */
function barsOf(project: RoadmapProject, t: TFunction, conflicts: number): TimelineBarData[] {
  const { id, name, targetStart, targetEnd, span } = project;
  const bars: TimelineBarData[] = [];
  if (targetStart !== null && targetEnd !== null) {
    bars.push({ id: `window:${id}`, start: targetStart, end: targetEnd, label: name, describe: t("timeline.bar.window", { name, start: targetStart, end: targetEnd }), editable: false, tone: "window" });
  }
  if (span !== null) {
    bars.push({ id, start: span.start, end: span.end, label: name, describe: withConflicts(t, t("roadmap.barAria", { name, start: span.start, end: span.end }), conflicts), editable: false, tone: "summary" });
  }
  return bars;
}

/** The overrun band behind a late project: from the day after its target window to the end of its span. */
function bandsOf(project: RoadmapProject, t: TFunction): TimelineBandData[] {
  const band = driftBandOf(project);
  return band === null || project.drift === null ? [] : [{ id: `drift:${project.id}`, ...band, label: t("project.driftBand", { count: project.drift.endDays }), tone: "drift" }];
}

/** What a project's row draws on its track: the window and span bars, and the drift band. `conflicts` = the violated links ending on each project (`conflictsByProject`). */
export function projectTrack(project: RoadmapProject, t: TFunction, conflicts: ReadonlyMap<number, number>): { bars: TimelineBarData[]; bands: TimelineBandData[] } {
  return { bars: barsOf(project, t, conflicts.get(project.id) ?? 0), bands: bandsOf(project, t) };
}

/**
 * The arrows between the projects of a page. `names` holds the projects that have a row on the page (their names are the arrows' titles); an
 * arrow is drawn only when both of its projects are in `withSpan` (a row AND a span: the span bar is what an arrow anchors on).
 */
export function planArrows(t: TFunction, links: readonly RoadmapLink[], names: ReadonlyMap<number, string>, withSpan: ReadonlySet<number>): TimelineArrowData[] {
  const nameOf = (id: number) => names.get(id) ?? "";
  return arrowSpecsForLinks(links, (projectId) => (withSpan.has(projectId) ? projectId : null), {
    direct: (link) => `${nameOf(link.predecessorProjectId)} → ${nameOf(link.successorProjectId)}, ${link.direct?.type ?? ""}`,
    bundle: (link) =>
      t("roadmap.bundleLabel", { from: nameOf(link.predecessorProjectId), to: nameOf(link.successorProjectId), count: link.milestoneLinks.count, violated: link.milestoneLinks.violated }),
  });
}
