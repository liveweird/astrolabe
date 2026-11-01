import type { TeamMilestone, TeamView } from "../api/teams";

/**
 * The optimistic steps of the team page's two write paths on the cached `TeamView`. Pure; the server's answer replaces them at the
 * refetch (the weekly `weeks[]`, the dependency checks and a custom order's exact tail are the SERVER's — never recomputed here).
 */

const lower = (text: string) => text.toLowerCase();
const compare = (a: string, b: string) => (a === b ? 0 : a < b ? -1 : 1);

/**
 * The server's DEFAULT order (the project rank is only the default, `planning-model.md`): the project's rank position (an unranked
 * project after every ranked one), then project name (case-insensitive), project id, then start, end, name (case-insensitive), id.
 */
function byDefaultOrder(a: TeamMilestone, b: TeamMilestone): number {
  const left = a.rankPosition ?? Number.MAX_SAFE_INTEGER;
  const right = b.rankPosition ?? Number.MAX_SAFE_INTEGER;
  return (
    left - right ||
    compare(lower(a.projectName), lower(b.projectName)) ||
    a.projectId - b.projectId ||
    compare(a.startDate ?? "", b.startDate ?? "") ||
    compare(a.endDate ?? "", b.endDate ?? "") ||
    compare(lower(a.name), lower(b.name)) ||
    a.id - b.id
  );
}

/**
 * The view with one milestone's dates replaced (the optimistic step of a schedule write): the milestone moves between `scheduled` and
 * `unscheduled` (a null pair unschedules). `scheduled` keeps the server's order and a newly scheduled row is APPENDED (the refetch
 * places it); an unscheduled row goes back into the tray in the default order. The view is returned as is when the milestone is not in it.
 */
export function applyTeamSchedule(view: TeamView, id: number, start: string | null, end: string | null): TeamView {
  const target = [...view.scheduled, ...view.unscheduled].find((milestone) => milestone.id === id);
  if (target === undefined) return view;
  const moved: TeamMilestone = { ...target, startDate: start, endDate: end };
  const scheduled = view.scheduled.filter((milestone) => milestone.id !== id);
  const unscheduled = view.unscheduled.filter((milestone) => milestone.id !== id);
  if (start === null) return { ...view, scheduled, unscheduled: [...unscheduled, moved].sort(byDefaultOrder) };
  // Replacing in place keeps a row that was already scheduled where it is.
  const inPlace = view.scheduled.some((milestone) => milestone.id === id);
  return {
    ...view,
    scheduled: inPlace ? view.scheduled.map((milestone) => (milestone.id === id ? moved : milestone)) : [...scheduled, moved],
    unscheduled,
  };
}

/**
 * The view as it will read once the FULL order list `ids` (`teamOrderList.ts`) is saved: the listed scheduled rows first in that order,
 * the rest (unlisted) after them in the default order, `order.milestoneIds` the list itself (an id the view holds on neither side is
 * dropped, as the server would refuse it) and `order.custom` set — an EMPTY list is the reset: the default order everywhere and `custom`
 * false. The order's revision is not touched (the PUT's answer stores it).
 */
export function applyTeamOrder(view: TeamView, ids: readonly number[]): TeamView {
  const byId = new Map(view.scheduled.map((milestone) => [milestone.id, milestone]));
  const listed = ids.flatMap((id) => byId.get(id) ?? []);
  const listedIds = new Set(listed.map((milestone) => milestone.id));
  const tail = view.scheduled.filter((milestone) => !listedIds.has(milestone.id)).sort(byDefaultOrder);
  const known = new Set([...view.scheduled, ...view.unscheduled].map((milestone) => milestone.id));
  const milestoneIds = ids.filter((id) => known.has(id));
  return { ...view, scheduled: [...listed, ...tail], order: { ...view.order, custom: milestoneIds.length > 0, milestoneIds } };
}
