import { useIsMutating, useMutation, useQueryClient, type QueryKey } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { ApiError } from "../api/http";
import { isStaleRevision } from "../api/roadmap";
import { putTeamOrder, type TeamView } from "../api/teams";
import { moveBy, moveToEdge, moveToSlot } from "../utils/roadmapOrder";
import { refreshQueriesAfterMutation } from "../utils/queryRefresh";
import { saveErrorMessage } from "../utils/saveError";
import { placeScheduled } from "../utils/teamOrderList";
import { applyTeamOrder } from "../utils/teamViewUpdate";
import { useRefusal } from "./useRefusal";
import { teamViewKey, teamWriteKey } from "./useTeamSchedule";

const SAVE_ERROR_KEYS = {
  forbidden: "teams.view.orderForbidden",
  failedStatus: "common.error.actionFailedStatus",
  failed: "common.error.actionFailed",
} as const;

/** `key` is the entry the change was made on: the rollback goes back there. */
type SaveVariables = { ids: number[]; expectedRevision: number; before: TeamView; key: QueryKey };

/**
 * A refusal that means "the list changed under you": the stale-revision 409, and the 400 the order PUT answers when a listed milestone
 * was deleted or moved to another team meanwhile (a removal does not bump the team's order revision, by design).
 */
const listChanged = (error: unknown) => isStaleRevision(error) || (error instanceof ApiError && error.status === 400);

/**
 * The team page's order write path (the `useRoadmapRanking` shape): every change — Move up / down / to top / to bottom, a row drag, Reset —
 * becomes the complete new id list and goes out as the wholesale `PUT /teams/{id}/milestone-order` with the TEAM's order revision
 * (`view.order.revision`, never the view's plan `revision`). A reorder is a permutation of the displayed SCHEDULED ids, `placed(id,
 * permutation)`; `placeScheduled` (`utils/teamOrderList.ts`) turns it into the full list, so a listed milestone that is now unscheduled
 * keeps its stored place (a manager's order is never reshuffled; Reset sends `[]`):
 *  - the rows are reordered optimistically in the cached view, at once;
 *  - success stores the revision the PUT answers into `order.revision` of the entry the change was made on (and nowhere else), then refreshes `["plan"]` in the background;
 *  - a stale 409 or a 400 (a listed milestone left the team) rolls back, says so (`stale`) and AWAITS the refetch;
 *  - any other failure rolls back and surfaces through `error` (already mapped to words).
 * A change made while any write of this page (this one or a schedule PUT, which share `teamWriteKey`) is in flight is REFUSED out loud:
 * `commit` answers `false`, `refused` is set (the page's visible note) and `project.busy` is announced. A taken change is announced
 * through the page's one live region (`announce`). `loading` is the page's "the shown view is the previous baseline pick's copy" (`placeholder` of
 * the schedule path): nothing is written from it, a change is refused like one made during a save; a success stores the order revision into
 * the written entry only (a sibling pick's entry still holds the old order). `move`, `moveTo`, `placed` and `reset` answer whether the change was taken.
 */
export function useTeamOrder(teamId: number, view: TeamView | undefined, announce: (text: string) => void, baseline: number | null, loading: boolean) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const key = teamViewKey(teamId, baseline);

  const save = useMutation({
    mutationKey: teamWriteKey(teamId),
    mutationFn: ({ ids, expectedRevision }: SaveVariables) => putTeamOrder(teamId, { milestoneIds: ids, expectedRevision }),
    onSuccess: ({ revision }, { key: madeOn }) => {
      // The new order revision into the entry the change was made on - the one holding the new order - and into no other: a sibling entry (another
      // pick visited earlier) still holds the OLD order, so it keeps the old revision and a reorder made from it before its refetch lands is a
      // stale 409, not a silent revert of this one.
      queryClient.setQueryData<TeamView>(madeOn, (current) => current && { ...current, order: { ...current.order, revision } });
      // Not awaited: the save is over, so the next change may go at once; its `commit` cancels this refetch.
      void refreshQueriesAfterMutation(queryClient, ["plan"]);
    },
    onError: async (err, { before, key: madeOn }) => {
      queryClient.setQueryData<TeamView>(madeOn, before);
      // The page shows the visible note; the live region says it too (a screen-reader user otherwise sees the list jump back unannounced).
      if (listChanged(err)) announce(t("teams.view.orderStale"));
      await refreshQueriesAfterMutation(queryClient, ["plan"]);
    },
  });
  const busy = useIsMutating({ mutationKey: teamWriteKey(teamId) }) > 0;
  // A change refused because a write (this one or a schedule save) was still running: shown and announced until no write is in flight.
  const [refused, setRefused] = useRefusal(busy || loading);

  const scheduledIds = view?.scheduled.map((milestone) => milestone.id) ?? [];
  const nameOf = (id: number) => view?.scheduled.find((milestone) => milestone.id === id)?.name ?? "";

  const commit = (ids: number[], sentence?: () => string): boolean => {
    if (!view) return false;
    if (busy || loading) {
      setRefused(true);
      announce(t("project.busy"));
      return false;
    }
    void queryClient.cancelQueries({ queryKey: ["plan"] });
    queryClient.setQueryData<TeamView>(key, applyTeamOrder(view, ids));
    if (sentence) announce(sentence());
    save.mutate({ ids, expectedRevision: view.order.revision, before: view, key });
    return true;
  };

  /** The ONE reorder seam: `id` was put into the displayed scheduled order [permutation]. Answers whether the change was taken. */
  const placed = (id: number, permutation: number[], announced = true): boolean => {
    const ids = view && placeScheduled(view, permutation);
    // Not a permutation of the displayed rows (a caller bug): nothing is written or announced.
    if (!ids) return false;
    // The order the page shows already is this one (a drop beside the row itself): taken, and nothing to save or announce.
    if (permutation.every((scheduledId, index) => scheduledId === scheduledIds[index])) return true;
    // A drag passes `announced = false`: dnd-kit's live region already says where it was dropped (the single announcer of a drag).
    const sentence = () =>
      t("teams.view.announce.moved", { name: nameOf(id), position: permutation.indexOf(id) + 1, count: permutation.length });
    return commit(ids, announced ? sentence : undefined);
  };

  return {
    pending: busy,
    /** A change was refused while a write was running (the page shows the "try again" note; Reset keeps its dialog open). */
    refused,
    stale: save.isError && listChanged(save.error),
    error: save.isError && !listChanged(save.error) ? saveErrorMessage(save.error, t, SAVE_ERROR_KEYS) : null,
    placed,
    /** Button path: move one place up (-1) or down (+1). Answers whether the change was taken. */
    move: (id: number, delta: -1 | 1) => placed(id, moveBy(scheduledIds, id, delta)),
    moveTo: (id: number, edge: "top" | "bottom") => placed(id, moveToEdge(scheduledIds, id, edge)),
    /** Row drag: drop `id` into the gap `slot` (0 = above the first row). Answers whether the change was taken. */
    dropAt: (id: number, slot: number) => placed(id, moveToSlot(scheduledIds, id, slot), false),
    /** Back to the project rank's order: the empty list. Answers whether the reset was taken. */
    reset: () => commit([], () => t("teams.view.announce.reset")),
  };
}
