import type { ProjectMilestone, ProjectView } from "../api/milestones";

const byName = (a: ProjectMilestone, b: ProjectMilestone) => {
  const left = a.name.toLowerCase();
  const right = b.name.toLowerCase();
  if (left !== right) return left < right ? -1 : 1;
  return a.id - b.id;
};

/** The server's order of `scheduled`: start, end, name (case-insensitive), id. ISO dates order as text. */
const byStart = (a: ProjectMilestone, b: ProjectMilestone) => {
  const left = [a.startDate ?? "", a.endDate ?? ""];
  const right = [b.startDate ?? "", b.endDate ?? ""];
  if (left[0] !== right[0]) return left[0] < right[0] ? -1 : 1;
  if (left[1] !== right[1]) return left[1] < right[1] ? -1 : 1;
  return byName(a, b);
};

/**
 * The cached project view with one milestone's dates replaced (the optimistic step of a schedule write): the milestone moves
 * between `scheduled` and `unscheduled` (a null pair unschedules) and both lists keep the server's order. Nothing else is
 * recomputed — `span` and `drift` are the server's, refreshed after the write; the view is returned as is when the milestone
 * is not in it.
 */
export function applySchedule(view: ProjectView, id: number, start: string | null, end: string | null): ProjectView {
  const all = [...view.scheduled, ...view.unscheduled];
  const target = all.find((milestone) => milestone.id === id);
  if (target === undefined) return view;
  // Unscheduling clears the pin (the server does it in the same write): only a scheduled milestone can be pinned.
  const moved: ProjectMilestone = { ...target, startDate: start, endDate: end, pinned: start !== null && target.pinned };
  const rest = all.filter((milestone) => milestone.id !== id);
  const scheduled = [...rest.filter((m) => m.startDate !== null), ...(start === null ? [] : [moved])].sort(byStart);
  const unscheduled = [...rest.filter((m) => m.startDate === null), ...(start === null ? [moved] : [])].sort(byName);
  return { ...view, scheduled, unscheduled };
}
