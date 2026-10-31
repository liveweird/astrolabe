import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { getRoadmapView, isStaleRevision, putRanking, type RoadmapView } from "../api/roadmap";
import { appendId, applyRanking, moveBy, moveOver, removeId } from "../utils/roadmapOrder";
import { refreshQueriesAfterMutation } from "../utils/queryRefresh";
import { saveErrorMessage } from "../utils/saveError";

const VIEW_KEY = ["roadmap", "view"] as const;

const SAVE_ERROR_KEYS = {
  forbidden: "roadmap.saveForbidden",
  invalid: "roadmap.saveInvalid",
  failedStatus: "common.error.actionFailedStatus",
  failed: "common.error.actionFailed",
} as const;

type SaveVariables = { ids: number[]; expectedRevision: number; before: RoadmapView };

/**
 * The Roadmap page's data and its one write path. Every change (Move up/down, a drag, Rank, Unrank) becomes the complete new
 * id list and goes out as the wholesale `PUT /roadmap/ranking` with the `expectedRevision` of the view on screen:
 *  - the list is reordered optimistically in the cached view, at once;
 *  - success stores the new revision in the cache, then refreshes `["roadmap"]` in the background;
 *  - a stale-revision 409 rolls the list back, says so (`stale`) and refreshes — the refetched view is the truth;
 *  - any other failure rolls back and surfaces through `error` (already mapped to words).
 * While a save (the PUT, and after a failure the rollback reload) runs, further changes are ignored (`pending`): the next one needs the
 * revision this one returns.
 * `announcement` is the live-region sentence for the last button-driven change (a drag is announced by dnd-kit itself).
 */
export function useRoadmapRanking() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const query = useQuery({ queryKey: VIEW_KEY, queryFn: getRoadmapView });
  const view = query.data;
  const [announcement, setAnnouncement] = useState("");

  const save = useMutation({
    mutationFn: ({ ids, expectedRevision }: SaveVariables) => putRanking({ projectIds: ids, expectedRevision }),
    onSuccess: ({ revision }) => {
      queryClient.setQueryData<RoadmapView>(VIEW_KEY, (current) => current && { ...current, revision });
      // Not awaited: the save is over, so the next change (a held Enter on Move up) may go at once; its `commit` cancels this refetch.
      void refreshQueriesAfterMutation(queryClient, ["roadmap"]);
    },
    onError: async (_err, { before }) => {
      queryClient.setQueryData<RoadmapView>(VIEW_KEY, before);
      await refreshQueriesAfterMutation(queryClient, ["roadmap"]);
    },
  });

  const rankedIds = view?.ranked.map((entry) => entry.project.id) ?? [];

  const commit = (ids: number[], announce?: (positionOf: (id: number) => number) => string): boolean => {
    if (!view || save.isPending) return false;
    void queryClient.cancelQueries({ queryKey: VIEW_KEY });
    queryClient.setQueryData<RoadmapView>(VIEW_KEY, applyRanking(view, ids));
    if (announce) setAnnouncement(announce((id) => ids.indexOf(id) + 1));
    save.mutate({ ids, expectedRevision: view.revision, before: view });
    return true;
  };

  const nameOf = (id: number) => (view ? [...view.ranked.map((e) => e.project), ...view.unranked].find((p) => p.id === id)?.name ?? "" : "");

  return {
    view,
    query,
    pending: save.isPending,
    stale: isStaleRevision(save.error),
    error: save.isError && !isStaleRevision(save.error) ? saveErrorMessage(save.error, t, SAVE_ERROR_KEYS) : null,
    announcement,
    /** Button path: move one place up (-1) or down (+1). Answers whether the change was taken. */
    move: (id: number, delta: -1 | 1) => {
      const ids = moveBy(rankedIds, id, delta);
      return commit(ids, (positionOf) => t("roadmap.announce.moved", { name: nameOf(id), position: positionOf(id), count: ids.length }));
    },
    /** Drag path: the dragged row takes the place of the row it was dropped on. */
    dropOver: (id: number, overId: number) => commit(moveOver(rankedIds, id, overId)),
    rank: (id: number) => {
      const ids = appendId(rankedIds, id);
      commit(ids, (positionOf) => t("roadmap.announce.ranked", { name: nameOf(id), position: positionOf(id), count: ids.length }));
    },
    unrank: (id: number) =>
      commit(removeId(rankedIds, id), () => t("roadmap.announce.unranked", { name: nameOf(id) })),
  };
}
