import { useState } from "react";
import { keepPreviousData, useIsMutating, useMutation, useQuery, useQueryClient, type QueryKey } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { pinMilestone, scheduleMilestone } from "../api/milestones";
import { isStaleRevision } from "../api/roadmap";
import { withoutStaleOverlay } from "./useBaselinePick";
import { useRefusal } from "./useRefusal";
import { applyPin } from "../utils/pinUpdate";
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

/** The pin write's failures (the schedule PUT's guard): a 409 is the one "unscheduled" refusal, the milestone lost its dates meanwhile. */
const PIN_ERROR_KEYS = {
  forbidden: "project.scheduleForbidden",
  notFound: "project.saveGone",
  conflict: "project.pinUnscheduled",
  failedStatus: "common.error.saveFailedStatus",
  failed: "common.error.saveFailedNetwork",
} as const;

/** What the write path needs of a timeline page's view: the plan revision and the two milestone lists. */
export type ScheduleView = {
  revision: number;
  scheduled: { id: number; name: string; pinned: boolean }[];
  unscheduled: { id: number; name: string }[];
};

/** `key` is the cache entry the change was made on (the pick it was made under): its rollback goes back there, whatever the page shows by then. */
type SaveVariables<V> = { id: number; start: string | null; end: string | null; expectedRevision: number; before: V; key: QueryKey };
type PinVariables<V> = { id: number; pinned: boolean; before: V; key: QueryKey };

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
 * The cached view's key includes the baseline pick, so an optimistic step hits the entry the page shows and its rollback the entry it was made
 * on; a SUCCESS stores the answered revision into the entry the change was made on ONLY (a sibling pick's entry still holds the old dates, so it must keep
 * the old revision: a write of the same milestone from it is then a stale 409, not an overwrite). The steps (`apply`) leave the view's `baseline` block untouched like `idleGaps` (the refetch brings the new
 * movement). A change is REFUSED out loud while the shown copy is only the previous pick's placeholder (`placeholder`): its revision and rows are
 * not this pick's entry.
 * `announcement` is the live-region sentence for the last non-drag change (a drag is announced by dnd-kit itself).
 * `pin(id, pinned)` (1.7) is the page's SECOND write on the same cached view and key: a pin or unpin of a scheduled milestone (`PUT /milestones/{id}/pin`,
 * no `expectedRevision`). It follows the same rules (optimistic flip, the answered revision stored into the written entry only, a failure rolls back and
 * awaits the refetch; refused out loud while any write of `writeKey` runs) and says the change in the live region; it is never a toast.
 */
export function useScheduleWritePath<V extends ScheduleView & { baseline?: unknown }>({
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
  // The key carries the baseline pick (v0.9): another pick is another entry. `keepPreviousData` keeps the page mounted (and the picker focused) while it
  // loads; the old pick's overlay is dropped from that copy until the new document arrives.
  const query = useQuery({ queryKey, queryFn, enabled, placeholderData: keepPreviousData });
  const view = withoutStaleOverlay(query.data, query.isPlaceholderData);
  const [announcement, setAnnouncement] = useState("");
  // A change aimed at a milestone that is no longer in the view (deleted, then refetched away): shown (and announced) until the next taken change.
  const [gone, setGone] = useState(false);
  /** An identical sentence said twice would not be re-read: every announcement flips an invisible suffix. */
  const announce = (text: string) => setAnnouncement((previous) => (previous.endsWith(REREAD) ? text : text + REREAD));

  const save = useMutation({
    mutationKey: writeKey,
    mutationFn: ({ id, start, end, expectedRevision }: SaveVariables<V>) => scheduleMilestone(id, { expectedRevision, startDate: start, endDate: end }),
    onSuccess: ({ revision }, { key }) => {
      // The new revision into the entry the change was made on - the one holding the moved dates - and into no other: a sibling entry (another
      // pick visited earlier) still holds the OLD dates, so it keeps the old revision and a write of the SAME milestone made from it before its
      // refetch lands is answered 409 (the milestone's own schedule revision is newer) instead of silently overwriting this one.
      queryClient.setQueryData<V>(key, (current) => current && { ...current, revision });
      // Not awaited: the save is over, so the next change may go at once; its `commit` cancels this refetch.
      void refreshQueriesAfterMutation(queryClient, ["plan"]);
    },
    onError: async (_err, { before, key }) => {
      queryClient.setQueryData<V>(key, before);
      await refreshQueriesAfterMutation(queryClient, ["plan"]);
    },
  });
  const pinSave = useMutation({
    mutationKey: writeKey,
    mutationFn: ({ id, pinned }: PinVariables<V>) => pinMilestone(id, pinned),
    onSuccess: ({ revision }, { key }) => {
      // As for a schedule: the written entry only (a pin stamps no schedule revision, but a sibling's newer plan revision would mask a staleness).
      queryClient.setQueryData<V>(key, (current) => current && { ...current, revision });
      void refreshQueriesAfterMutation(queryClient, ["plan"]);
    },
    onError: async (_err, { before, key }) => {
      queryClient.setQueryData<V>(key, before);
      await refreshQueriesAfterMutation(queryClient, ["plan"]);
    },
  });
  const writing = useIsMutating({ mutationKey: writeKey }) > 0;
  const busy = save.isPending || pinSave.isPending || writing;
  // The shown copy belongs to the previous pick while the new one loads: nothing is written from it either.
  const placeholder = query.isPlaceholderData;
  // A change refused because a save was still running (or the pick is loading): shown (and announced) until THAT is over.
  const [refused, setRefused] = useRefusal(busy || placeholder);

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
    if (busy || placeholder) {
      setRefused(true);
      if (!options.ownRefusalAlert) announce(t("project.busy"));
      return false;
    }
    setGone(false);
    // A taken schedule change clears the pin's old failure (the pin clears the schedule's): `error` never shows a failure of an earlier write.
    pinSave.reset();
    // Every `["plan"]` fetch, not just this view: the optimistic write must not be overwritten by a read that began before it.
    void queryClient.cancelQueries({ queryKey: ["plan"] });
    queryClient.setQueryData<V>(queryKey, apply(view, id, start, end));
    if (options.announce) {
      const name = nameOf(id);
      announce(start === null || end === null ? t("project.announce.unscheduled", { name }) : t("project.announce.scheduled", { name, start, end }));
    }
    save.mutate({ id, start, end, expectedRevision: options.revision ?? view.revision, before: view, key: queryKey });
    return true;
  };

  const scheduleError = save.isError && !isStaleRevision(save.error) ? saveErrorMessage(save.error, t, SAVE_ERROR_KEYS) : null;
  const pinError = pinSave.isError ? saveErrorMessage(pinSave.error, t, PIN_ERROR_KEYS) : null;

  /** Pin or unpin a scheduled milestone; answers whether the change was taken (the same refusals as `commit`). */
  const pin = (id: number, pinned: boolean): boolean => {
    if (!view) return false;
    if (!has(id)) {
      setGone(true);
      announce(t("project.milestoneGone"));
      return false;
    }
    if (busy || placeholder) {
      setRefused(true);
      announce(t("project.busy"));
      return false;
    }
    setGone(false);
    save.reset();
    void queryClient.cancelQueries({ queryKey: ["plan"] });
    queryClient.setQueryData<V>(queryKey, applyPin(view, id, pinned));
    announce(t(pinned ? "project.announce.pinned" : "project.announce.unpinned", { name: nameOf(id) }));
    pinSave.mutate({ id, pinned, before: view, key: queryKey });
    return true;
  };

  return {
    view,
    query,
    pending: busy,
    /** The shown view is the previous pick's copy while the new pick loads: every write is refused until it arrives. */
    placeholder,
    stale: isStaleRevision(save.error),
    error: scheduleError ?? pinError,
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
    pin,
  };
}
