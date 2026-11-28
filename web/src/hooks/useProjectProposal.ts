import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import type { ProjectView } from "../api/milestones";
import type { MilestoneActions } from "../components/MilestoneMenu";
import { previewDays, type ProjectPreview } from "../utils/planProposal";
import { drawnMoves } from "../utils/scheduleProposal";
import { movesOf, useCrossTeamProposal } from "./useCrossTeamProposal";
import { useProposalFocus } from "./useProposalFocus";
import { useProposalLock } from "./useProposalLock";
import { useProposalRights } from "./useProposalRights";
import { MAX_RUN_TEAMS, useRunTeams } from "./useRunTeams";
import { useScheduleCheck } from "./useScheduleCheck";
import { useTickedProjects } from "./useTickedProjects";

/**
 * The project page's schedule proposal (1.33): ONE cross-team run over the teams that work on the project's milestones (the distinct teams of its scheduled and unscheduled
 * milestones; every other team stays fixed, no dependency closure), previewed for every login on the page's own timeline. The run is the Roadmap overview's
 * (`useCrossTeamProposal`); the project page's side of it:
 * - the slice: only THIS project's moves are offered (ticked by default, `projectId`), so the accept names exactly those and the check describes exactly those; `others` counts the
 *   run's moves of the same teams in other projects (shown, never offered here);
 * - the rights (`useProposalRights`): a viewer who may accept none of the teams previews (no ticks, no check);
 * - the lock (`useProposalLock`): from the request until Discard the DATE writes are refused out loud (`lockActions`, `guarded`); every other edit stays allowed, and one that moves
 *   dates through a dependency makes the accept stale (the server says so);
 * - `propose` is only ever a click's (the run and the accept share a per-user rate limit), and answers `false` while a schedule write runs.
 * The team set starts as the project's teams and the viewer may choose any other (`useRunTeams`, 1.38; `picker` is the props of `RunTeamsPicker`; `disabled` while a run is requested or open: the section does not draw it then).
 * `view` is the page's view (absent while it loads: nothing is offered then).
 */
export function useProjectProposal(projectId: number, { view, announce, pending }: { view: ProjectView | undefined; announce: (text: string) => void; pending: boolean }) {
  const { t } = useTranslation();
  const rights = useProposalRights();
  const flow = useCrossTeamProposal(announce, { acceptable: rights.acceptable, projectId });
  const lock = useProposalLock(flow, announce);
  const run = flow.proposal;
  const busy = flow.requesting || flow.applying;
  const focus = useProposalFocus(run, busy);
  const check = useScheduleCheck({
    teamIds: run?.teams.map((team) => team.teamId) ?? [],
    revision: run?.revision ?? 0,
    scopeHash: run?.scopeHash ?? "",
    moves: movesOf(run),
    selected: flow.selected,
    // A viewer who may accept none of this project's moves has no ticks to ask about.
    enabled: run !== null && flow.canAccept,
  });
  const milestones = useMemo(() => [...(view?.scheduled ?? []), ...(view?.unscheduled ?? [])], [view]);
  const projectTeamIds = useMemo(() => [...new Set(milestones.map((milestone) => milestone.teamId))].sort((a, b) => a - b), [milestones]);
  const runTeams = useRunTeams(projectTeamIds);
  const teamIds = runTeams.ids;
  const tooMany = teamIds.length > MAX_RUN_TEAMS;
  const milestoneIds = useMemo(() => new Set(milestones.map((milestone) => milestone.id)), [milestones]);
  // The bars follow the ticks (1.38): a dashed bar for a ticked move and for one the viewer cannot tick, the summary span the server's own answer for the ticked moves (the last
  // answer stays while a newer one is on its way). The check answers for the ticked moves alone, so the span follows the ticks only for a viewer who may tick EVERY move of this project.
  const { selected, tickable, canAccept } = flow;
  const projectMoves = useMemo(() => (run === null ? [] : movesOf(run).filter((move) => move.projectId === projectId)), [run, projectId]);
  const ticksAll = canAccept && projectMoves.every((move) => tickable.has(move.milestoneId));
  const followed = useTickedProjects(run, check, ticksAll);
  // Every move of this project ticked IS the run's own entry (other projects' moves never touch this span), so the check's mode - counted over every move of the run - is not asked.
  const everyTicked = ticksAll && projectMoves.every((move) => selected.has(move.milestoneId));
  const entry = (everyTicked ? run?.projects : followed.projects)?.find((project) => project.projectId === projectId);
  const preview = useMemo<ProjectPreview | undefined>(
    () => (run === null ? undefined : { moves: projectMoves, project: entry, drawn: drawnMoves(projectMoves, selected, tickable) }),
    [run, projectMoves, entry, selected, tickable],
  );
  // The run's moves in other projects: how many, and the teams that carry them (the section names them, offers none).
  const others = useMemo(() => {
    const rest = (run?.teams ?? []).map((team) => ({ teamId: team.teamId, name: team.name, count: team.moves.filter((move) => move.projectId !== projectId).length })).filter((team) => team.count > 0);
    return { count: rest.reduce((sum, team) => sum + team.count, 0), teams: rest };
  }, [run, projectId]);
  const proposable = rights.ready && teamIds.length > 0 && !tooMany && run === null && !busy && !pending;
  return {
    projectId,
    flow,
    rights,
    lock,
    run,
    check,
    focus,
    teamIds,
    /** The viewer chose a team set other than the project's. */
    chosenTeams: runTeams.chosen,
    /** The props of the team picker (`RunTeamsPicker`): the set, its change, the project's own teams, and `disabled` while a run is requested or open (the section draws no picker then). */
    picker: { value: teamIds, onChange: runTeams.set, defaultIds: projectTeamIds, disabled: run !== null || busy },
    /** The team set involves more teams than a run takes. */
    tooMany,
    milestoneIds,
    others,
    /** What the timeline draws of the run (`undefined` while no run is open). */
    preview,
    /** The summary span and the end sentence describe the TICKED moves (the server's check), not every move of the run. */
    ticked: followed.ticked && !everyTicked,
    /** The dates the page's range must cover: every move and the run's own span of the project, whatever is ticked (the range never moves under a tick). */
    days: previewDays(preview === undefined ? undefined : { moves: preview.moves, project: run?.projects.find((project) => project.projectId === projectId) }),
    /** Propose may be clicked now. */
    proposable,
    /** A run is requested or open: the page's date writes are locked. */
    locked: lock.locked,
    /** A refused change's visible note (the page's status region says it too), or `null`. */
    refusal: lock.refused ? (lock.open !== null ? t("teams.proposal.readOnly") : t("project.busy")) : null,
    /** The page's row actions with every DATE write behind the lock (a refused one says so out loud); name, estimate, team, dependency and delete stay as they are. */
    lockActions: (actions: MilestoneActions): MilestoneActions => ({
      ...actions,
      editSchedule: lock.guarded(actions.editSchedule),
      unschedule: lock.guarded(actions.unschedule),
      pin: lock.guarded(actions.pin),
      schedule: lock.guarded(actions.schedule),
      scheduleOnJira: lock.guarded(actions.scheduleOnJira),
    }),
    /** A drop's write path behind the lock: refused out loud (`false`) while a run is requested or open, else `commit` runs. */
    guardDrop:
      <A extends unknown[]>(commit: (...args: A) => boolean) =>
      (...args: A): boolean =>
        lock.locked ? lock.refuse() : commit(...args),
    /** Ask for the run over the project's teams (a click's, never automatic). */
    propose: (): boolean => proposable && flow.propose(teamIds),
  };
}

/** What the page and the section share of the project's proposal. */
export type ProjectProposal = ReturnType<typeof useProjectProposal>;
