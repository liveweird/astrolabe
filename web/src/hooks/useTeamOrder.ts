import { useIsMutating, useMutation, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { ApiError } from "../api/http";
import { isStaleRevision } from "../api/roadmap";
import { putTeamOrder, type TeamView } from "../api/teams";
import { moveBy, moveToEdge } from "../utils/roadmapOrder";
import { refreshQueriesAfterMutation } from "../utils/queryRefresh";
import { saveErrorMessage } from "../utils/saveError";
import { applyTeamOrder } from "../utils/teamViewUpdate";
import { useRefusal } from "./useRefusal";
import { teamViewKey, teamWriteKey } from "./useTeamSchedule";

const SAVE_ERROR_KEYS = {
  forbidden: "teams.view.orderForbidden",
  failedStatus: "common.error.actionFailedStatus",
  failed: "common.error.actionFailed",
} as const;

type SaveVariables = { ids: number[]; expectedRevision: number; before: TeamView };

/**
 * A refusal that means "the list changed under you": the stale-revision 409, and the 400 the order PUT answers when a listed milestone
 * was deleted or moved to another team meanwhile (a removal does not bump the team's order revision, by design).
 */
const listChanged = (error: unknown) => isStaleRevision(error) || (error instanceof ApiError && error.status === 400);

/**
 * The team page's order write path (the `useRoadmapRanking` shape): every change — Move up / down / to top / to bottom, Reset — becomes
 * the complete new id list of the SCHEDULED rows and goes out as the wholesale `PUT /teams/{id}/milestone-order` with the TEAM's order
 * revision (`view.order.revision`, never the view's plan `revision`):
 *  - the rows are reordered optimistically in the cached view, at once;
 *  - success stores the revision the PUT answers into `order.revision` (and nowhere else), then refreshes `["plan"]` in the background;
 *  - a stale 409 or a 400 (a listed milestone left the team) rolls back, says so (`stale`) and AWAITS the refetch;
 *  - any other failure rolls back and surfaces through `error` (already mapped to words).
 * A change made while any write of this page (this one or a schedule PUT, which share `teamWriteKey`) is in flight is REFUSED out loud:
 * `commit` answers `false`, `refused` is set (the page's visible note) and `project.busy` is announced. A taken change is announced
 * through the page's one live region (`announce`). `move`, `moveTo` and `reset` answer whether the change was taken. A drag (C5b) will
 * feed the same `commit`.
 */
export function useTeamOrder(teamId: number, view: TeamView | undefined, announce: (text: string) => void) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const key = teamViewKey(teamId);

  const save = useMutation({
    mutationKey: teamWriteKey(teamId),
    mutationFn: ({ ids, expectedRevision }: SaveVariables) => putTeamOrder(teamId, { milestoneIds: ids, expectedRevision }),
    onSuccess: ({ revision }) => {
      queryClient.setQueryData<TeamView>(key, (current) => current && { ...current, order: { ...current.order, revision } });
      // Not awaited: the save is over, so the next change may go at once; its `commit` cancels this refetch.
      void refreshQueriesAfterMutation(queryClient, ["plan"]);
    },
    onError: async (err, { before }) => {
      queryClient.setQueryData<TeamView>(key, before);
      // The page shows the visible note; the live region says it too (a screen-reader user otherwise sees the list jump back unannounced).
      if (listChanged(err)) announce(t("teams.view.orderStale"));
      await refreshQueriesAfterMutation(queryClient, ["plan"]);
    },
  });
  const busy = useIsMutating({ mutationKey: teamWriteKey(teamId) }) > 0;
  // A change refused because a write (this one or a schedule save) was still running: shown and announced until no write is in flight.
  const [refused, setRefused] = useRefusal(busy);

  const scheduledIds = view?.scheduled.map((milestone) => milestone.id) ?? [];
  const nameOf = (id: number) => view?.scheduled.find((milestone) => milestone.id === id)?.name ?? "";

  const commit = (ids: number[], sentence?: (positionOf: (id: number) => number) => string): boolean => {
    if (!view) return false;
    if (busy) {
      setRefused(true);
      announce(t("project.busy"));
      return false;
    }
    void queryClient.cancelQueries({ queryKey: ["plan"] });
    queryClient.setQueryData<TeamView>(key, applyTeamOrder(view, ids));
    if (sentence) announce(sentence((id) => ids.indexOf(id) + 1));
    save.mutate({ ids, expectedRevision: view.order.revision, before: view });
    return true;
  };

  const placed = (id: number, ids: number[]) =>
    commit(ids, (positionOf) => t("teams.view.announce.moved", { name: nameOf(id), position: positionOf(id), count: ids.length }));

  return {
    pending: busy,
    /** A change was refused while a write was running (the page shows the "try again" note; Reset keeps its dialog open). */
    refused,
    stale: save.isError && listChanged(save.error),
    error: save.isError && !listChanged(save.error) ? saveErrorMessage(save.error, t, SAVE_ERROR_KEYS) : null,
    /** Button path: move one place up (-1) or down (+1). Answers whether the change was taken. */
    move: (id: number, delta: -1 | 1) => placed(id, moveBy(scheduledIds, id, delta)),
    moveTo: (id: number, edge: "top" | "bottom") => placed(id, moveToEdge(scheduledIds, id, edge)),
    /** Back to the project rank's order: the empty list. Answers whether the reset was taken. */
    reset: () => commit([], () => t("teams.view.announce.reset")),
  };
}
