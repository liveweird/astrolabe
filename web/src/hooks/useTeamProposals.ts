import { useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { ScheduleProposal, TeamView } from "../api/teams";
import { ghostRowId } from "../utils/dependencyArrows";
import { drawnMoves, overlayCheck } from "../utils/scheduleProposal";
import { linkedTeamIds, teamRunPreview } from "../utils/teamRunPreview";
import { applyAcceptedBatch } from "../utils/teamViewUpdate";
import { movesOf, useCrossTeamProposal } from "./useCrossTeamProposal";
import { useProposalRights } from "./useProposalRights";
import { MAX_RUN_TEAMS, useRunTeams } from "./useRunTeams";
import { useScheduleCheck } from "./useScheduleCheck";
import { useScheduleProposal } from "./useScheduleProposal";
import { teamViewKey } from "./useTeamSchedule";
import { useTickedProjects } from "./useTickedProjects";

/** The picker's default: no other team (the page's own team is always in the run and is not an option). */
const NO_TEAMS: number[] = [];

/**
 * The team page's schedule proposal in both of its forms (1.38), behind ONE surface the page, its buttons and its notes read:
 * - **Alone** (no other team chosen, the default): the team's own proposal, `useScheduleProposal`, exactly as before (the per-team route, its section, its accept on the page's write key);
 * - **Together** (other teams chosen in "Plan together with", or added by "Add linked teams"): ONE cross-team run over `[this team, ...chosen]` (`useCrossTeamProposal`), previewed on the
 *   page. This team's moves and those of every other run team the viewer may accept (`useProposalRights`) are tickable and ticked; the other teams' sections are read-only. The accept is the
 *   run's one accept (`acceptTeamIds` = the teams of the ticked moves); `onAccepted` puts the accepted dates of THIS team into the page's own cached view before the refresh (a mounted page
 *   would otherwise build its next order write on a list that lacks a milestone the run just scheduled). No Save here (the Roadmap overview's).
 * `used` is the form of the last Propose: it can only change while nothing is requested or open (the picker is not drawn then), so the notes and the open section always belong to one hook.
 * `proposal` is THIS team's block of the open run in the per-team proposal's shape (`revision`, `scopeHash` and `asOf` of the run), so the lock, the focus, the range and the check read the same
 * field in both forms. `shown` is what the timeline and the table draw: the check's verdicts for the ticked moves and the dashed bars that follow the ticks.
 * `view` is the page's view (absent while it loads): its links decide the linked teams and which other teams' milestones the preview names. `chain` is the Critical path toggle.
 */
export function useTeamProposals(teamId: number, announce: (text: string) => void, loading: boolean, baseline: number | null, chain: boolean, view: TeamView | undefined) {
  const queryClient = useQueryClient();
  const others = useRunTeams(NO_TEAMS);
  const [used, setUsed] = useState<"alone" | "together">("alone");
  // Read only once the viewer plans with other teams: the page's own proposal needs no rights (the page's flag decides, as always).
  const rights = useProposalRights(others.chosen);
  const alone = useScheduleProposal(teamId, announce, loading, baseline, chain);
  const together = useCrossTeamProposal(announce, {
    acceptable: rights.acceptable,
    onAccepted: (result, items) => queryClient.setQueryData<TeamView>(teamViewKey(teamId, baseline, chain), (current) => current && applyAcceptedBatch(current, result, items)),
  });
  const run = used === "together" ? together.proposal : null;
  const flow = used === "together" ? together : alone;
  const ownBlock = useMemo<ScheduleProposal | null>(() => {
    const block = run?.teams.find((team) => team.teamId === teamId);
    return run === null || block === undefined ? null : { ...block, revision: run.revision, scopeHash: run.scopeHash, asOf: run.asOf };
  }, [run, teamId]);
  const open = used === "together" ? ownBlock : alone.proposal;
  const requesting = flow.requesting;
  const selected = flow.selected;
  // The ticked-subset check: the team's own moves alone, or every move of the run (the run's team blocks all answer).
  const check = useScheduleCheck({
    teamIds: run === null ? [teamId] : run.teams.map((team) => team.teamId),
    revision: (run ?? open)?.revision ?? 0,
    scopeHash: (run ?? open)?.scopeHash ?? "",
    moves: run === null ? (open?.moves ?? []) : movesOf(run),
    selected,
    enabled: run === null ? open !== null : together.canAccept,
  });
  // The projects follow the ticks only for a viewer who may tick EVERY move of the run (the check answers for the ticked moves alone).
  const { tickable } = together;
  const ticksAll = run !== null && together.canAccept && movesOf(run).every((move) => tickable.has(move.milestoneId));
  const followed = useTickedProjects(run, check, ticksAll);
  const dependencies = view?.dependencies;
  const chainMembers = chain ? view?.criticalChain?.members : undefined;
  const preview = useMemo(
    () =>
      run === null || dependencies === undefined
        ? null
        : teamRunPreview({ teamId, dependencies, run, projects: followed.projects, selected, tickable, chainRows: new Set((chainMembers ?? []).map(ghostRowId)) }),
    [run, dependencies, teamId, followed.projects, selected, tickable, chainMembers],
  );
  const shown = open === null ? null : { ...overlayCheck(open, check, teamId), drawn: drawnMoves(open.moves, selected, run === null ? undefined : tickable) };

  const chosen = others.ids;
  const linked = useMemo(() => (dependencies === undefined ? NO_TEAMS : linkedTeamIds(dependencies, teamId)), [dependencies, teamId]);
  const tooMany = chosen.length + 1 > MAX_RUN_TEAMS;
  const waiting = chosen.length > 0 && !rights.ready;
  const proposable = !tooMany && !waiting;
  const locked = open !== null || requesting;

  return {
    /** THIS team's open proposal (its block of the run, when planned together), or `null`. */
    proposal: open,
    /** What the timeline and the table draw of it: the ticked moves' verdicts and load, the dashed bars that follow the ticks. */
    shown,
    selected,
    note: flow.note,
    noteDate: flow.noteDate,
    outcome: flow.outcome,
    stale: flow.stale,
    rescoped: flow.rescoped,
    /** The cross-team page's own sentences for the notes (planned together only). */
    words: used === "together" ? together.words : undefined,
    error: flow.error,
    requesting,
    applying: flow.applying,
    refused: flow.refused,
    dismiss: flow.dismiss,
    toggle: flow.toggle,
    /** Tick / untick every move of THIS team. */
    selectAll: () => (used === "together" ? together.selectAll(teamId) : alone.selectAll()),
    selectNone: () => (used === "together" ? together.selectNone(teamId) : alone.selectNone()),
    accept: flow.accept,
    discard: flow.discard,
    /** Ask for the proposal: alone when no other team is chosen, else the run. Answers whether the request was sent. */
    propose: (): boolean => {
      if (locked) return false;
      // The form changes only once a request really started: a refused Propose leaves the previous run's notes where they are.
      if (chosen.length === 0) {
        const sent = alone.propose();
        if (sent) setUsed("alone");
        return sent;
      }
      if (!proposable) return false;
      const sent = together.propose([teamId, ...chosen]);
      if (sent) setUsed("together");
      return sent;
    },
    /** Propose may be clicked as far as the chosen teams go (the page's own conditions apply besides). */
    proposable,
    /** Why Propose waits, when it does (words in the page's own keys): the rights being read, or too many teams. */
    waitingFor: tooMany ? ("tooMany" as const) : waiting ? ("rights" as const) : null,
    /** The run the viewer previews, or `null` (alone, or nothing open). */
    run,
    /** The run's hook: the section's toggles, ticks and accept (together only). */
    together,
    rights,
    check,
    /** The moves the viewer may tick (together only; `undefined` = every move of this team's own proposal). */
    tickable: run === null ? undefined : tickable,
    /** The other teams' linked milestones and projects the run moves (together only). */
    preview,
    /** The props of the "Plan together with" picker, `disabled` while a proposal is requested or open (the page draws none then), and the linked teams "Add linked teams" adds. */
    picker: {
      value: chosen,
      onChange: others.set,
      defaultIds: NO_TEAMS,
      excludeId: teamId,
      disabled: locked,
      linked,
      addLinked: () => others.set([...chosen, ...linked.filter((id) => !chosen.includes(id))]),
      /** The team set of the run, this team included. */
      count: chosen.length + 1,
    },
  };
}

/** What the page, its buttons and its notes share of the team's proposals. */
export type TeamProposals = ReturnType<typeof useTeamProposals>;
