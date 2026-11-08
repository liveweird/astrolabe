/**
 * The optimistic step of a pin write on a cached plan view (the project view and the team view both carry `scheduled[]` with `pinned`): the
 * milestone's flag replaced, nothing else touched. Only a SCHEDULED row can be pinned, so the tray is not searched; the view is returned as is
 * when the milestone is not a scheduled row of it (or already reads so).
 */
export function applyPin<V extends { scheduled: { id: number; pinned: boolean }[] }>(view: V, id: number, pinned: boolean): V {
  const target = view.scheduled.find((milestone) => milestone.id === id);
  if (target === undefined || target.pinned === pinned) return view;
  return { ...view, scheduled: view.scheduled.map((milestone) => (milestone.id === id ? { ...milestone, pinned } : milestone)) };
}
