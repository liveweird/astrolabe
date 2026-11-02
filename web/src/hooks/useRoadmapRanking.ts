import { useState } from "react";
import { keepPreviousData, useIsMutating, useMutation, useQuery, useQueryClient, type QueryKey } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { getRoadmapView, isStaleRevision, putRanking, roadmapViewKey, type RoadmapView } from "../api/roadmap";
import { allProjects } from "../utils/roadmapRows";
import { appendId, applyRanking, moveAmongVisible, rankingAfterDrop, removeId, sameIds } from "../utils/roadmapOrder";
import { refreshQueriesAfterMutation } from "../utils/queryRefresh";
import { saveErrorMessage } from "../utils/saveError";
import { withoutStaleOverlay } from "./useBaselinePick";
import { useRefusal } from "./useRefusal";

/**
 * Every write on the cached roadmap and programs views carries this mutation key - the ranking PUT here and the target-window PUT of
 * `useTargetWindow` - so two optimistic writes see each other in flight and the second is refused (out loud) instead of rolling the first back.
 */
export const ROADMAP_WRITE_KEY = ["roadmap", "write"] as const;

/** Every pick's entry of the roadmap view (the key without the baseline pick). */
const ROADMAP_VIEW_ENTRIES = ["roadmap", "view"] as const;

/** Zero-width space: toggled on the live-region text so the same sentence twice is announced twice. */
const REREAD = "​";

const SAVE_ERROR_KEYS = {
  forbidden: "roadmap.saveForbidden",
  invalid: "roadmap.saveInvalid",
  failedStatus: "common.error.actionFailedStatus",
  failed: "common.error.actionFailed",
} as const;

/** `key` is the cache entry the change was made on (the pick it was made under): the rollback goes back there. */
type SaveVariables = { ids: number[]; expectedRevision: number; before: RoadmapView; key: QueryKey };

/**
 * The Roadmap page's data and its one write path. Every change (a row-menu move, a row drag, Rank, Unrank) becomes the complete new id list and
 * goes out as the wholesale `PUT /roadmap/ranking` with the `expectedRevision` of the view on screen:
 *  - the list is reordered optimistically in the cached view, at once (`applyRanking`);
 *  - success stores the new revision in the cache, then refreshes `["roadmap"]` in the background;
 *  - a stale-revision 409 rolls the list back, says so (`stale`) and refreshes — the refetched view is the truth;
 *  - any other failure rolls back and surfaces through `error` (already mapped to words).
 * A change made while a write is in flight (the PUT, and after a failure the rollback reload; every write on this view shares one mutation key) is
 * REFUSED out loud: `commit` answers `false`, `refused` is set (the page's visible note) and `project.busy` is announced — never silently ignored.
 * Every entry point answers whether the change was TAKEN. The moves take the ids of the VISIBLE ranked rows (`visible`: a filter hides some of the
 * ranking) and put the row among them (`moveAmongVisible`); a change that leaves the list as it is (a drop beside the row itself) is taken
 * without a PUT. `announcement` is the live-region sentence for the last non-drag change (a drag is announced by dnd-kit itself, and only by it).
 */
export function useRoadmapRanking(baseline: number | null) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  // The key carries the baseline pick (v0.9): the ranking's optimistic step, its rollback and the window path all hit the entry the page shows.
  // `keepPreviousData` keeps the page mounted while another pick loads; the old pick's overlay is dropped from that copy.
  const viewKey = roadmapViewKey(baseline);
  const query = useQuery({ queryKey: viewKey, queryFn: () => getRoadmapView(baseline), placeholderData: keepPreviousData });
  const view = withoutStaleOverlay(query.data, query.isPlaceholderData);
  const [announcement, setAnnouncement] = useState("");
  /** An identical sentence said twice would not be re-read: every announcement flips an invisible suffix. */
  const announce = (text: string) => setAnnouncement((previous) => (previous.endsWith(REREAD) ? text : text + REREAD));

  const save = useMutation({
    mutationKey: ROADMAP_WRITE_KEY,
    mutationFn: ({ ids, expectedRevision }: SaveVariables) => putRanking({ projectIds: ids, expectedRevision }),
    onSuccess: ({ revision }) => {
      // The ranking's revision into every pick's entry (the page may show another pick's by now): none keeps the old one for the next write.
      queryClient.setQueriesData<RoadmapView>({ queryKey: ROADMAP_VIEW_ENTRIES }, (current) => current && { ...current, revision });
      // Not awaited: the save is over, so the next change may go at once; its `commit` cancels this refetch.
      void refreshQueriesAfterMutation(queryClient, ["roadmap"]);
    },
    onError: async (_err, { before, key }) => {
      queryClient.setQueryData<RoadmapView>(key, before);
      await refreshQueriesAfterMutation(queryClient, ["roadmap"]);
    },
  });
  const busy = useIsMutating({ mutationKey: ROADMAP_WRITE_KEY }) > 0;
  // A change refused because a write was still running: shown and announced until no write is in flight.
  // The shown copy belongs to the previous pick while the new one loads: nothing is written from it either.
  const placeholder = query.isPlaceholderData;
  const [refused, setRefused] = useRefusal(busy || placeholder);

  const rankedIds = view?.ranked.map((entry) => entry.project.id) ?? [];
  const nameOf = (id: number) => (view ? allProjects(view).find((project) => project.id === id)?.name ?? "" : "");

  /** Write `ids`; a list equal to the current one is taken without a PUT (nothing to save, nothing to say). */
  const commit = (ids: number[], sentence?: () => string): boolean => {
    if (!view) return false;
    if (sameIds(ids, rankedIds)) return true;
    if (busy || placeholder) {
      setRefused(true);
      announce(t("project.busy"));
      return false;
    }
    void queryClient.cancelQueries({ queryKey: viewKey });
    queryClient.setQueryData<RoadmapView>(viewKey, applyRanking(view, ids));
    if (sentence) announce(sentence());
    save.mutate({ ids, expectedRevision: view.revision, before: view, key: viewKey });
    return true;
  };

  const movedSentence = (id: number, ids: number[]) => () => t("roadmap.announce.moved", { name: nameOf(id), position: ids.indexOf(id) + 1, count: ids.length });
  const rankedSentence = (id: number, ids: number[]) => () => t("roadmap.announce.ranked", { name: nameOf(id), position: ids.indexOf(id) + 1, count: ids.length });
  const unrankedSentence = (id: number) => () => t("roadmap.announce.unranked", { name: nameOf(id) });

  /** Move a ranked row to the gap `slot` among the visible ranked rows. */
  const place = (id: number, visible: readonly number[], slot: number): boolean => {
    const ids = moveAmongVisible(rankedIds, visible, id, slot);
    return commit(ids, movedSentence(id, ids));
  };

  return {
    view,
    query,
    pending: busy,
    /** The shown view is the previous pick's copy while the new pick loads: every write (this one's and the window's) is refused until it arrives. */
    placeholder,
    /** A change was refused while a write was running (the page shows the "try again" note). */
    refused,
    stale: isStaleRevision(save.error),
    error: save.isError && !isStaleRevision(save.error) ? saveErrorMessage(save.error, t, SAVE_ERROR_KEYS) : null,
    announcement,
    /** Say a sentence in the page's live region (the window write path shares it, so the page has ONE announcer). */
    announce,
    /** Menu path: move one place up (-1) or down (+1) among the VISIBLE ranked rows. Answers whether the change was taken. */
    move: (id: number, delta: -1 | 1, visible: readonly number[]) => {
      const from = visible.indexOf(id);
      return from >= 0 && place(id, visible, delta < 0 ? from - 1 : from + 2);
    },
    /** Menu path: to the top or the bottom of the visible ranked rows. */
    moveTo: (id: number, edge: "top" | "bottom", visible: readonly number[]) => visible.includes(id) && place(id, visible, edge === "top" ? 0 : visible.length),
    /**
     * Row drag: `id` was dropped into the gap `slot` of the DISPLAYED rows (the visible ranked rows, the divider, the unranked rows). Within the ranked
     * block it moves there; an unranked row dropped above the divider is RANKED at that slot, a ranked row dropped below it is UNRANKED. A drop that
     * changes nothing is taken without a PUT. A drag is not said here (dnd-kit's region announces the drop).
     */
    dropAt: (id: number, slot: number, visibleRanked: readonly number[]): boolean => {
      const ids = rankingAfterDrop(rankedIds, visibleRanked, id, slot);
      return commit(ids);
    },
    /** Rank an unranked project: it goes at the END of the ranking (the v0.2 rule). */
    rank: (id: number) => {
      const ids = appendId(rankedIds, id);
      return commit(ids, rankedSentence(id, ids));
    },
    unrank: (id: number) => commit(removeId(rankedIds, id), unrankedSentence(id)),
  };
}
