import { useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import type { TeamCriticalChain, TeamView } from "../api/teams";

/**
 * The team page's critical chain (1.27): the view's `criticalChain` block while the Critical path toggle is on (`shown`), else `undefined` - the
 * kept copy of the other document (`keepPreviousData`) may still carry, or lack, the block while the toggle has just changed - and the page's
 * sentence for a chain that has ARRIVED (the Roadmap's rule): said once per switch-on MADE IN THIS MOUNT, never for the plain copy on its way (no block
 * yet) and never on a first load with the toggle already on (the persisted choice is not a change); said again after the toggle was off. It counts the
 * rows the chain added (milestones of other teams and whole projects). `announce` is the page's one polite status region.
 */
export function useTeamChain(view: Pick<TeamView, "criticalChain"> | undefined, shown: boolean, announce: (text: string) => void): TeamCriticalChain | undefined {
  const { t } = useTranslation();
  // Already on when the page mounted: nothing to say until it has been off and on again.
  const said = useRef(shown);
  const chain = shown ? view?.criticalChain : undefined;
  useEffect(() => {
    if (!shown) {
      said.current = false;
      return;
    }
    if (chain === undefined || said.current) return;
    said.current = true;
    const count = chain.members.length;
    announce(count === 0 ? t("teams.view.chain.announceNone") : t("teams.view.chain.announce", { count }));
  });
  return chain;
}
