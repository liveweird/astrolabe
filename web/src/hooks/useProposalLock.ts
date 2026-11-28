import { useTranslation } from "react-i18next";
import { useRefusal } from "./useRefusal";

/**
 * The team page's read-only mode around a schedule proposal (v0.8). The page is LOCKED from the moment a proposal is asked for until it
 * is closed (`locked`): the request window counts, or a change made while it is in flight would be written under the premise the
 * proposal is about to void. Every entry point of the schedule and the order (menu items, the tray's Schedule, the dialogs, drags,
 * Reset) goes through `guarded(run)` or `refuse()`, which refuse out loud instead of running while locked: `refused` is set (the page's
 * visible note, cleared when the lock ends) and the page's live region says why (`announce`). Any open proposal fits (the team page's and, since 1.33,
 * the cross-team run on the Roadmap overview, whose target windows it locks, on the project page, whose date writes it locks, and, since 1.39, on Prioritization, whose
 * ranking and target windows it locks).
 */
export function useProposalLock<P extends object>(proposal: { proposal: P | null; requesting: boolean }, announce: (text: string) => void) {
  const { t } = useTranslation();
  const open = proposal.proposal;
  const locked = open !== null || proposal.requesting;
  const [refused, setRefused] = useRefusal(locked);

  const refuse = (): false => {
    setRefused(true);
    announce(open !== null ? t("teams.proposal.readOnly") : t("project.busy"));
    return false;
  };

  return {
    open,
    locked,
    /** A change was refused while locked; clears when the lock ends. */
    refused,
    refuse,
    /** Runs `run` unless locked, in which case it refuses out loud. */
    guarded:
      <A extends unknown[]>(run: (...args: A) => void) =>
      (...args: A): void => {
        if (locked) refuse();
        else run(...args);
      },
  };
}
