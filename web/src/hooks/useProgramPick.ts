import { useStoredState } from "./useStoredState";

/**
 * The program pick ("which programs am I looking at"): the ids of the programs the plan pages show, empty = all. ONE key shared by every plan
 * page (the roadmap now, the programs page next), under `astrolabe.viewSettings.planning.programPick` — per browser, like every view setting.
 * Ids of programs that no longer exist are ignored by the pages (`knownPick`), so a stale value never hides everything.
 */
const isIdList = (value: unknown): value is number[] => Array.isArray(value) && value.every((id) => Number.isInteger(id));

export function useProgramPick(): [number[], (next: number[]) => void] {
  return useStoredState<number[]>("planning.programPick", [], isIdList);
}
