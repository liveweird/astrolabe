import type { CrossTeamProposal, CrossTeamProposalTeam } from "../api/scheduleProposals";
import type { ScheduleProposalMove, WeekLoad } from "../api/teams";

/**
 * Pure derivations of a cross-team run on the pages that host it beside the plan (1.33): which of its moves the viewer may tick, which teams an
 * accept names, and the slice of the run that belongs to one project. The SERVER decided every date and verdict; nothing here recomputes them.
 */

type RunTeams = Pick<CrossTeamProposal, "teams">;

/**
 * The milestone ids the viewer may tick: the moves of the blocks whose team is in `acceptable` (`GET /schedule-proposals/teams`), and with a
 * `projectId` only that project's. `acceptable` absent = every team's (the pages that only ever offered a run to its managers).
 */
export function tickableMoveIds(run: RunTeams | null, acceptable?: ReadonlySet<number>, projectId?: number): Set<number> {
  const ids = new Set<number>();
  for (const block of run?.teams ?? []) {
    if (acceptable !== undefined && !acceptable.has(block.teamId)) continue;
    for (const move of block.moves) if (projectId === undefined || move.projectId === projectId) ids.add(move.milestoneId);
  }
  return ids;
}

/** The teams the accept names (`acceptTeamIds`): those with at least one ticked move, ascending, each once. */
export function acceptTeamIdsOf(run: RunTeams, selected: ReadonlySet<number>): number[] {
  return run.teams
    .filter((block) => block.moves.some((move) => selected.has(move.milestoneId)))
    .map((block) => block.teamId)
    .sort((a, b) => a - b);
}

/** One team's block of a run's slice, with the block's place in the FULL run's placement order (1-based). */
export type RunSection = { team: CrossTeamProposalTeam; position: number };

/**
 * The sections a page shows for a run: every team's block in placement order, or, with a `projectId`, only the teams that have a move or an
 * unplaced milestone of that project, each reduced to those. The block's `unchanged` and `pinned` hold milestone ids of every project: with
 * `milestoneIds` (the project's own, from the host's project view) they are filtered to it, else dropped. The block's weeks and link verdicts stay the
 * team's. `position` is the place in the full run.
 */
export function projectSlice(run: RunTeams, projectId?: number, milestoneIds?: ReadonlySet<number>): RunSection[] {
  const sections = run.teams.map((team, index) => ({ team, position: index + 1 }));
  if (projectId === undefined) return sections;
  return sections.flatMap(({ team, position }) => {
    const moves = team.moves.filter((move) => move.projectId === projectId);
    const unplaced = team.unplaced.filter((entry) => entry.projectId === projectId);
    const own = (ids: number[]) => ids.filter((id) => milestoneIds?.has(id) === true);
    return moves.length + unplaced.length === 0 ? [] : [{ team: { ...team, moves, unplaced, unchanged: own(team.unchanged), pinned: own(team.pinned) }, position }];
  });
}

/** The weeks that carry a warning (overloaded or over the WIP limit): the figure of a section's orange badge. */
export const warningWeekCount = (weeks: readonly Pick<WeekLoad, "overloaded" | "wipExceeded">[] | undefined): number =>
  (weeks ?? []).filter((week) => week.overloaded || week.wipExceeded).length;

/** The part of a run the project page's timeline draws (1.33): the moves of THIS project's milestones and the project's own entry of `projects[]` (absent = its span would not change). */
export type ProjectPreview = { moves: readonly ScheduleProposalMove[]; project: CrossTeamProposal["projects"][number] | undefined };

/** Every first and last proposed day of a project preview (its moves' spans and the project's span after): the page's range grows over them. */
export const previewDays = (preview: ProjectPreview | undefined): string[] =>
  preview === undefined ? [] : [...preview.moves.flatMap((move) => [move.to.start, move.to.end]), ...(preview.project === undefined ? [] : [preview.project.after.start, preview.project.after.end])];
