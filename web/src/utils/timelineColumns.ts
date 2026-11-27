import type { TimelineColumn } from "./timelineModel";

/** The pages whose Gantt can hide its extra left columns; the choice is remembered per page (`timeline.columns.<page>`). */
export type TimelineColumnsPage = "project" | "team" | "roadmap" | "programs";

/**
 * What a viewer chose, stored as is: `collapsed` hides every column the page offers (the toolbar's toggle) and `hidden` the ones picked off one by one
 * in the menu. A page that stops offering a column leaves its id here untouched, so the choice is back when the column is ("Hidden columns").
 */
export interface ColumnPrefs {
  collapsed: boolean;
  hidden: string[];
}

/** A first visit: every column shown, and nothing written until the viewer acts. */
export const DEFAULT_COLUMN_PREFS: ColumnPrefs = { collapsed: false, hidden: [] };

/** More ids than any page has columns; a stored list beyond it is not ours. */
const MAX_HIDDEN_IDS = 16;

/** The shape of a stored choice only: an id the page no longer offers is harmless, so it is not checked here. */
export function isColumnPrefs(value: unknown): value is ColumnPrefs {
  if (typeof value !== "object" || value === null) return false;
  const { collapsed, hidden } = value as Record<string, unknown>;
  return typeof collapsed === "boolean" && Array.isArray(hidden) && hidden.length <= MAX_HIDDEN_IDS && hidden.every((id) => typeof id === "string");
}

/** The offered columns not drawn: all of them while collapsed, else the ones picked off (an id nothing offers is ignored). */
export function hiddenColumnIds(prefs: ColumnPrefs, offered: readonly TimelineColumn[]): ReadonlySet<string> {
  return new Set(offered.filter((column) => prefs.collapsed || prefs.hidden.includes(column.id)).map((column) => column.id));
}

/**
 * The toolbar's toggle. While any offered column is drawn it collapses them all (the per-column pick is kept); while none is, it expands again to
 * that pick — unless the pick would show nothing, then to everything.
 */
export function toggledAll(prefs: ColumnPrefs, offered: readonly TimelineColumn[]): ColumnPrefs {
  const hidden = hiddenColumnIds(prefs, offered);
  if (hidden.size < offered.length) return { collapsed: true, hidden: prefs.hidden };
  const ids = new Set(offered.map((column) => column.id));
  const pickHidesAll = offered.every((column) => prefs.hidden.includes(column.id));
  return { collapsed: false, hidden: pickHidesAll ? prefs.hidden.filter((id) => !ids.has(id)) : prefs.hidden };
}

/**
 * The menu's pick: `shown` are the offered columns to draw. It expands (a tick while collapsed shows that column alone), and what it does not offer now
 * keeps its earlier choice (Slack's, while Critical path is off).
 */
export function pickedColumns(prefs: ColumnPrefs, offered: readonly TimelineColumn[], shown: readonly string[]): ColumnPrefs {
  const ids = new Set(offered.map((column) => column.id));
  const kept = prefs.hidden.filter((id) => !ids.has(id));
  const picked = offered.map((column) => column.id).filter((id) => !shown.includes(id));
  // Bounded like `isColumnPrefs` accepts: the offered ids first, then the earlier choices of columns not offered now.
  return { collapsed: false, hidden: [...picked, ...kept].slice(0, MAX_HIDDEN_IDS) };
}

/** What `useTimelineColumns` hands a page: the set for `Timeline.hiddenColumns` and the state of the toolbar control. */
export interface TimelineColumnView {
  hidden: ReadonlySet<string>;
  /** The columns the page lets the viewer hide, in column order. */
  offered: readonly TimelineColumn[];
  /** Every offered column is hidden (the toggle then offers to show them). */
  allHidden: boolean;
  toggleAll: () => void;
  /** The offered columns to draw; every other offered one is hidden. */
  setShown: (ids: string[]) => void;
}
