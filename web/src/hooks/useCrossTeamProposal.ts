import { useRef, useState } from "react";
import { useIsMutating, useMutation, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { acceptCrossTeamSchedule, proposeCrossTeamSchedule, type CrossTeamProposal } from "../api/scheduleProposals";
import { isStaleRevision } from "../api/roadmap";
import { isStaleScope } from "../api/teams";
import { localIsoDate } from "../utils/isoDate";
import { refreshQueriesAfterMutation } from "../utils/queryRefresh";
import { saveErrorMessage } from "../utils/saveError";
import { acceptItems, noteOf, outcomeOf, outcomeSentence, type ProposalNote, type ProposalOutcome, type ProposalWords } from "../utils/scheduleProposal";
import { useRefusal } from "./useRefusal";

const ERROR_KEYS = {
  forbidden: "scheduleProposals.forbidden",
  notFound: "scheduleProposals.gone",
  invalid: "scheduleProposals.invalid",
  failedStatus: "common.error.actionFailedStatus",
  failed: "common.error.actionFailed",
} as const;

/** The write key of the page's one write, the accept (a propose is a computation). */
const ACCEPT_KEY = ["schedule-proposals", "accept"] as const;

type AcceptVariables = { expectedRevision: number; scopeHash: string; teamIds: number[]; items: ReturnType<typeof acceptItems> };

/** Every move of every team of a run, in placement order (milestone ids are global, so one selection covers all the sections). */
export const movesOf = (run: Pick<CrossTeamProposal, "teams"> | null) => run?.teams.flatMap((team) => team.moves) ?? [];

/**
 * The cross-team schedule proposal (1.8): the team page's `useScheduleProposal` state machine over a RUN of several teams.
 *
 * `propose(teamIds)` asks the server for ONE proposal over the listed teams for the viewer's local calendar day (a computation: nothing is
 * written or stored). A run with something to show OPENS (`proposal`, every move of every team ticked); one with no move anywhere opens
 * nothing and says why in `note` (the same two notes as the team page's). The run is page state: the server's per-milestone staleness
 * rule and the run's `scopeHash` are the safety net. `toggle`, `selectAll(teamId)` and `selectNone(teamId)` change the ONE selection
 * (a team's buttons act on that team's moves), `discard()` closes the preview (not while the accept runs), `dismiss()` clears the notes.
 *
 * `accept()` sends the ticked moves of ALL teams with the run's `revision`, `scopeHash` and team set as ONE request
 * (`POST /schedule-proposals/accept`): one plan write, one revision bump. An accept while one is running (or a proposal is on its way) is
 * refused out loud (`refused`, `project.busy` announced; it answers `false`). On success the plan's cached views are refreshed (no cache
 * patch: the page holds no view), the preview closes and `outcome` says what came of it (written and skipped with the server's reasons;
 * no toast: the visible note and the polite sentence carry it). A whole-request stale-revision 409 closes the preview (`stale`); a
 * `stale-scope` 409 (the run teams' plan changed, nothing was written) closes it and asks the SAME teams again at once, keeping the ticks
 * of the moves that still exist (`rescoped` says so); any other failure stays inline in `error` (already words) with the preview open.
 * Every taken step is said through `announce`, the page's polite status region.
 */
export function useCrossTeamProposal(announce: (text: string) => void) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [proposal, setProposal] = useState<CrossTeamProposal | null>(null);
  const [selected, setSelected] = useState<ReadonlySet<number>>(new Set());
  const [note, setNote] = useState<ProposalNote | null>(null);
  const [noteDate, setNoteDate] = useState("");
  const [outcome, setOutcome] = useState<ProposalOutcome | null>(null);
  const [stale, setStale] = useState(false);
  const [rescoped, setRescoped] = useState(false);
  // The ticks of the run a stale-scope refusal voided, until the fresh run that replaces it has taken them over.
  const keptTicks = useRef<ReadonlySet<number> | null>(null);
  // Set the moment an accept is sent and cleared when it settles: a second accept in the SAME tick (a double click) sees it before React has re-rendered `writing`.
  const inFlight = useRef(false);
  // The notes this page words itself: they speak of the chosen teams, not of one team and not of a schedule to reload.
  const words: ProposalWords = {
    noCapacity: (date) => t("scheduleProposals.noCapacity", { date }),
    stale: t("scheduleProposals.stale"),
    rescoped: t("scheduleProposals.rescoped"),
  };

  const close = () => {
    setProposal(null);
    setSelected(new Set());
    // The ticked-subset checks belong to the run that closes: drop them before a `["plan"]` refresh can re-ask an active one.
    queryClient.removeQueries({ queryKey: ["plan", "schedule-check"] });
  };

  const request = useMutation({
    mutationFn: (teamIds: number[]) => proposeCrossTeamSchedule({ asOf: localIsoDate(), teamIds }),
    onSuccess: (result) => {
      const kept = keptTicks.current;
      keptTicks.current = null;
      const found = noteOf({ moves: movesOf(result), unchanged: result.teams.flatMap((team) => team.unchanged), unplaced: result.teams.flatMap((team) => team.unplaced) });
      if (found !== null) {
        setNote(found);
        setNoteDate(result.asOf);
        announce(found === "nothing" ? t("teams.proposal.nothing") : words.noCapacity(result.asOf));
        return;
      }
      const moves = movesOf(result);
      setProposal(result);
      setSelected(new Set(moves.map((move) => move.milestoneId).filter((id) => kept === null || kept.has(id))));
      setRescoped(kept !== null);
      // ONE sentence: two announcements in one batch would keep only the last. A run that did not settle says so after the ready sentence.
      const ready = t("teams.proposal.ready", { count: moves.length });
      announce(result.settled ? ready : `${ready}. ${t("scheduleProposals.facts.unsettled", { count: result.passes })}`);
    },
    onError: () => {
      keptTicks.current = null;
    },
  });

  const apply = useMutation({
    mutationKey: ACCEPT_KEY,
    mutationFn: (body: AcceptVariables) => acceptCrossTeamSchedule(body),
    onSettled: () => {
      inFlight.current = false;
    },
    onSuccess: (result) => {
      // Not awaited: the write is over, so the next change may go at once; every team view and timeline carries these dates.
      void refreshQueriesAfterMutation(queryClient, ["plan"], ["roadmap"]);
      const done = outcomeOf(result);
      announce(outcomeSentence(done, t));
      setOutcome(done);
      close();
    },
    onError: async (err, { teamIds }) => {
      if (isStaleScope(err)) {
        // The run teams' plan moved on under the proposal and nothing was written: ask again at once (a fresh asOf) and keep the ticks.
        keptTicks.current = selected;
        close();
        announce(words.rescoped);
        request.mutate(teamIds);
        // NOT awaited: onError settles the accept (`applying`) only when it returns, and the fresh preview must never be shown (or
        // handed the focus) while the accept still reads as running.
        void refreshQueriesAfterMutation(queryClient, ["plan"]);
        return;
      }
      if (!isStaleRevision(err)) return;
      close();
      setStale(true);
      announce(words.stale);
      await refreshQueriesAfterMutation(queryClient, ["plan"]);
    },
  });
  const writing = useIsMutating({ mutationKey: ACCEPT_KEY }) > 0;
  // An accept refused because one was still running: shown and announced until that write is over.
  const [refused, setRefused] = useRefusal(writing || request.isPending);

  /** A fresh start: the previous note, outcome and failures are about the last run. */
  const clearMessages = () => {
    setNote(null);
    setOutcome(null);
    setStale(false);
    setRescoped(false);
    request.reset();
    apply.reset();
  };

  const moves = movesOf(proposal);
  const say = (count: number) => announce(t("teams.proposal.selectedOf", { selected: count, total: moves.length }));
  const idsOf = (teamId: number) => proposal?.teams.find((team) => team.teamId === teamId)?.moves.map((move) => move.milestoneId) ?? [];

  const failure = request.isError
    ? request.error
    : apply.isError && !isStaleRevision(apply.error) && !isStaleScope(apply.error)
      ? apply.error
      : null;

  return {
    /** The open run (a preview), or `null`. */
    proposal,
    /** The milestone ids whose move is ticked, over every team. */
    selected,
    /** A run that opened nothing: the page says why in a note (`noteDate` is the request's `asOf`). */
    note,
    noteDate,
    /** What the last accept came to, until the next action. */
    outcome,
    /** The last accept was refused as a whole (the plan is from before the run): the preview closed. */
    stale,
    /** The last accept was refused because the run teams' plan changed since the run: the open preview is the fresh one, ticks kept. */
    rescoped,
    /** The sentences this page words itself for the notes (`ProposalNotes`). */
    words,
    /** The inline failure of the last propose or accept (already words), or `null`. */
    error: failure === null ? null : saveErrorMessage(failure, t, ERROR_KEYS),
    requesting: request.isPending,
    applying: apply.isPending,
    /** Ask the server for a run over `teamIds`. Answers whether the request was sent (not while a run is open or being asked for or accepted). */
    propose: (teamIds: number[]): boolean => {
      if (proposal !== null || writing || request.isPending || teamIds.length === 0) return false;
      clearMessages();
      request.mutate(teamIds);
      return true;
    },
    toggle: (milestoneId: number) =>
      setSelected((current) => {
        const next = new Set(current);
        if (!next.delete(milestoneId)) next.add(milestoneId);
        return next;
      }),
    /** Tick every move of ONE team (the others keep their ticks). */
    selectAll: (teamId: number) => {
      const next = new Set([...selected, ...idsOf(teamId)]);
      setSelected(next);
      say(next.size);
    },
    /** Untick every move of ONE team. */
    selectNone: (teamId: number) => {
      const drop = new Set(idsOf(teamId));
      const next = new Set([...selected].filter((id) => !drop.has(id)));
      setSelected(next);
      say(next.size);
    },
    /** Close the preview without writing anything. Not while the accept runs. */
    discard: (): boolean => {
      if (apply.isPending) return false;
      close();
      clearMessages();
      return true;
    },
    /** Dismiss the note, the outcome and the stale notice. */
    dismiss: clearMessages,
    /** An accept was refused while one was running (the page shows the "try again" note until that write is over). */
    refused,
    /** Send the ticked moves of all teams as one request. Answers whether it was sent (not at zero ticked; refused out loud while a write runs). */
    accept: (): boolean => {
      if (proposal === null || selected.size === 0) return false;
      if (inFlight.current || writing || request.isPending) {
        setRefused(true);
        announce(t("project.busy"));
        return false;
      }
      setOutcome(null);
      setStale(false);
      setRescoped(false);
      inFlight.current = true;
      apply.mutate({
        expectedRevision: proposal.revision,
        scopeHash: proposal.scopeHash,
        teamIds: proposal.teams.map((team) => team.teamId),
        items: acceptItems({ moves }, selected),
      });
      return true;
    },
  };
}
