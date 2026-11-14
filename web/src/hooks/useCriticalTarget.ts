import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { isUnknownBaseline } from "../api/baselines";
import { ApiError } from "../api/http";
import type { RoadmapProject } from "../api/roadmap";

/**
 * A plain 400 of the roadmap view while a critical-path target is set: the server's answer to a `?criticalPath=` that names an unknown, deleted or
 * off-roadmap project (a plain 400 - plan ids are no secret). The typed unknown-baseline 400 is the baseline pick's, not this one's.
 */
export function isRejectedTarget(err: unknown): boolean {
  return err instanceof ApiError && err.status === 400 && !isUnknownBaseline(err);
}

/**
 * The critical-path target of the roadmap (1.7) and the programs page (1.16): the project the page shows the chain toward. PAGE-LOCAL state, not stored - a question the viewer asks,
 * not a setting (a reload or another page forgets it). `reject()` is the page's answer to a 400 for the target: the selection is cleared and `rejected`
 * says so (the page shows it inline) until the next pick.
 */
export function useCriticalTarget(): { target: number | null; set: (id: number | null) => void; rejected: boolean; reject: () => void } {
  const [state, setState] = useState<{ target: number | null; rejected: boolean }>({ target: null, rejected: false });
  return {
    target: state.target,
    set: (id) => setState({ target: id, rejected: false }),
    rejected: state.rejected,
    reject: () => setState({ target: null, rejected: true }),
  };
}

/**
 * The page's sentence for a chain that has ARRIVED, said once per arrival (the chain's target id changes), not per render or refetch: "Showing the critical
 * path to X", or - a target with nothing scheduled - "Nothing is scheduled in X…". `chainProject` is the project of the view's own `criticalPath` block
 * (`undefined` while none has arrived, so a pick the server may still reject is never announced); `announce` is the page's one polite status region.
 */
export function useCriticalAnnouncement(chainProject: Pick<RoadmapProject, "id" | "name" | "span"> | undefined, announce: (text: string) => void): void {
  const { t } = useTranslation();
  const announced = useRef<number | null>(null);
  const chainId = chainProject?.id ?? null;
  useEffect(() => {
    if (chainId === announced.current) return;
    announced.current = chainId;
    if (chainProject === undefined) return;
    announce(chainProject.span === null ? t("roadmap.critical.nothingScheduled", { name: chainProject.name }) : t("roadmap.announce.criticalShown", { name: chainProject.name }));
  });
}
