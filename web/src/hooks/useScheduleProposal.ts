import { useRef, useState } from "react";
import { useIsMutating, useMutation, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { isStaleRevision } from "../api/roadmap";
import { isStaleScope, proposeTeamSchedule, scheduleTeamMilestones, type ScheduleProposal, type TeamView } from "../api/teams";
import { localIsoDate } from "../utils/isoDate";
import { refreshQueriesAfterMutation } from "../utils/queryRefresh";
import { saveErrorMessage } from "../utils/saveError";
import { acceptItems, noteOf, outcomeOf, outcomeSentence, type ProposalNote, type ProposalOutcome } from "../utils/scheduleProposal";
import { applyTeamSchedule } from "../utils/teamViewUpdate";
import { useRefusal } from "./useRefusal";
import { teamViewEntries, teamWriteKey } from "./useTeamSchedule";

const PROPOSE_ERROR_KEYS = {
  forbidden: "teams.proposal.forbidden",
  notFound: "teams.proposal.gone",
  invalid: "teams.proposal.invalid",
  failedStatus: "common.error.actionFailedStatus",
  failed: "common.error.actionFailed",
} as const;

type AcceptVariables = { expectedRevision: number; scopeHash: string; items: ReturnType<typeof acceptItems> };

/**
 * The team page's schedule proposal (the third write path of the page, v0.8).
 *
 * `propose()` asks the server for a proposal for the viewer's local calendar day (`asOf`; a computation, nothing is written or stored).
 * A proposal with something to show OPENS (`proposal`, every move selected). One without opens nothing and says why in `note`:
 * "nothing to propose", or "no capacity after {{noteDate}}" (the request's own `asOf`: add a capacity period first). The proposal is
 * page state, not the query cache: a refetch of the view under it (another tab's write) does not discard it, and the server's
 * per-milestone staleness rule is the safety net. `toggle`/`selectAll`/`selectNone` change the selection, `discard()` closes the preview
 * (not while an accept runs), `dismiss()` clears the note, the outcome and the failures.
 *
 * `accept()` sends the SELECTED moves with the proposal's `revision` as ONE batch (`POST /teams/{id}/milestone-schedules`) on the
 * page's `teamWriteKey`, so it is one write among the page's others: a drag, a Move or a Reset while it runs is refused out loud by
 * their own paths, and an accept while any write runs is refused out loud too (`refused`, `project.busy` announced; it answers
 * `false`). It cancels the in-flight `["plan"]` reads first, as every optimistic write does. On success, BEFORE the preview closes, the
 * accepted milestones take their proposed dates in the cached team view and the view adopts the revision the batch answered (a skipped
 * one keeps its old dates), then `["plan"]` is refreshed in the background for the server's derived figures; it leaves the `outcome`
 * (no toast: the page's visible outcome note and the polite sentence carry it, so a toast would be a third reading) (written count, skipped with the server's reasons). A whole-batch stale 409 closes the preview
 * (`stale`) and reloads; any other failure stays inline in `error` (already mapped to words) with the preview open. Every taken step is
 * said in the page's live region (`announce`).
 *
 * The accepted dates and the answered revision go into every cached baseline-pick entry of the team's view (the page may show another pick's by
 * now); `loading` (the shown view is the previous pick's copy while the new one loads) refuses an accept like one made during a write.
 *
 * The batch carries the proposal's `scopeHash`. When the TEAM's plan changed since the proposal (a 409 `stale-scope`: nothing was
 * written) the preview closes and a fresh proposal is requested at once, for a fresh `asOf`; the new preview keeps the ticks of the
 * milestones that were ticked and still move, and `rescoped` says so until the next action. A fresh proposal with nothing to show
 * opens nothing and leaves its usual `note`.
 */
export function useScheduleProposal(teamId: number, announce: (text: string) => void, loading: boolean) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [proposal, setProposal] = useState<ScheduleProposal | null>(null);
  const [selected, setSelected] = useState<ReadonlySet<number>>(new Set());
  const [note, setNote] = useState<ProposalNote | null>(null);
  const [noteDate, setNoteDate] = useState("");
  const [outcome, setOutcome] = useState<ProposalOutcome | null>(null);
  const [stale, setStale] = useState(false);
  const [rescoped, setRescoped] = useState(false);
  // The ticks of the proposal a stale-scope refusal voided, until the fresh proposal that replaces it has taken them over.
  const keptTicks = useRef<ReadonlySet<number> | null>(null);

  const close = () => {
    setProposal(null);
    setSelected(new Set());
  };

  const request = useMutation({
    mutationFn: () => proposeTeamSchedule(teamId, localIsoDate()),
    onSuccess: (result) => {
      const kept = keptTicks.current;
      keptTicks.current = null;
      const found = noteOf(result);
      if (found !== null) {
        setNote(found);
        setNoteDate(result.asOf);
        announce(found === "nothing" ? t("teams.proposal.nothing") : t("teams.proposal.noCapacity", { date: result.asOf }));
        return;
      }
      setProposal(result);
      setSelected(new Set(result.moves.map((move) => move.milestoneId).filter((id) => kept === null || kept.has(id))));
      setRescoped(kept !== null);
      announce(t("teams.proposal.ready", { count: result.moves.length }));
    },
    onError: () => {
      keptTicks.current = null;
    },
  });

  const apply = useMutation({
    mutationKey: teamWriteKey(teamId),
    mutationFn: ({ expectedRevision, scopeHash, items }: AcceptVariables) =>
      scheduleTeamMilestones(teamId, { expectedRevision, items, scopeHash }),
    onSuccess: (result, { items }) => {
      // The accepted milestones take their proposed dates in the cached view at once (a skipped one keeps its old dates) and the view
      // adopts the answered revision, so the page is right before the background refetch brings the server's derived figures.
      const spans = new Map(items.map((item) => [item.milestoneId, item]));
      queryClient.setQueriesData<TeamView>(
        { queryKey: teamViewEntries(teamId) },
        (current) =>
          current &&
          result.accepted.reduce((view, id) => {
            const span = spans.get(id);
            return span === undefined ? view : applyTeamSchedule(view, id, span.startDate, span.endDate);
          }, { ...current, revision: result.revision }),
      );
      // Not awaited: the write is over, so the next change may go at once; the refetch brings the server's dates and figures.
      void refreshQueriesAfterMutation(queryClient, ["plan"]);
      const done = outcomeOf(result);
      announce(outcomeSentence(done, t));
      setOutcome(done);
      close();
    },
    onError: async (err) => {
      if (isStaleScope(err)) {
        // The team's plan moved on under the proposal and nothing was written: ask again at once (a fresh asOf) and keep the ticks.
        keptTicks.current = selected;
        close();
        announce(t("teams.proposal.rescoped"));
        request.mutate();
        // NOT awaited: onError settles the accept (`applying`) only when it returns, and the fresh preview must never be shown (or
        // handed the focus) while the accept still reads as running - the refetch finishes whenever it does.
        void refreshQueriesAfterMutation(queryClient, ["plan"]);
        return;
      }
      if (!isStaleRevision(err)) return;
      close();
      setStale(true);
      announce(t("teams.proposal.stale"));
      await refreshQueriesAfterMutation(queryClient, ["plan"]);
    },
  });
  const busy = useIsMutating({ mutationKey: teamWriteKey(teamId) }) > 0;
  // An accept refused because a write of this page was still running: shown and announced until that write is over.
  const [refused, setRefused] = useRefusal(busy || loading);

  /** A fresh start: the previous note, outcome and failures are about the last proposal. */
  const clearMessages = () => {
    setNote(null);
    setOutcome(null);
    setStale(false);
    setRescoped(false);
    request.reset();
    apply.reset();
  };

  const idsOfMoves = proposal?.moves.map((move) => move.milestoneId) ?? [];
  const total = idsOfMoves.length;
  const say = (count: number) => announce(t("teams.proposal.selectedOf", { selected: count, total }));

  const failure = request.isError
    ? request.error
    : apply.isError && !isStaleRevision(apply.error) && !isStaleScope(apply.error)
      ? apply.error
      : null;

  return {
    /** The open proposal (a preview), or `null`. */
    proposal,
    /** The milestone ids whose move is ticked. */
    selected,
    /** A proposal that opened nothing: the page says why in a note (`noteDate` is the request's `asOf`: "no capacity after {{date}}"). */
    note,
    noteDate,
    /** What the last accept came to, until the next action. */
    outcome,
    /** The last accept was refused as a whole (the plan is from before the proposal): the preview closed and the view reloaded. */
    stale,
    /** The last accept was refused because the team's plan changed since the proposal: the open preview is the fresh one, ticks kept. */
    rescoped,
    /** The inline failure of the last propose or accept (already words), or `null`. */
    error: failure === null ? null : saveErrorMessage(failure, t, PROPOSE_ERROR_KEYS),
    requesting: request.isPending,
    applying: apply.isPending,
    /** Ask the server for a proposal. Answers whether the request was sent (not while a proposal is open or a write is running). */
    propose: (): boolean => {
      if (proposal !== null || busy || request.isPending) return false;
      clearMessages();
      request.mutate();
      return true;
    },
    toggle: (milestoneId: number) =>
      setSelected((current) => {
        const next = new Set(current);
        if (!next.delete(milestoneId)) next.add(milestoneId);
        return next;
      }),
    selectAll: () => {
      setSelected(new Set(idsOfMoves));
      say(total);
    },
    selectNone: () => {
      setSelected(new Set());
      say(0);
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
    /** An accept was refused while a write of the page was running (the page shows the "try again" note until that write is over). */
    refused,
    /** Send the selected moves as one batch. Answers whether it was sent (not at zero selected; refused out loud while a write runs). */
    accept: (): boolean => {
      if (proposal === null || selected.size === 0) return false;
      if (busy || loading) {
        setRefused(true);
        announce(t("project.busy"));
        return false;
      }
      // Every `["plan"]` fetch, not just this view: the cache write on success must not be overwritten by a read that began before it.
      void queryClient.cancelQueries({ queryKey: ["plan"] });
      setOutcome(null);
      setStale(false);
      setRescoped(false);
      apply.mutate({ expectedRevision: proposal.revision, scopeHash: proposal.scopeHash, items: acceptItems(proposal, selected) });
      return true;
    },
  };
}
