import { useRef, useState } from "react";
import { useIsMutating, useMutation, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { ApiError } from "../api/http";
import { planViewKey, putProgramOrder, putWorkStreamOrder, type PlanView } from "../api/plan";
import { isStaleRevision } from "../api/roadmap";
import { applyOrder, droppedIds, fullIds, listOf, orderRevision, siblingIds, steppedIds, withOrderRevision, type OrderList, type OrderNode } from "../utils/planOrder";
import { refreshQueriesAfterMutation } from "../utils/queryRefresh";
import { sameIds } from "../utils/roadmapOrder";
import { saveErrorMessage } from "../utils/saveError";
import { useRefusal } from "./useRefusal";

/** The one mutation key of the page's order writes (a work stream list and a stream's program list share it: one write at a time). */
const PLAN_ORDER_WRITE_KEY = ["plan", "order-write"] as const;

const SAVE_ERROR_KEYS = {
  forbidden: "plan.order.forbidden",
  failedStatus: "common.error.actionFailedStatus",
  failed: "common.error.actionFailed",
} as const;

type SaveVariables = { list: OrderList; ids: number[]; expectedRevision: number; before: PlanView };

/**
 * A refusal that means "the plan changed under you": the stale-revision 409, and what the PUTs answer when a listed node was deleted, moved to another
 * work stream or its work stream deleted meanwhile (a 400 or a 404; a removal does not bump an order revision, by design).
 */
const listChanged = (error: unknown) => isStaleRevision(error) || (error instanceof ApiError && (error.status === 400 || error.status === 404));

/**
 * The Plan page's order write path (the `useTeamOrder` shape): every change - Move up / Move down from a row's menu, a row drag - becomes the COMPLETE
 * new list of the list it belongs to (the work streams, or one stream's programs, in the document's effective order with only that move applied; never
 * a partial list) and goes out as the wholesale `PUT /work-stream-order` or `PUT /work-streams/{id}/program-order` with THAT list's own revision
 * (`workStreamOrderRevision`, the stream's `programOrderRevision`; never the view's plan `revision`):
 *  - the rows are reordered optimistically in the cached view, at once;
 *  - success stores the revision the PUT answers into the list and refreshes `["plan"]` and `["roadmap"]` in the background (the Programs page reads the same order);
 *  - a stale 409 (or a 400 / 404: a listed node left) rolls back, says so (`stale`, announced) and AWAITS the reload; nothing is lost;
 *  - any other failure rolls back and surfaces through `error`, already mapped to words.
 * A change made while a write is in flight is REFUSED out loud (`refused`, `project.busy`): `move` and `dropAt` answer whether the change was taken
 * (one that changes nothing is taken without a PUT). A taken change is announced through the page's one polite region (`announce`), a drop too: the
 * handle is pointer-only and dnd-kit's own announcements are silenced.
 */
export function usePlanOrder(view: PlanView | undefined, announce: (text: string) => void) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [rollbacks, setRollbacks] = useState(0);
  /** PUTs sent so far (a ref: read by the page right after a change, before any render). */
  const writes = useRef(0);

  const save = useMutation({
    mutationKey: PLAN_ORDER_WRITE_KEY,
    mutationFn: ({ list, ids, expectedRevision }: SaveVariables) =>
      list.kind === "workStream" ? putWorkStreamOrder({ expectedRevision, workStreamIds: ids }) : putProgramOrder(list.streamId, { expectedRevision, programIds: ids }),
    onSuccess: ({ revision }, { list }) => {
      queryClient.setQueryData<PlanView>(planViewKey, (current) => current && withOrderRevision(current, list, revision));
      // Not awaited: the save is over, so the next change may go at once; its `commit` cancels this refetch.
      void refreshQueriesAfterMutation(queryClient, ["plan"], ["roadmap"]);
    },
    onError: async (err, { before }) => {
      queryClient.setQueryData<PlanView>(planViewKey, before);
      // The page shows the visible note; the live region says it too (a screen-reader user otherwise sees the list jump back unannounced).
      if (listChanged(err)) announce(t("plan.order.stale"));
      try {
        await refreshQueriesAfterMutation(queryClient, ["plan"], ["roadmap"]);
      } finally {
        // The view is back (and the reload has settled): the page may return the keyboard focus to the row the change came from.
        setRollbacks((count) => count + 1);
      }
    },
  });
  const busy = useIsMutating({ mutationKey: PLAN_ORDER_WRITE_KEY }) > 0;
  // A change refused because a write was still running: shown and announced until no write is in flight.
  const [refused, setRefused] = useRefusal(busy);

  const nameOf = (node: OrderNode) => {
    if (!view) return "";
    if (node.kind === "workStream") return view.workStreams.find((stream) => stream.id === node.id)?.name ?? "";
    return view.workStreams.flatMap((stream) => stream.programs).find((program) => program.id === node.id)?.name ?? "";
  };

  /** Write `ids` for the node's list; a list equal to the current one is taken without a PUT (nothing to save, nothing to say). */
  const commit = (node: OrderNode, ids: number[]): boolean => {
    const list = view && listOf(view, node);
    if (!view || !list || ids.length === 0) return false;
    if (sameIds(ids, fullIds(view, list))) return true;
    if (busy) {
      setRefused(true);
      announce(t("project.busy"));
      return false;
    }
    void queryClient.cancelQueries({ queryKey: ["plan"] });
    const next = applyOrder(view, list, ids);
    queryClient.setQueryData<PlanView>(planViewKey, next);
    // Its place among the siblings it moved among, after the move.
    const siblings = new Set(siblingIds(next, node));
    const among = fullIds(next, list).filter((id) => siblings.has(id));
    announce(t("plan.order.announceMoved", { name: nameOf(node), position: among.indexOf(node.id) + 1, count: among.length }));
    writes.current += 1;
    save.mutate({ list, ids, expectedRevision: orderRevision(view, list), before: view });
    return true;
  };

  return {
    /** A write is in flight. */
    pending: busy,
    /** A change was refused while a write was running (the page shows the "try again" note). */
    refused,
    stale: save.isError && listChanged(save.error),
    error: save.isError && !listChanged(save.error) ? saveErrorMessage(save.error, t, SAVE_ERROR_KEYS) : null,
    /** How many failed saves have restored the view and settled the reload so far (rises once per failure): the page's cue to return the focus. */
    rollbacks,
    /** How many PUTs this hook has sent: a change that is "taken" without one (nothing to save) leaves it as it was. */
    writeCount: () => writes.current,
    /** Menu path: one place up (-1) or down (+1) among the siblings. Answers whether the change was taken. */
    move: (node: OrderNode, delta: -1 | 1) => (view ? commit(node, steppedIds(view, node, delta)) : false),
    /** Row drag: drop the node into the gap `slot` among its siblings (0 = before the first). Answers whether the change was taken. */
    dropAt: (node: OrderNode, slot: number) => (view ? commit(node, droppedIds(view, node, slot)) : false),
  };
}
