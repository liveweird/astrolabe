import type { CrossTeamProposal } from "../api/scheduleProposals";
import type { TeamView } from "../api/teams";
import { ghostRowId } from "./dependencyArrows";

/**
 * Pure derivations of a cross-team run started on the team page (1.38): which OTHER teams' milestones and which whole projects the run moves and the team's own links name,
 * so the team's timeline can show them as dimmed rows (the current dates as a ghost bar, the proposed dates as the dashed bar). The SERVER decided every date; nothing here
 * recomputes a schedule. A row's id is the ghost id the critical chain's rows and the project page's use (`ghostRowId`), so a link's arrow reaches it and a chain row the
 * run moves finds its dashed bar here instead of getting a second row.
 */

type Span = { start: string; end: string };
type Dependencies = TeamView["dependencies"];

/** One other team's milestone, or one project, that the run moves. */
export type RunPreviewEntry = {
  /** `ghost:m:<id>` / `ghost:p:<id>`: the row and its ghost bar. */
  rowId: string;
  kind: "MILESTONE" | "PROJECT";
  id: number;
  name: string;
  projectId: number;
  projectName: string;
  /** The milestone's team (null for a project). */
  teamId: number | null;
  teamName: string | null;
  /** The dates now; null = none yet (a milestone the run schedules, a project with no scheduled milestone). */
  current: Span | null;
  /** The dates the run proposes (a project: the ticked moves' span while some are ticked). */
  proposed: Span;
  /** Whether the dashed bar is drawn: a ticked move or one the viewer cannot tick; a project the ticked moves still move. The row stays either way. */
  drawn: boolean;
  /** The day the row sorts on: the run's own proposed start, so a tick never reorders the rows. */
  sortStart: string;
};

/** What the team's timeline adds while a run is open. */
export type TeamRunPreview = {
  /** The entries a link of the team's own milestones names, in row order, that no critical-chain row already is: the rows this preview adds. */
  rows: RunPreviewEntry[];
  /** Every other-team move and every project of the run by row id: a critical-chain row the run moves takes its dashed bar from here. */
  byRow: ReadonlyMap<string, RunPreviewEntry>;
  /** Every day the added rows show, and the dashed bars of the chain's rows, for the page's grow-only range. */
  days: string[];
};

const compare = (a: string, b: string) => (a === b ? 0 : a < b ? -1 : 1);

/** The teams at the other ends of the links that touch the team's milestones: the ids "Add linked teams" adds, ascending. */
export function linkedTeamIds(dependencies: Dependencies, teamId: number): number[] {
  const ids = new Set<number>();
  for (const dependency of dependencies) {
    for (const end of [dependency.predecessor, dependency.successor]) {
      if (end.kind === "MILESTONE" && end.teamId !== null && end.teamId !== teamId) ids.add(end.teamId);
    }
  }
  return [...ids].sort((a, b) => a - b);
}

/**
 * The entries of a run besides the team's own moves. `projects` is what follows the ticks (`overlayProjects`): a project that drops out of it keeps its row (with the ghost bar)
 * and loses its dashed bar, as an unticked milestone does; the row set itself comes from the RUN, so nothing jumps under the pointer. A milestone's dashed bar follows `drawnMoves`' rule.
 * `chainRows` are the row ids the critical chain already draws (the toggle on): they get no second row, only their dashed bar (`byRow`).
 */
export function teamRunPreview({
  teamId,
  dependencies,
  run,
  projects,
  selected,
  tickable,
  chainRows,
}: {
  teamId: number;
  dependencies: Dependencies;
  run: Pick<CrossTeamProposal, "teams" | "projects">;
  projects: CrossTeamProposal["projects"];
  selected: ReadonlySet<number>;
  tickable: ReadonlySet<number>;
  chainRows: ReadonlySet<string>;
}): TeamRunPreview {
  const byRow = new Map<string, RunPreviewEntry>();
  for (const block of run.teams) {
    if (block.teamId === teamId) continue;
    for (const move of block.moves) {
      const rowId = ghostRowId({ kind: "MILESTONE", id: move.milestoneId });
      byRow.set(rowId, {
        rowId,
        kind: "MILESTONE",
        id: move.milestoneId,
        name: move.name,
        projectId: move.projectId,
        projectName: move.projectName,
        teamId: block.teamId,
        teamName: block.name,
        current: move.from,
        proposed: move.to,
        drawn: selected.has(move.milestoneId) || !tickable.has(move.milestoneId),
        sortStart: move.to.start,
      });
    }
  }
  for (const project of run.projects) {
    const rowId = ghostRowId({ kind: "PROJECT", id: project.projectId });
    const followed = projects.find((entry) => entry.projectId === project.projectId);
    byRow.set(rowId, {
      rowId,
      kind: "PROJECT",
      id: project.projectId,
      name: project.name,
      projectId: project.projectId,
      projectName: project.name,
      teamId: null,
      teamName: null,
      current: project.before,
      proposed: (followed ?? project).after,
      drawn: followed !== undefined,
      sortStart: project.after.start,
    });
  }
  const linked = new Set<string>();
  for (const dependency of dependencies) {
    for (const end of [dependency.predecessor, dependency.successor]) {
      if (end.kind === "PROJECT" || end.teamId !== teamId) linked.add(ghostRowId(end));
    }
  }
  const rows = [...byRow.values()]
    .filter((entry) => linked.has(entry.rowId) && !chainRows.has(entry.rowId))
    .sort((a, b) => compare(a.sortStart, b.sortStart) || compare(a.name.toLowerCase(), b.name.toLowerCase()) || compare(a.kind, b.kind) || a.id - b.id);
  const shown = [...rows, ...[...byRow.values()].filter((entry) => chainRows.has(entry.rowId))];
  const days = shown.flatMap((entry) => [entry.proposed.start, entry.proposed.end, ...(entry.current === null ? [] : [entry.current.start, entry.current.end])]);
  return { rows, byRow, days };
}
