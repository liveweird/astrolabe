import { useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { readStoredJson, writeStoredJson } from "./useStoredState";
import { parseProgramPick, withProgramPick } from "../utils/roadmapFilterParams";

const KEY = "planning.programPick";
const isIdList = (value: unknown): value is number[] => Array.isArray(value) && value.every((id) => Number.isInteger(id));

/**
 * The program pick ("which programs am I looking at") of the Programs page: the ids of the programs it shows, empty = all. It follows the Roadmap's
 * rule (1.19; `useRoadmapFilters`, Flow's `useReportFilter`): the address bar always holds the pick the page shows (a link you can copy), and the ONE
 * key `astrolabe.viewSettings.planning.programPick`, which the Roadmap writes too, is the browser's MEMORY of what the user last set, not the state.
 *
 * | Situation | Shown | Address | Remembered key |
 * |---|---|---|---|
 * | bare address, nothing remembered | every program | stays bare | untouched |
 * | bare address, a pick remembered | the remembered pick | rewritten by `replace` to say so | untouched |
 * | an address naming `programId` or `workStreamId` (even a malformed one; the latter stays "linked" for the page's life) | exactly the programs it names (none valid = every program) | as written | untouched |
 * | the user changes the pick | the new pick | rewritten by `replace` (bare when empty) | written |
 * | Back / forward | what that address names | as navigated | untouched |
 *
 * The remembered value is read once when the page's body mounts; a foreign parameter is kept; a change is never a push and no effect writes the
 * memory on a link's arrival. Ids of programs that no longer exist are ignored by the page (`pickAmong`), so a stale value never hides everything.
 */
export function useProgramPick(): [number[], (next: number[]) => void] {
  const [params, setParams] = useSearchParams();
  // What the browser remembers, read once when the page's body mounts (a change in another tab shows on the next bare visit).
  const [remembered, setRemembered] = useState<number[]>(() => {
    const stored = readStoredJson(KEY);
    return isIdList(stored) ? stored : [];
  });
  // An address naming a work stream narrowing (`workStreamId`, 1.31) is taken as written too: the remembered pick is not restored over it (it could hide the very work stream the link names).
  // STICKY for the page's life: clearing the narrowing ("Show every work stream") leaves a bare address, which must not bring the remembered pick back and hide work streams again.
  const [arrivedNarrowed] = useState(() => params.has("workStreamId"));
  const linked = params.has("programId") || params.has("workStreamId") || arrivedNarrowed;
  const search = params.toString();
  const shown = useMemo(() => (linked ? parseProgramPick(new URLSearchParams(search)) : remembered), [linked, search, remembered]);

  // A bare visit with a pick remembered: say so in the address. A replace, so Back is unaffected; nothing is written to the storage.
  const restoring = !linked && remembered.length > 0;
  useEffect(() => {
    if (restoring) setParams((current) => withProgramPick(current, remembered), { replace: true });
  }, [restoring, remembered, setParams]);

  function setPick(ids: number[]) {
    writeStoredJson(KEY, ids);
    setRemembered(ids);
    setParams(withProgramPick(params, ids), { replace: true });
  }

  return [shown, setPick];
}
