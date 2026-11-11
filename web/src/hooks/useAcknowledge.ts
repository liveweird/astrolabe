import { useEffect, useRef, useState, type RefObject } from "react";
import { useTranslation } from "react-i18next";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { acknowledgeDeviation, isStaleDeviations, unacknowledgeDeviation, type DeviationItem, type DeviationLine } from "../api/deviations";
import { ApiError } from "../api/http";
import { deviationAckAllKey, deviationAckKey } from "../utils/deviations";
import { refreshJiraAndTimelines, refreshQueriesAfterMutation } from "../utils/queryRefresh";
import { saveErrorMessage } from "../utils/saveError";
import { showSuccessToast } from "../utils/toast";

/**
 * What a write asks for (1.12, per line): acknowledge ONE line as the page read it (the item's fingerprint and the line's kind), withdraw that line's
 * acknowledgement, or - the batch, no kind - acknowledge every line without a current acknowledgement (`acknowledgeAll`) or withdraw every stored one
 * (`unacknowledgeAll`). A batch is keyed by the binding's all-key, a line by binding and kind.
 */
type AckRequest =
  | { kind: "acknowledge" | "unacknowledge"; item: DeviationItem; line: DeviationLine }
  | { kind: "acknowledgeAll" | "unacknowledgeAll"; item: DeviationItem };

/** The message a write left, tied to its control's key: `stale` = the 409 note (the list is re-read), `failure` = a refusal already in words (inline, red). */
type AckNotice = { key: string; kind: "stale" } | { key: string; kind: "failure"; text: string };

export type Acknowledge = {
  /** The key being written (a line's, or a binding's "all" key for a batch), else null: every action waits for it, so a second click cannot race the first. */
  busyKey: string | null;
  /** The newest message, shown under its own control (the page shows it itself only when that control has left the list); null = none. */
  notice: AckNotice | null;
  /** `neighbours` are the control keys to try for the focus, in order, if this one leaves the list (the item's own, then the next row's, then the previous row's). */
  run: (request: AckRequest, neighbours: readonly string[]) => void;
};

/** The button carrying a control key (`DeviationAckCell` and `DeviationAckAll` mark their buttons with it). */
const buttonOf = (key: string) => document.querySelector<HTMLElement>(`[data-ack-for="${key}"]`);

const keyOf = (request: AckRequest) => ("line" in request ? deviationAckKey(request.item.bindingId, request.line.kind) : deviationAckAllKey(request.item.bindingId));

/**
 * Acknowledging a binding's deviations from the Deviations page: `POST` / `DELETE /integrations/jira/bindings/{id}/acknowledge`, one line (with `kind`) or
 * all of them (without). The state machine of Flow's `useCapacityAcknowledge`, keyed by a string.
 *
 * **What is refreshed.** An acknowledgement changes what the Jira flags on the four timeline views show (a current one silences them), so a
 * success re-reads the `["jira"]` queries AND the timeline views (`["plan"]`: plan, project and team; `["roadmap"]`: roadmap and programs), through
 * `refreshQueriesAfterMutation` (the cancel-then-invalidate order). A `409 stale-deviations` is a normal state, not an error: the plan or Jira moved
 * since the list was read, so it is an inline note in the row (never a toast) and re-reads the same keys. A 403/404 re-reads `["jira"]`
 * (the rights or the link changed) and, like every other refusal, is an inline red message in the row. A DELETE's 404 means "no acknowledgement stored".
 *
 * **Scope.** `scope` is the filters' URL string. The messages belong to the list they were made on: a different scope drops them (adjusted during
 * render, so Back, a chip link and "Clear the filters" all count), and a write that settles after the scope changed sets no message and moves no focus.
 *
 * **Focus.** The clicked button is gone once the refetch has taken the row off the Open list (or swapped Acknowledge for Unacknowledge), and the
 * browser would leave the focus on `body`. After a write that re-reads, the focus goes, at every render and once more when the re-read has settled,
 * by `useDeleteConfirm`'s rule: focus on `body` -> take it (the clicked control's key if it is still there, else the row's other controls, else the next row's, else the previous row's,
 * else `fallback`, the list's heading); anywhere else (the user, or the browser, put it somewhere real) -> leave it. A write that failed without a re-read
 * never arms it: the button is still where it was.
 */
export function useAcknowledge(fallback: RefObject<HTMLElement | null>, scope: string): Acknowledge {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [notice, setNotice] = useState<AckNotice | null>(null);
  const [seenScope, setSeenScope] = useState(scope);
  if (seenScope !== scope) {
    setSeenScope(scope);
    setNotice(null);
  }
  // The scope a settling write compares its own against.
  const latestScope = useRef(scope);
  useEffect(() => {
    latestScope.current = scope;
  }, [scope]);
  // The rows whose button may take the focus, in order of preference; null = no move is waiting.
  const pending = useRef<readonly string[] | null>(null);

  const settleFocus = () => {
    const candidates = pending.current;
    if (candidates === null) return;
    const active = document.activeElement;
    if (active !== null && active !== document.body) return;
    pending.current = null;
    const target = candidates.map(buttonOf).find((button) => button !== null) ?? fallback.current;
    target?.focus({ preventScroll: true });
  };
  // Every render, after the DOM is committed: the refetch that takes the row away is such a render.
  useEffect(settleFocus);

  const refresh = async (refreshing: () => Promise<void>) => {
    await refreshing();
    // A last look for the case where no render followed the re-read; then the move is dropped, so a later body focus is the user's.
    window.setTimeout(() => {
      settleFocus();
      pending.current = null;
    }, 0);
  };

  type Variables = { request: AckRequest; neighbours: readonly string[]; scope: string };
  const mutation = useMutation({
    mutationFn: async ({ request }: Variables) => {
      const { bindingId, fingerprint } = request.item;
      if ("line" in request) {
        if (request.kind === "acknowledge") await acknowledgeDeviation(bindingId, fingerprint, request.line.kind);
        else await unacknowledgeDeviation(bindingId, request.line.kind);
      } else if (request.kind === "acknowledgeAll") await acknowledgeDeviation(bindingId, fingerprint);
      else await unacknowledgeDeviation(bindingId);
    },
    onMutate: () => setNotice(null),
    onSuccess: async (_result, { request, neighbours, scope: writtenOn }) => {
      if (writtenOn === latestScope.current) pending.current = [keyOf(request), ...neighbours];
      showSuccessToast(t(request.kind === "acknowledge" || request.kind === "acknowledgeAll" ? "deviations.ack.toast.acknowledged" : "deviations.ack.toast.withdrawn"));
      await refresh(() => refreshJiraAndTimelines(queryClient));
    },
    onError: async (err, { request, neighbours, scope: writtenOn }) => {
      const key = keyOf(request);
      const current = writtenOn === latestScope.current;
      if (isStaleDeviations(err)) {
        if (current) {
          setNotice({ key, kind: "stale" });
          pending.current = [key, ...neighbours];
        }
        await refresh(() => refreshJiraAndTimelines(queryClient));
        return;
      }
      const notFound = request.kind === "unacknowledge" || request.kind === "unacknowledgeAll" ? "deviations.ack.notFoundWithdrawn" : "deviations.ack.notFound";
      const text = saveErrorMessage(err, t, { forbidden: "deviations.ack.forbidden", notFound, failedStatus: "common.error.actionFailedStatus", failed: "deviations.ack.failed" });
      if (current) setNotice({ key, kind: "failure", text });
      if (err instanceof ApiError && (err.status === 403 || err.status === 404)) {
        if (current) pending.current = [key, ...neighbours];
        await refresh(() => refreshQueriesAfterMutation(queryClient, ["jira"]));
      }
    },
  });

  return {
    busyKey: mutation.isPending ? keyOf(mutation.variables.request) : null,
    notice,
    run: (request, neighbours) => {
      if (!mutation.isPending) mutation.mutate({ request, neighbours, scope });
    },
  };
}
