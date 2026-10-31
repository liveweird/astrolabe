import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { getProjectView, scheduleMilestone, type ProjectView } from "../api/milestones";
import { isStaleRevision } from "../api/roadmap";
import { applySchedule } from "../utils/projectViewUpdate";
import { refreshQueriesAfterMutation } from "../utils/queryRefresh";
import { saveErrorMessage } from "../utils/saveError";

/** Zero-width space: toggled on the live-region text so the same sentence twice is announced twice. */
const REREAD = "\u200B";

const SAVE_ERROR_KEYS = {
  forbidden: "project.scheduleForbidden",
  notFound: "project.saveGone",
  invalid: "project.scheduleInvalid",
  failedStatus: "common.error.saveFailedStatus",
  failed: "common.error.saveFailedNetwork",
} as const;

type SaveVariables = { id: number; start: string | null; end: string | null; expectedRevision: number; before: ProjectView };

/** The cache key of one project's view — under the `["plan"]` prefix, so the Plan page's refresh also refreshes a mounted project view. */
const projectViewKey = (projectId: number) => ["plan", "project", projectId] as const;

/**
 * The project view's data and its ONE schedule write path (the `useRoadmapRanking` shape). A change — a drag, a resize, the Schedule
 * button, the schedule dialog, Unschedule — is a `PUT /milestones/{id}/schedule` with the `expectedRevision` of the view on screen:
 *  - the milestone moves in the cached view at once (`applySchedule`: scheduled ↔ unscheduled, re-sorted);
 *  - success stores the plan revision the PUT answers (the next change needs it), then refreshes `["plan"]` in the background — the
 *    refetched view carries the server's `span` and `drift`;
 *  - a stale-revision 409 (THIS milestone moved after the view was read) rolls back, says so (`stale`) and AWAITS the refetch, which
 *    is the truth; any other failure rolls back, awaits the refetch and surfaces through `error` (already mapped to words).
 * While a save (the PUT, and after a failure the rollback reload) runs, further changes are ignored (`pending`).
 * `announcement` is the live-region sentence for the last non-drag change (a drag is announced by dnd-kit itself).
 */
export function useMilestoneSchedule(projectId: number) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const key = projectViewKey(projectId);
  const query = useQuery({ queryKey: key, queryFn: () => getProjectView(projectId), enabled: Number.isInteger(projectId) });
  const view = query.data;
  const [announcement, setAnnouncement] = useState("");
  // A change refused because a save was still running: shown (and announced) until that save settles.
  const [refused, setRefused] = useState(false);
  // A change aimed at a milestone that is no longer in the view (deleted, then refetched away): shown (and announced) until the next taken change.
  const [gone, setGone] = useState(false);
  /** An identical sentence said twice would not be re-read: every announcement flips an invisible suffix. */
  const announce = (text: string) => setAnnouncement((previous) => (previous.endsWith(REREAD) ? text : text + REREAD));

  const save = useMutation({
    mutationFn: ({ id, start, end, expectedRevision }: SaveVariables) =>
      scheduleMilestone(id, { expectedRevision, startDate: start, endDate: end }),
    onSuccess: ({ revision }) => {
      queryClient.setQueryData<ProjectView>(key, (current) => current && { ...current, revision });
      // Not awaited: the save is over, so the next change may go at once; its `commit` cancels this refetch.
      void refreshQueriesAfterMutation(queryClient, ["plan"]);
    },
    onError: async (_err, { before }) => {
      queryClient.setQueryData<ProjectView>(key, before);
      await refreshQueriesAfterMutation(queryClient, ["plan"]);
    },
    onSettled: () => setRefused(false),
  });

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
    if (save.isPending) {
      setRefused(true);
      if (!options.ownRefusalAlert) announce(t("project.busy"));
      return false;
    }
    setGone(false);
    // Every `["plan"]` fetch, not just this view: the optimistic write must not be overwritten by a read that began before it.
    void queryClient.cancelQueries({ queryKey: ["plan"] });
    queryClient.setQueryData<ProjectView>(key, applySchedule(view, id, start, end));
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
    pending: save.isPending,
    stale: isStaleRevision(save.error),
    error: save.isError && !isStaleRevision(save.error) ? saveErrorMessage(save.error, t, SAVE_ERROR_KEYS) : null,
    announcement,
    /** A change was refused while a save was running; clears when that save settles. */
    refused,
    /** A change aimed at a milestone that is no longer in the view; clears with the next taken change. */
    gone,
    /** Whether the milestone is in the view now (a dialog opened on it closes when it is not). */
    has,
    commit,
  };
}
