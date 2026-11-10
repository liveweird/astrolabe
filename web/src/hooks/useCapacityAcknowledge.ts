import { useEffect, useRef, useState, type RefObject } from "react";
import { useTranslation } from "react-i18next";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { acknowledgeCapacityDeviation, acknowledgeCapacityDeviations, unacknowledgeCapacityDeviation, type CapacityDeviation } from "../api/capacityDeviations";
import { isStaleDeviations } from "../api/deviations";
import { ApiError } from "../api/http";
import { capacityAckAllKey, capacityAckKey } from "../utils/capacityDeviations";
import { refreshCapacityAcknowledgements, refreshFlowLinks } from "../utils/flowRefresh";
import { saveErrorMessage } from "../utils/saveError";
import { showSuccessToast } from "../utils/toast";

/**
 * What a write asks for: acknowledge ONE sprint's deviation as the page read it (the row's fingerprint), withdraw its acknowledgement, or acknowledge
 * every open row of a team at once (`acknowledgeAll`: the rows the list shows as open, each with the fingerprint the page read; keyed by the binding).
 */
type AckRequest = { kind: "acknowledge" | "unacknowledge"; bindingId: number; row: CapacityDeviation } | { kind: "acknowledgeAll"; bindingId: number; rows: readonly CapacityDeviation[] };

/** The message a write left, tied to its row's key: `stale` = the 409 note (the list is re-read), `failure` = a refusal already in words (inline, red). */
type CapacityAckNotice = { key: string; kind: "stale" } | { key: string; kind: "failure"; text: string };

export type CapacityAcknowledge = {
  /** The key being written (a row's, or a team's "all" key for the batch), else null: every action waits for it, so a second click cannot race the first. */
  busyKey: string | null;
  /** The newest message, shown under its own control - a row's cell or the team's "Acknowledge all" (the list shows it itself only when that control has left it); null = none. */
  notice: CapacityAckNotice | null;
  /** `neighbours` are the keys of the rows beside this one (next first): where the focus goes if this row leaves the list. */
  run: (request: AckRequest, neighbours: readonly string[]) => void;
};

/** The button of a row's action cell (`CapacityAckCell` marks both of its buttons with the row's key). */
const buttonOf = (key: string) => document.querySelector<HTMLElement>(`[data-ack-for="${key}"]`);

const keyOf = (request: AckRequest) => (request.kind === "acknowledgeAll" ? capacityAckAllKey(request.bindingId) : capacityAckKey(request.bindingId, request.row.detail.sprintId));

/**
 * Acknowledging a sprint's capacity deviation (or, since 1.10, all of a team's open rows at once), from the Deviations page's Capacity from Flow section and from the team page's Flow section:
 * `POST` / `DELETE /integrations/flow/team-bindings/{id}/acknowledge`, and (1.10) all of a team's open rows in one `POST …/acknowledge-all`. The state
 * machine of the Jira `useAcknowledge`, keyed by the row (binding + sprint) instead of the binding; a batch is keyed by the binding (`<id>:all`). A batch
 * is all or nothing, so its `409 stale-deviations` is the same note (the list is read again, nothing was stored) and its success the same toast.
 *
 * **What is refreshed.** A success re-reads the capacity deviations and the plan's views (`refreshCapacityAcknowledgements`: the team view's flag
 * and markers follow the open rows). A `409 stale-deviations` is a normal state, not an error: the sprint's figures changed since the list was read (or the
 * row is gone), so it is an inline note in the row (never a toast) and re-reads the same keys. A 403/404 re-reads the Flow links too (the rights or the
 * link changed) and, like every other refusal, is an inline red message in the row. A DELETE's 404 means "no acknowledgement stored".
 *
 * **Scope.** `scope` names the list the messages were made on (the filters, or the team): a different scope drops them (adjusted during render), and a
 * write that settles after the scope changed sets no message and moves no focus.
 *
 * **Focus.** The clicked button is gone once the refetch has taken the row off the Open list (or swapped Acknowledge for Unacknowledge), and the
 * browser would leave the focus on `body`. After a write that re-reads, the focus goes by `useAcknowledge`'s rule: focus on `body` -> take it (the
 * row's own button if it is still there, else the next row's, else the previous row's, else `fallback`, the list's heading); anywhere else -> leave it.
 */
export function useCapacityAcknowledge(fallback: RefObject<HTMLElement | null>, scope: string): CapacityAcknowledge {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [notice, setNotice] = useState<CapacityAckNotice | null>(null);
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
      if (request.kind === "acknowledgeAll") await acknowledgeCapacityDeviations(request.bindingId, request.rows.map((row) => ({ sprintId: row.detail.sprintId, fingerprint: row.fingerprint })));
      else if (request.kind === "acknowledge") await acknowledgeCapacityDeviation(request.bindingId, { sprintId: request.row.detail.sprintId, fingerprint: request.row.fingerprint });
      else await unacknowledgeCapacityDeviation(request.bindingId, request.row.detail.sprintId);
    },
    onMutate: () => setNotice(null),
    onSuccess: async (_result, { request, neighbours, scope: writtenOn }) => {
      if (writtenOn === latestScope.current) pending.current = [keyOf(request), ...neighbours];
      showSuccessToast(t(request.kind === "unacknowledge" ? "deviations.ack.toast.withdrawn" : "deviations.ack.toast.acknowledged"));
      await refresh(() => refreshCapacityAcknowledgements(queryClient));
    },
    onError: async (err, { request, neighbours, scope: writtenOn }) => {
      const key = keyOf(request);
      const current = writtenOn === latestScope.current;
      if (isStaleDeviations(err)) {
        if (current) {
          setNotice({ key, kind: "stale" });
          pending.current = [key, ...neighbours];
        }
        await refresh(() => refreshCapacityAcknowledgements(queryClient));
        return;
      }
      const notFound = request.kind === "unacknowledge" ? "deviations.ack.notFoundWithdrawn" : "deviations.ack.notFound";
      const text = saveErrorMessage(err, t, { forbidden: "deviations.capacity.ack.forbidden", notFound, failedStatus: "common.error.actionFailedStatus", failed: "deviations.ack.failed" });
      if (current) setNotice({ key, kind: "failure", text });
      if (err instanceof ApiError && (err.status === 403 || err.status === 404)) {
        if (current) pending.current = [key, ...neighbours];
        await refresh(() => refreshFlowLinks(queryClient));
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
