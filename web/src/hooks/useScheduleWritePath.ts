import { useState } from "react";
import { useIsMutating, useMutation, useQuery, useQueryClient, type QueryKey } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { scheduleMilestone } from "../api/milestones";
import { isStaleRevision } from "../api/roadmap";
import { useRefusal } from "./useRefusal";
import { refreshQueriesAfterMutation } from "../utils/queryRefresh";
import { saveErrorMessage } from "../utils/saveError";

/** Zero-width space: toggled on the live-region text so the same sentence twice is announced twice. */
const REREAD = "​";

const SAVE_ERROR_KEYS = {
  forbidden: "project.scheduleForbidden",
  notFound: "project.saveGone",
  invalid: "project.scheduleInvalid",
  failedStatus: "common.error.saveFailedStatus",
  failed: "common.error.saveFailedNetwork",
} as const;

/** What the write path needs of a timeline page's view: the plan revision and the two milestone lists. */
export type ScheduleView = {
  revision: number;
  scheduled: { id: number; name: string }[];
  unscheduled: { id: number; name: string }[];
};

type SaveVariables<V> = { id: number; start: string | null; end: string | null; expectedRevision: number; before: V };

/**
 * The ONE schedule write path of a timeline page (the `useRoadmapRanking` shape), generic over the page's view document — the project
 * view and the team view both run it (`useMilestoneSchedule`, `useTeamSchedule`). A change — a drag, a resize, the Schedule button, the
 * schedule dialog, Unschedule — is a `PUT /milestones/{id}/schedule` with the `expectedRevision` (the plan revision) of the view on screen:
 *  - the milestone moves in the cached view at once (`apply`);
 *  - success stores the plan revision the PUT answers (the next change needs it), then refreshes `["plan"]` in the background — the
 *    refetched view carries the server's derived figures (span and drift; the weekly load);
 *  - a stale-revision 409 (THIS milestone moved after the view was read) rolls back, says so (`stale`) and AWAITS the refetch, which
 *    is the truth; any other failure rolls back, awaits the refetch and surfaces through `error` (already mapped to words).
 * While a save (the PUT, and after a failure the rollback reload) runs, further changes are ignored (`pending`) — and so are they while
 * ANY other write sharing `writeKey` runs (the team page's order PUT): two optimistic writes on one cached view would roll each other back.
 * `announcement` is the live-region sentence for the last non-drag change (a drag is announced by dnd-kit itself).
 */
export function useScheduleWritePath<V extends ScheduleView>({
  queryKey,
  queryFn,
  apply,
  enabled,
  writeKey,
}: {
  queryKey: QueryKey;
  queryFn: () => Promise<V>;
  /** The optimistic step: the view with one milestone's dates replaced (a null pair unschedules). */
  apply: (view: V, id: number, start: string | null, end: string | null) => V;
  enabled: boolean;
  /** The mutation key every write on this cached view carries, so they see each other in flight. */
  writeKey: QueryKey;
}) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const query = useQuery({ queryKey, queryFn, enabled });
  const view = query.data;
  const [announcement, setAnnouncement] = useState("");
  // A change aimed at a milestone that is no longer in the view (deleted, then refetched away): shown (and announced) until the next taken change.
  const [gone, setGone] = useState(false);
  /** An identical sentence said twice would not be re-read: every announcement flips an invisible suffix. */
  const announce = (text: string) => setAnnouncement((previous) => (previous.endsWith(REREAD) ? text : text + REREAD));

  const save = useMutation({
    mutationKey: writeKey,
    mutationFn: ({ id, start, end, expectedRevision }: SaveVariables<V>) => scheduleMilestone(id, { expectedRevision, startDate: start, endDate: end }),
    onSuccess: ({ revision }) => {
      queryClient.setQueryData<V>(queryKey, (current) => current && { ...current, revision });
      // Not awaited: the save is over, so the next change may go at once; its `commit` cancels this refetch.
      void refreshQueriesAfterMutation(queryClient, ["plan"]);
    },
    onError: async (_err, { before }) => {
      queryClient.setQueryData<V>(queryKey, before);
      await refreshQueriesAfterMutation(queryClient, ["plan"]);
    },
  });
  const writing = useIsMutating({ mutationKey: writeKey }) > 0;
  const busy = save.isPending || writing;
  // A change refused because a save was still running: shown (and announced) until THAT save — whichever write it was — is over.
  const [refused, setRefused] = useRefusal(busy);

  const has = (id: number) => [...(view?.scheduled ?? []), ...(view?.unscheduled ?? [])].some((m) => m.id === id);
  const nameOf = (id: number) => [...(view?.scheduled ?? []), ...(view?.unscheduled ?? [])].find((m) => m.id === id)?.name ?? "";

  /**
   * Propose new dates (both, or both null to unschedule). Answers whether the change was taken: `false` when the milestone is not in
   * the view (`gone`), or while a save is in flight (`refused`) — then the page shows and announces that the change was NOT made, so
   * a drop is never silently lost. `announce` says a taken change in the live region (the non-drag paths); `ownRefusalAlert` is for a
   * caller that shows the refusal itself in a live alert of its own (the schedule dialog, whose content is all a screen reader
   * reads while it is open), so the refusal is not also said in the page's status region; `revision` is the plan revision the
   * caller's own view was read at when that is older than the cache's (the schedule dialog, opened a while ago): it is what the PUT
   * carries, so another manager's move of THIS milestone meanwhile is a stale 409, not an overwrite.
   */
  const commit = (
    id: number,
    start: string | null,
    end: string | null,
    options: { announce?: boolean; revision?: number; ownRefusalAlert?: boolean } = {},
  ): boolean => {
    if (!view) return false;
    if (!has(id)) {
      setGone(true);
      announce(t("project.milestoneGone"));
      return false;
    }
    if (busy) {
      setRefused(true);
      if (!options.ownRefusalAlert) announce(t("project.busy"));
      return false;
    }
    setGone(false);
    // Every `["plan"]` fetch, not just this view: the optimistic write must not be overwritten by a read that began before it.
    void queryClient.cancelQueries({ queryKey: ["plan"] });
    queryClient.setQueryData<V>(queryKey, apply(view, id, start, end));
    if (options.announce) {
      const name = nameOf(id);
      announce(start === null || end === null ? t("project.announce.unscheduled", { name }) : t("project.announce.scheduled", { name, start, end }));
    }
    save.mutate({ id, start, end, expectedRevision: options.revision ?? view.revision, before: view });
    return true;
  };

  return {
    view,
    query,
    pending: busy,
    stale: isStaleRevision(save.error),
    error: save.isError && !isStaleRevision(save.error) ? saveErrorMessage(save.error, t, SAVE_ERROR_KEYS) : null,
    announcement,
    /** Say a sentence in the page's live region (the order path shares it, so the page has ONE announcer). */
    announce,
    /** A change was refused while a save was running; clears when no write is in flight any more. */
    refused,
    /** A change aimed at a milestone that is no longer in the view; clears with the next taken change. */
    gone,
    /** Whether the milestone is in the view now (a dialog opened on it closes when it is not). */
    has,
    commit,
  };
}
