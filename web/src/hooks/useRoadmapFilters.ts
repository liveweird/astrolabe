import { useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { isBoolean, readStoredJson, writeStoredJson } from "./useStoredState";
import {
  hasRoadmapFilterParams,
  isRoadmapFilterEmpty,
  parseRoadmapFilter,
  withRoadmapFilterParams,
  type RoadmapFilterState,
} from "../utils/roadmapFilterParams";
import type { RoadmapFilters } from "../utils/roadmapRows";

const isIdOrNull = (value: unknown): value is number | null => value === null || Number.isInteger(value);
const isIdList = (value: unknown): value is number[] => Array.isArray(value) && value.every((id) => Number.isInteger(id));

// The five remembered keys (`astrolabe.viewSettings.<key>`): the four filters are the roadmap's own, the pick is the ONE key the programs page reads too.
const KEYS = {
  workStreamId: "roadmap.filter.workStream",
  teamId: "roadmap.filter.team",
  ownerPersonId: "roadmap.filter.owner",
  flaggedOnly: "roadmap.filter.flagged",
  pick: "planning.programPick",
} as const;

function readRemembered(): RoadmapFilterState {
  const idOf = (key: string) => {
    const stored = readStoredJson(key);
    return isIdOrNull(stored) ? stored : null;
  };
  const flagged = readStoredJson(KEYS.flaggedOnly);
  const pick = readStoredJson(KEYS.pick);
  return {
    filters: {
      workStreamId: idOf(KEYS.workStreamId),
      teamId: idOf(KEYS.teamId),
      ownerPersonId: idOf(KEYS.ownerPersonId),
      flaggedOnly: isBoolean(flagged) ? flagged : false,
    },
    pick: isIdList(pick) ? pick : [],
  };
}

function remember({ filters, pick }: RoadmapFilterState) {
  writeStoredJson(KEYS.workStreamId, filters.workStreamId);
  writeStoredJson(KEYS.teamId, filters.teamId);
  writeStoredJson(KEYS.ownerPersonId, filters.ownerPersonId);
  writeStoredJson(KEYS.flaggedOnly, filters.flaggedOnly);
  writeStoredJson(KEYS.pick, pick);
}

/**
 * The roadmap's four filters and its program pick: the address bar always holds what the page shows (a link you can copy), and the browser remembers
 * what the user last set (Flow's rule, ported from its `useReportFilter`; the five stored keys are the memory, not the state).
 *
 *  - A URL naming any filter parameter is shown exactly as written (anything it does not name is off, the pick included) and is NOT stored.
 *  - A bare URL shows the remembered filters and pick and rewrites the address by `replace` to say so (nothing remembered = stays bare).
 *  - Only the user's own change is stored: the WHOLE shown state, written to all five keys, and the address is rewritten by `replace`
 *    (bare when empty). Back, forward and the rewrite of a bare visit write nothing.
 *
 * The values may name things that are gone: the page reads them through `knownFilters` / `knownPick`.
 */
export function useRoadmapFilters(): {
  filters: RoadmapFilters;
  pick: number[];
  setFilters: (change: Partial<RoadmapFilters>) => void;
  setPick: (ids: number[]) => void;
} {
  const [params, setParams] = useSearchParams();
  // What the browser remembers, read once when the page mounts (a change in another tab shows on the next bare visit, as before).
  const [remembered, setRemembered] = useState(readRemembered);
  const linked = hasRoadmapFilterParams(params);
  const search = params.toString();
  const shown = useMemo(() => (linked ? parseRoadmapFilter(new URLSearchParams(search)) : remembered), [linked, search, remembered]);

  // A bare visit with something remembered: say so in the address. A replace, so Back is unaffected; nothing is written to the storage.
  const restoring = !linked && !isRoadmapFilterEmpty(remembered);
  useEffect(() => {
    if (restoring) setParams((current) => withRoadmapFilterParams(current, remembered), { replace: true });
  }, [restoring, remembered, setParams]);

  function commit(next: RoadmapFilterState) {
    remember(next);
    setRemembered(next);
    setParams(withRoadmapFilterParams(params, next), { replace: true });
  }

  return {
    filters: shown.filters,
    pick: shown.pick,
    setFilters: (change) => commit({ filters: { ...shown.filters, ...change }, pick: shown.pick }),
    setPick: (ids) => commit({ filters: shown.filters, pick: ids }),
  };
}
