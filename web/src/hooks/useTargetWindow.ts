import { useState } from "react";
import { useIsMutating, useMutation, useQueryClient, type QueryKey } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { setProjectTargetWindow } from "../api/plan";
import { refreshQueriesAfterMutation } from "../utils/queryRefresh";
import { saveErrorMessage } from "../utils/saveError";
import { ROADMAP_WRITE_KEY } from "./useRoadmapRanking";
import { useRefusal } from "./useRefusal";

const SAVE_ERROR_KEYS = {
  forbidden: "roadmap.window.forbidden",
  notFound: "roadmap.window.gone",
  invalid: "roadmap.window.invalid",
  failedStatus: "common.error.saveFailedStatus",
  failed: "common.error.saveFailedNetwork",
} as const;

type SaveVariables<V> = { id: number; start: string | null; end: string | null; before: V };

/**
 * The ONE target-window write path of the two plan pages (the roadmap and the programs tree), generic over the page's cached view - the
 * `useScheduleWritePath` / `useRoadmapRanking` shape. A change - a band moved or resized, a window drawn, the dialog's Save, Clear - is a
 * `PUT /projects/{id}/target-window` (204, no revision: the window has none):
 *  - the project's window changes in the cached view at once (`apply`, which also drops the figures the window decides - drift, drift flags);
 *  - success refreshes `["roadmap"]` (both views) and `["plan"]` (a mounted project view's band, the Plan page) in the background, so the
 *    refetched figures - the drift band, the flags - are the server's; the other plan page, not mounted, is invalidated by the same refresh;
 *  - any failure rolls the cached view back, AWAITS the refetch and surfaces through `error` (403 / 404 / 400 mapped to words).
 * It shares `ROADMAP_WRITE_KEY` with the ranking PUT: a window change made while a rank save runs - or the other way round - is REFUSED out loud
 * (`commit` answers `false`, `refused` is set for the page's "try again" note and `project.busy` is announced). `announce` is the page's one
 * polite live region; a dragged or drawn window is announced by dnd-kit itself, so only the dialog and the menu ask for `announce: true`.
 */
export function useTargetWindow<V>({
  view,
  queryKey,
  apply,
  nameOf,
  announce,
}: {
  /** The page's cached view, or `undefined` while it loads. */
  view: V | undefined;
  queryKey: QueryKey;
  /** The optimistic step: the view with one project's window replaced (a null pair clears it). */
  apply: (view: V, id: number, start: string | null, end: string | null) => V;
  /** The project's name in the view, or `undefined` when the project is not in it. */
  nameOf: (view: V, id: number) => string | undefined;
  announce: (text: string) => void;
}) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  // A change aimed at a project that has left the view (deleted, moved out of the pick, refetched away): shown until the next taken change.
  const [gone, setGone] = useState(false);

  const save = useMutation({
    mutationKey: ROADMAP_WRITE_KEY,
    mutationFn: ({ id, start, end }: SaveVariables<V>) => setProjectTargetWindow(id, { targetStart: start, targetEnd: end }),
    onSuccess: () => {
      // Not awaited: the save is over, so the next change may go at once; its `commit` cancels this refetch.
      void refreshQueriesAfterMutation(queryClient, ["roadmap"], ["plan"]);
    },
    onError: async (_err, { before }) => {
      queryClient.setQueryData<V>(queryKey, before);
      await refreshQueriesAfterMutation(queryClient, ["roadmap"], ["plan"]);
    },
  });
  const busy = useIsMutating({ mutationKey: ROADMAP_WRITE_KEY }) > 0;
  // A change refused because a write was still running: shown (and announced) until THAT write - the ranking's or this one - is over.
  const [refused, setRefused] = useRefusal(busy);

  /**
   * Propose a window (both dates, or both null to clear it). Answers whether the change was TAKEN: `false` when the project is not in the view
   * (`gone`) or while a write is in flight (`refused`) - then the page shows and announces that nothing changed, so a drop is never lost
   * silently. `announce` says a taken change in the live region (the dialog, the menu; a drag says itself); `ownRefusalAlert` is for the dialog,
   * which shows the refusal in an alert of its own (its content is all a screen reader reads while it is open).
   */
  const commit = (id: number, start: string | null, end: string | null, options: { announce?: boolean; ownRefusalAlert?: boolean } = {}): boolean => {
    if (view === undefined) return false;
    const name = nameOf(view, id);
    if (name === undefined) {
      setGone(true);
      announce(t("roadmap.window.gone"));
      return false;
    }
    if (busy) {
      setRefused(true);
      if (!options.ownRefusalAlert) announce(t("project.busy"));
      return false;
    }
    setGone(false);
    // The optimistic write must not be overwritten by a read of this view that began before it (the previous save's background refresh).
    void queryClient.cancelQueries({ queryKey });
    queryClient.setQueryData<V>(queryKey, apply(view, id, start, end));
    if (options.announce) announce(start === null || end === null ? t("roadmap.announce.windowCleared", { name }) : t("roadmap.announce.windowSet", { name, start, end }));
    save.mutate({ id, start, end, before: view });
    return true;
  };

  return {
    commit,
    /** A write is in flight (this one or the ranking's): `aria-busy` and the "Saving…" indicator. */
    pending: busy,
    /** A change was refused while a write was running; clears when none is in flight any more. */
    refused,
    /** A change aimed at a project that is no longer in the view; clears with the next taken change. */
    gone,
    error: save.isError ? saveErrorMessage(save.error, t, SAVE_ERROR_KEYS) : null,
  };
}
