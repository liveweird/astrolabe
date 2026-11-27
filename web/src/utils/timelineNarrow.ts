import type { TimelineColumn } from "./timelineModel";

/** A scroller narrower than this (px) is a phone: its sticky left columns are capped so the track keeps a share. */
export const NARROW_BELOW = 600;
/** The share of a narrow scroller the left columns may take, and the least they may be capped to. */
const LEFT_SHARE = 0.55;
const MIN_LEFT = 190;
const NO_KEPT: ReadonlySet<string> = new Set();
/** The widest non-hideable column (the row's name) is shrunk, never below this. */
const MIN_NAME = 88;

/**
 * The columns a narrow scroller draws. `width` is the scroller's measured width (`null` = not measured: nothing changes). Below `NARROW_BELOW`
 * the left columns are capped at 55 % of it: first the hideable columns go, from the last, as far as the cap needs (the viewer's own pick is
 * left alone, this only hides more), then the widest non-hideable column (the name) is shrunk to what is left, to 88 px at the least. `keep` are
 * the columns the viewer asked for this session: they are dropped last (never, if the name's 88 px is all that gives), so the cap yields to them.
 * A column that stays keeps its id and position, so `data-grid-pos` and the bars' columns do not move ("Hidden columns" in timeline.md).
 * Input that needs no change comes back as the same objects.
 */
export function fitColumns(
  columns: readonly TimelineColumn[],
  hidden: ReadonlySet<string>,
  width: number | null,
  keep: ReadonlySet<string> = NO_KEPT,
): { columns: readonly TimelineColumn[]; hidden: ReadonlySet<string> } {
  if (width === null || width >= NARROW_BELOW) return { columns, hidden };
  const cap = Math.max(MIN_LEFT, Math.round(width * LEFT_SHARE));
  const drawn = columns.filter((column) => !hidden.has(column.id));
  const flexible = drawn.filter((column) => column.hideable !== true).reduce<TimelineColumn | null>((widest, column) => (widest === null || column.width > widest.width ? column : widest), null);
  if (flexible === null) return { columns, hidden };
  const sum = (list: readonly TimelineColumn[]) => list.reduce((total, column) => total + column.width, 0);
  const kept = [...drawn];
  const nextHidden = new Set(hidden);
  for (const column of [...drawn].reverse()) {
    if (sum(kept) - flexible.width + MIN_NAME <= cap) break;
    if (column.hideable === true && !keep.has(column.id)) {
      kept.splice(kept.indexOf(column), 1);
      nextHidden.add(column.id);
    }
  }
  const room = Math.max(MIN_NAME, cap - (sum(kept) - flexible.width));
  if (nextHidden.size === hidden.size && room >= flexible.width) return { columns, hidden };
  const fitted = room >= flexible.width ? columns : columns.map((column) => (column === flexible ? { ...column, width: room } : column));
  return { columns: fitted, hidden: nextHidden.size === hidden.size ? hidden : nextHidden };
}
