import type { TFunction } from "i18next";
import type { ProjectView } from "../api/milestones";
import { barList } from "../utils/baselineOverlay";
import { projectRowId } from "../utils/projectDependencies";
import type { ProjectPreview } from "../utils/planProposal";
import { proposedSpanBar } from "../utils/planTrack";
import { proposalBars, proposalRows } from "../utils/scheduleProposal";
import type { TeamColour } from "../utils/teamColours";
import type { RovingTarget, TimelineRowData } from "../utils/timelineModel";
import NameCell from "./MilestoneNameCell";
import { estimateText, withOptional } from "./ProjectTimelineRows";
import TeamNameCell from "./TeamNameCell";

/**
 * The project timeline while a schedule proposal previews (1.33): the rows `ProjectTimeline` built, made read-only (no bar is editable), each moved milestone's row given a
 * second dashed bar (the team page's idiom, the whole run's moves of THIS project whatever is ticked), the summary row given the project's proposed span
 * (`proposal:project`), and a "(new)" row appended for every tray milestone the run places (proposal bar only). The idle bands are the caller's to drop.
 */
export function previewRows(
  rows: TimelineRowData[],
  view: ProjectView,
  preview: ProjectPreview,
  t: TFunction,
  { colours, flagsColumn, criticalPath }: { colours: ReadonlyMap<number, TeamColour>; flagsColumn: boolean; criticalPath: boolean },
): TimelineRowData[] {
  const proposed = proposalBars(preview.moves, t);
  const summary = projectRowId(view.project.id);
  const dashed = preview.project === undefined ? undefined : proposedSpanBar("project", view.project.name, preview.project.after, t);
  const drawn = rows.map((row) => {
    const extra = row.id === summary ? dashed : proposed.get(Number(row.id));
    return { ...row, bars: [...row.bars.map((bar) => ({ ...bar, editable: false })), ...(extra === undefined ? [] : [extra])] };
  });
  const placed = proposalRows(view, preview.moves).map((milestone) => ({
    id: milestone.id,
    cells: withOptional(
      [
        <NameCell key="name" milestone={milestone} mark={t("teams.proposal.newMark")} />,
        (stop: RovingTarget) => <TeamNameCell name={milestone.teamName} colour={colours.get(milestone.teamId)} teamId={milestone.teamId} stop={stop} />,
        estimateText(t, milestone),
        null,
      ],
      flagsColumn ? "" : null,
      criticalPath ? "" : null,
    ),
    bars: barList(proposed.get(milestone.id)),
  }));
  return [...drawn, ...placed];
}
