import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { localIsoDate } from "../utils/isoDate";
import { sameIds, sameRun } from "../utils/savedProposal";
import type { useCrossTeamProposal } from "./useCrossTeamProposal";
import { useSavedVerdict } from "./useSavedVerdict";

type Flow = ReturnType<typeof useCrossTeamProposal>;

/**
 * The saved cross-team proposal the Roadmap overview's address names (`?proposal=<id>`, 1.33; the former `/schedule-proposals/saved/:id` page). The stored run is
 * the SERVER's own computation, shown as it is, never recomputed: once the viewer's rights are read (`ready`) it OPENS in the overview's own run (`flow.open`, no request),
 * so the bars, the table and the sections are the ones a fresh run has. What the saved record adds, derived here:
 * - `acceptable`: `can.accept` (the server's arithmetic: ADMIN or the manager of at least one stored team) while the record is `CURRENT` and was computed for TODAY (the
 *   rights weigh the plan, not the day). Only then are the ticks editable and the accept offered (it names the teams of the ticked moves); otherwise the stored ticks are shown read-only;
 * - `fresh`: the run on screen is not the stored one (Propose again, or a stale scope re-proposed it): it is the viewer's own run and behaves like any overview run;
 * - `asking`: the live check is asked of the server (a fresh run, or ticks other than the stored ones); otherwise the stored check describes the stored ticks.
 * The record's own answers: a 404 (deleted, or pruned by the 21st save) says so and drops the parameter - the cached copy too, so a proposal that is gone is never opened; an
 * `UNREADABLE` one (saved in a shape this server no longer reads) says so and opens nothing; any other failure is worded by its status. In each case the
 * parameter leaves the address. `close()` (Close, Discard) drops it too, and so does an accept that went through or any other end of the run. A different id
 * replaces the run on screen (the previous one is discarded first, never while an accept runs); the parameter leaving the address (Back, a mode switch) closes the run it opened.
 * Nothing here asks the server to compute anything.
 */
export function useSavedRun({ flow, ready, announce }: { flow: Flow; ready: boolean; announce: (text: string) => void }) {
  const { t } = useTranslation();
  // Which saved id's run was opened on screen (the parameter alone cannot say: a Close takes the run away a render before the address follows).
  const [opened, setOpened] = useState<number | null>(null);
  const { discard, open, dismiss } = flow;
  const running = flow.proposal;
  const { raw, id, record, verdict, notice, dismissNotice, drop, handled } = useSavedVerdict(announce, () => {
    // A verdict ends the run it had opened.
    if (opened !== null && running !== null && (id === null || opened === id)) discard();
  });

  // The stored run opens ONCE per id, as the overview's own preview. A run of another id (or the viewer's own) on screen is discarded first.
  const stored = record?.proposal ?? null;
  useEffect(() => {
    if (id === null || record === undefined || stored === null || !ready || opened === id) return;
    if (running !== null) {
      discard();
      return;
    }
    if (flow.requesting || flow.applying) return;
    if (flow.outcome !== null || flow.stale || flow.note !== null) dismiss();
    if (open(stored, new Set(record.selectedMilestoneIds))) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- the open is itself an effect of the record's arrival: the id it opened is remembered in the same batch
      setOpened(id);
      announce(t("programs.saved.opened", { name: record.name }));
    }
  }, [id, record, stored, ready, opened, running, flow.requesting, flow.applying, flow.outcome, flow.stale, flow.note, dismiss, open, discard, announce, t]);

  // The run ended some way other than Close (an accept went through, a stale refusal, a fresh run that opened nothing): the saved context goes with it.
  const ended = flow.outcome !== null || flow.stale || flow.note !== null || (flow.error !== null && running === null);
  useEffect(() => {
    if (opened === null || id === null || !ended || handled.current.has(`ended:${raw}`)) return;
    handled.current.add(`ended:${raw}`);
    drop();
  });
  // The parameter left the address (Close, an accept, Back, a mode switch): the saved context is over, and a run it opened with it.
  useEffect(() => {
    if (id !== null || opened === null) return;
    if (running !== null) discard();
    // eslint-disable-next-line react-hooks/set-state-in-effect -- the address is the state: its leaving ends the context the open began
    setOpened(null);
  }, [id, opened, running, discard]);

  const today = localIsoDate();
  const shown = record !== undefined && opened === id && running !== null ? record : null;
  const derived = useMemo(() => {
    if (shown === null || running === null) return null;
    const outdated = shown.proposal !== null && shown.proposal.asOf !== today;
    const acceptable = shown.can.accept && shown.state === "CURRENT" && !outdated;
    const fresh = shown.proposal === null || !sameRun(running, shown.proposal);
    return { outdated, acceptable, fresh, editable: fresh || acceptable };
  }, [shown, running, today]);
  const storedIds = useMemo(() => new Set(shown?.selectedMilestoneIds ?? []), [shown]);

  return {
    /** The saved record whose run is on screen (stored or re-proposed), with what its page derives of it; `null` when the run on screen is not from a saved proposal. */
    saved:
      shown === null || derived === null
        ? null
        : {
            record: shown,
            ...derived,
            /** The ticks to show: the viewer's while editable, the stored ones otherwise. */
            ticked: derived.editable ? flow.selected : storedIds,
            /** The live check is asked of the server (a fresh run, or ticks that are not the stored ones). */
            asking: derived.editable && (derived.fresh || !sameIds(flow.selected, shown.selectedMilestoneIds)),
          },
    /** What the address named that did not open, or `null`. */
    notice,
    dismissNotice,
    /** The address names a proposal that is still being read or is waiting for the viewer's rights. */
    loading: id !== null && verdict === null && opened !== id,
    /** Close the run (not while an accept runs) and take the parameter out of the address. */
    close: (): boolean => {
      if (!discard()) return false;
      if (raw !== null) drop();
      return true;
    },
  };
}
