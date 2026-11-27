import { useMemo } from "react";
import { useIsMutating } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import type { ProgramsView } from "../api/programs";
import { overviewTeamIds, shownProjects, type ProposedSpans } from "../utils/programsTree";
import { storedCheckState } from "../utils/savedProposal";
import { movesOf, useCrossTeamProposal } from "./useCrossTeamProposal";
import { useProposalFocus } from "./useProposalFocus";
import { useProposalLock } from "./useProposalLock";
import { useProposalRights } from "./useProposalRights";
import { ROADMAP_WRITE_KEY } from "./useRoadmapRanking";
import { useSavedRun } from "./useSavedRun";
import { useScheduleCheck } from "./useScheduleCheck";

/** The most teams one run takes (the server's `teamIds` ceiling): above it Propose is off and the page says to narrow the pick. */
export const MAX_RUN_TEAMS = 50;

/**
 * The Roadmap overview's schedule proposal (1.33): ONE cross-team run over the teams that work on the projects the page SHOWS (`overviewTeamIds`: the program pick
 * and the work stream narrowing; nothing narrowed = every team with a milestone), previewed for every login on the tree's own timeline. The run is the project page's
 * and the old page's (`useCrossTeamProposal`); what this hook adds is the page's side of it:
 * - the rights (`useProposalRights`): only the teams the viewer may accept have ticks and an accept; a viewer with none previews (the check is never asked);
 * - the lock (`useProposalLock`): from the request until Discard the target windows are read-only (`guard` wraps the window write path, which then refuses out loud);
 * - the bars: `proposed` is the span the run gives each project it moves (`projects[]`, after the run's moves), `days` the dates the page's range must cover;
 * - Propose waits while a `?proposal=` record is still being read, and never fires by itself (the run and the accept share a per-user rate limit), so `propose` is only ever a click's: also while a window write runs it answers `false`.
 * `view` is the whole plan, `narrowed` what `inWorkStream` leaves of it, `pick` the program pick as the tree takes it; `unsettled` = the address names a work stream the view does not
 * narrow to yet (Propose waits: the team set would be the whole plan's).
 * A saved proposal named by the address (`?proposal=<id>`, `useSavedRun`) opens in this same run: the bars, the table and the sections are the same.
 * Dependencies stay UNLOCKED while a run is open on purpose: an edit bumps the plan revision, so the accept is refused as stale and the page says so.
 */
export function useOverviewProposal({
  view,
  narrowed,
  pick,
  unsettled,
  announce,
}: {
  view: ProgramsView;
  narrowed: ProgramsView;
  pick: ReadonlySet<number> | null;
  unsettled: boolean;
  announce: (text: string) => void;
}) {
  const { t } = useTranslation();
  const rights = useProposalRights();
  const flow = useCrossTeamProposal(announce, { acceptable: rights.acceptable });
  const lock = useProposalLock(flow, announce);
  const run = flow.proposal;
  const writing = useIsMutating({ mutationKey: ROADMAP_WRITE_KEY }) > 0;
  const busy = flow.requesting || flow.applying;
  // A saved proposal the address names (`?proposal=`) opens in this very run; its stored check describes its stored ticks, any other ticks are asked of the server.
  const savedRun = useSavedRun({ flow, ready: rights.ready, announce });
  const focus = useProposalFocus(run, busy);
  const { saved } = savedRun;
  const liveCheck = useScheduleCheck({
    teamIds: run?.teams.map((team) => team.teamId) ?? [],
    revision: run?.revision ?? 0,
    scopeHash: run?.scopeHash ?? "",
    moves: movesOf(run),
    selected: flow.selected,
    // A viewer who may accept nothing has no ticks to ask about; a saved run answers from its stored check until its ticks change.
    enabled: run !== null && flow.canAccept && (saved === null || saved.asking),
  });
  const check = saved !== null && !saved.asking ? storedCheckState(saved.record) : liveCheck;
  const teamIds = overviewTeamIds(view, narrowed, pick);
  const proposed = useMemo<ProposedSpans>(() => new Map((run?.projects ?? []).map((project) => [project.projectId, project.after])), [run]);
  // The range covers the spans of the SHOWN projects only (a moved project outside the pick has no bar); the table still lists every project the run moves.
  const shownIds = useMemo(() => new Set(shownProjects(narrowed, pick).map((project) => project.id)), [narrowed, pick]);
  const days = useMemo(() => [...proposed].filter(([id]) => shownIds.has(id)).flatMap(([, span]) => [span.start, span.end]), [proposed, shownIds]);
  // A saved run moves what it moved when it was computed: projects the current pick hides have no bar (the table lists them) - the page says how many.
  const outside = saved === null ? 0 : (run?.projects ?? []).filter((project) => !shownIds.has(project.projectId)).length;
  const tooMany = teamIds.length > MAX_RUN_TEAMS;
  const proposable = rights.ready && !unsettled && teamIds.length > 0 && !tooMany && run === null && !busy && !writing && !savedRun.loading;
  return {
    flow,
    rights,
    lock,
    run,
    check,
    focus,
    /** The saved proposal whose run is on screen (`useSavedRun`), or `null`; the ticks and whether they are the viewer's to change follow it. */
    saved,
    /** The saved proposal's id the page opened, kept while Propose again's request runs (the list's mark). */
    openedId: savedRun.openedId,
    ticked: saved?.ticked ?? flow.selected,
    editable: saved?.editable ?? true,
    /** What a `?proposal=` address named that did not open, the way to dismiss it, and whether its record is still on its way. */
    notice: savedRun.notice,
    dismissNotice: savedRun.dismissNotice,
    opening: savedRun.loading,
    /** Close the run (Discard, or Close for a saved one): the parameter leaves the address too. */
    close: savedRun.close,
    teamIds,
    /** The shown projects involve more teams than a run takes. */
    tooMany,
    /** Propose may be clicked now. */
    proposable,
    unsettled,
    /** A refused change's visible note (the page shows it with the window write's), or `null`. */
    refusal: lock.refused ? (lock.open !== null ? t("teams.proposal.readOnly") : t("project.busy")) : null,
    proposed,
    days,
    /** How many projects a saved run moves are outside the current pick (0 for a run of the viewer's own). */
    outside,
    /** The page's write path behind the lock: while a proposal is requested or open a change is refused out loud (`lock.refuse`), else `commit` runs. */
    guard:
      <A extends unknown[]>(commit: (...args: A) => boolean) =>
      (...args: A): boolean =>
        lock.locked ? lock.refuse() : commit(...args),
    /** Ask for the run over the shown projects' teams (a click's, never automatic). */
    propose: (): boolean => proposable && flow.propose(teamIds),
  };
}

/** What the page and the section share of the overview's proposal. */
export type OverviewProposal = ReturnType<typeof useOverviewProposal>;
