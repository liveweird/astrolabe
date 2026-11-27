import { useCallback, useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";
import type { ProgramsView, ProgramsWorkStream } from "../api/programs";
import { idOf } from "../utils/deviationFilters";

/** The address's word for the work stream the overview is narrowed to (`workStreamPath`: `/roadmap?mode=overview&workStreamId=3`); the Prioritization mode's own filter has the same name. */
const PARAM = "workStreamId";

/**
 * The work stream the Roadmap OVERVIEW is narrowed to (1.31). It lives in the address ALONE - a link's narrowing, or the filter panel's field - and is never remembered: a
 * narrowing the viewer did not choose in this visit must not come back on a bare one, and the overview's remembered program pick (`useProgramPick`) takes no part in an address that
 * names it. A change is a `replace`, every other parameter kept; the mode switch drops the parameter with the filters.
 *
 * An id the plan does not have (a work stream deleted since the link was made, a malformed value) drops the narrowing - the whole plan shows - and `unknown` says so (a dismissible
 * notice); the parameter leaves the address. The verdict waits for `settled` (the last read succeeded and none is in flight), so a work stream created a moment ago, missing from a cached copy, is not dropped.
 */
export function useWorkStreamNarrowing(
  view: ProgramsView,
  settled: boolean,
): { workStream: ProgramsWorkStream | null; unknown: boolean; pending: boolean; set: (id: number | null) => void; dismiss: () => void } {
  const [params, setParams] = useSearchParams();
  const raw = params.get(PARAM);
  const id = idOf(raw);
  const workStream = id === undefined ? null : (view.workStreams.find((stream) => stream.id === id) ?? null);
  const missing = raw !== null && workStream === null && settled;
  const [unknown, setUnknown] = useState(false);
  // The notice follows the address's verdict (adjusted during render: the address is dropped right after).
  if (raw !== null && settled && unknown !== missing) setUnknown(missing);

  const write = useCallback(
    (next: number | null) =>
      setParams(
        (previous) => {
          const written = new URLSearchParams(previous);
          if (next === null) written.delete(PARAM);
          else written.set(PARAM, String(next));
          return written;
        },
        { replace: true },
      ),
    [setParams],
  );
  useEffect(() => {
    if (missing) write(null);
  }, [missing, write]);

  // `pending`: the address names a work stream the view does not narrow to (yet: unsettled, or unknown and about to be dropped).
  return { workStream, unknown, pending: raw !== null && workStream === null, set: write, dismiss: () => setUnknown(false) };
}
