import type { TFunction } from "i18next";
import type { RoadmapLink, RoadmapProject } from "../api/roadmap";
import { arrowSpecsForLinks, driftBandOf } from "./roadmapRows";
import type { TimelineArrowData, TimelineBandData, TimelineBarData, TimelineDrawData } from "./timelineModel";

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
const withConflicts = (t: TFunction, describe: string, count: number) => (count > 0 ? `${describe}, ${t("project.barConflicts", { count })}` : describe);

/**
 * The bars of a project row: its target window (the band-look bar behind - editable when the viewer may change it) and the span its milestones
 * cover (hollow, read-only, on top: the Timeline lets the pointer through a summary bar, so the window under it is grabbed where they overlap).
 */
function barsOf(project: RoadmapProject, t: TFunction, conflicts: number): TimelineBarData[] {
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
    bars.push({ id, start: span.start, end: span.end, label: name, describe: withConflicts(t, t("roadmap.barAria", { name, start: span.start, end: span.end }), conflicts), editable: false, tone: "summary" });
  }
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
 * `conflicts` = the violated links ending on each project (`conflictsByProject`).
 */
export function projectTrack(
  project: RoadmapProject,
  t: TFunction,
  conflicts: ReadonlyMap<number, number>,
): { bars: TimelineBarData[]; bands: TimelineBandData[]; draw?: TimelineDrawData } {
  const track = { bars: barsOf(project, t, conflicts.get(project.id) ?? 0), bands: bandsOf(project, t) };
  const drawable = project.can.editTargetWindow && (project.targetStart === null || project.targetEnd === null);
  return drawable ? { ...track, draw: { barId: windowBarId(project.id), label: project.name } } : track;
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
