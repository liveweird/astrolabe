import { BAR_HEIGHT, BAR_INSET, ROW_HEIGHT, type TimelineGeometry, type TimelineRowData } from "./timelineModel";
import { toEpochDay, type TimelineScale } from "./timelineScale";

/**
 * What the overlay slot draws against, from the rows and the scale alone. The id→index map behind `rowIndexOf` is built on first use (an arrow
 * resolves its rows by id), so a timeline without arrows never pays for it; `visibleRows` is the mounted window `first..last`.
 */
export function buildTimelineGeometry(rows: readonly TimelineRowData[], scale: TimelineScale, visibleRows: { first: number; last: number }): TimelineGeometry {
  let rowIndexById: Map<number | string, number> | null = null;
  return {
    scale,
    rowIndexOf: (rowId) => {
      rowIndexById ??= new Map(rows.map((candidate, index) => [candidate.id, index]));
      return rowIndexById.get(rowId) ?? null;
    },
    xOf: (iso) => scale.xOf(toEpochDay(iso)),
    rowTop: (index) => index * ROW_HEIGHT,
    rowHeight: ROW_HEIGHT,
    visibleRows,
    barRect: (index, barId) => {
      const bar = rows[index]?.bars.find((candidate) => candidate.id === barId);
      if (bar === undefined) return null;
      const start = toEpochDay(bar.start);
      return { x: scale.xOf(start), y: index * ROW_HEIGHT + BAR_INSET, width: scale.widthOf(start, toEpochDay(bar.end)), height: BAR_HEIGHT };
    },
  };
}
