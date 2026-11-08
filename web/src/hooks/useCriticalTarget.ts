import { useState } from "react";
import { isUnknownBaseline } from "../api/baselines";
import { ApiError } from "../api/http";

/**
 * A plain 400 of the roadmap view while a critical-path target is set: the server's answer to a `?criticalPath=` that names an unknown, deleted or
 * off-roadmap project (a plain 400 - plan ids are no secret). The typed unknown-baseline 400 is the baseline pick's, not this one's.
 */
export function isRejectedTarget(err: unknown): boolean {
  return err instanceof ApiError && err.status === 400 && !isUnknownBaseline(err);
}

/**
 * The roadmap's critical-path target (1.7): the project the page shows the chain toward. PAGE-LOCAL state, not stored - a question the viewer asks,
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
