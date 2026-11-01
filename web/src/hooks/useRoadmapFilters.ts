import { isBoolean, useStoredState } from "./useStoredState";
import type { RoadmapFilters } from "../utils/roadmapRows";

const isIdOrNull = (value: unknown): value is number | null => value === null || Number.isInteger(value);

/**
 * The roadmap's four filters, each remembered in the browser under `astrolabe.viewSettings.roadmap.filter.*` (the Users template). They are
 * applied client-side (the view is ~100 rows). The stored values may name things that are gone: the page reads them through `knownFilters`.
 */
export function useRoadmapFilters(): { filters: RoadmapFilters; set: (change: Partial<RoadmapFilters>) => void } {
  const [workStreamId, setWorkStreamId] = useStoredState<number | null>("roadmap.filter.workStream", null, isIdOrNull);
  const [teamId, setTeamId] = useStoredState<number | null>("roadmap.filter.team", null, isIdOrNull);
  const [ownerPersonId, setOwnerPersonId] = useStoredState<number | null>("roadmap.filter.owner", null, isIdOrNull);
  const [flaggedOnly, setFlaggedOnly] = useStoredState("roadmap.filter.flagged", false, isBoolean);
  return {
    filters: { workStreamId, teamId, ownerPersonId, flaggedOnly },
    set: (change) => {
      if (change.workStreamId !== undefined) setWorkStreamId(change.workStreamId);
      if (change.teamId !== undefined) setTeamId(change.teamId);
      if (change.ownerPersonId !== undefined) setOwnerPersonId(change.ownerPersonId);
      if (change.flaggedOnly !== undefined) setFlaggedOnly(change.flaggedOnly);
    },
  };
}
