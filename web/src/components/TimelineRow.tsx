import { rovingProps, type GridPos } from "../hooks/useRovingGrid";
import { COLUMNS_PER_BAR, type TimelineBandData, type TimelineColumn, type TimelineRowData } from "../utils/timelineModel";
import { toEpochDay, type TimelineScale } from "../utils/timelineScale";
import TimelineBar from "./TimelineBar";
import TimelineDrawSurface from "./TimelineDrawSurface";
import classes from "../theme.module.css";

const BAND_TONE_CLASS = { window: "", drift: classes.timelineBandDrift, idle: classes.timelineBandIdle } as const;

/** A decorative band over a day span (the plan window, a drift, an idle gap): its facts live in the page's text, so it is `aria-hidden`; tests read `data-band-tone`. */
export function TimelineBand({ band, scale }: { band: TimelineBandData; scale: TimelineScale }) {
  const start = toEpochDay(band.start);
  return (
    <div
      aria-hidden="true"
      title={band.label}
      data-band-tone={band.tone}
      className={`${classes.timelineBand} ${BAND_TONE_CLASS[band.tone]}`}
      style={{ left: scale.xOf(start), width: scale.widthOf(start, toEpochDay(band.end)) }}
    />
  );
}

interface RowProps {
  row: TimelineRowData;
  /** Zero-based; the roving grid's row is `index + 1`. */
  index: number;
  scale: TimelineScale;
  columns: readonly TimelineColumn[];
  leftWidth: number;
  /** The grid's current tab stop. */
  active: GridPos;
  /** The weekend background of the track (one periodic gradient), or `null`. */
  hatch: string | null;
  /** Set on the virtual path: the row is absolutely positioned this far from the top of the body. */
  top?: number;
}

/**
 * One row: the sticky left cells (the first is the row header — the name) and the track (the weekend hatch, the row's own bands,
 * the bars or the page's `track`). Both render paths mount this same row; the virtual one only positions it. A left cell given as
 * a function receives the roving stop to spread on its own focusable (a link, a menu button); a static one is the stop itself.
 */
export default function TimelineRow({ row, index, scale, columns, leftWidth, active, hatch, top }: RowProps) {
  const r = index + 1;
  const roving = (c: number) => rovingProps(r, c, active.r === r && active.c === c);
  return (
    <div
      role="row"
      aria-rowindex={r + 1}
      className={`${classes.timelineRow} ${top === undefined ? "" : classes.timelineRowVirtual}`}
      style={top === undefined ? undefined : { top, width: leftWidth + scale.totalWidth }}
    >
      <div role="presentation" className={classes.timelineLeft} style={{ width: leftWidth }}>
        {columns.map((column, c) => {
          const cell = row.cells[c];
          const style = { width: column.width };
          const role = c === 0 ? "rowheader" : "gridcell";
          return typeof cell === "function" ? (
            <div key={column.id} role={role} className={classes.timelineCell} style={style}>
              {cell(roving(c))}
            </div>
          ) : (
            <div key={column.id} role={role} className={classes.timelineCell} style={style} {...roving(c)}>
              {cell}
            </div>
          );
        })}
      </div>
      <div role="gridcell" className={classes.timelineTrack} style={{ width: scale.totalWidth, backgroundImage: hatch ?? undefined }}>
        {row.draw !== undefined && <TimelineDrawSurface draw={row.draw} scale={scale} />}
        {row.bands?.map((band) => <TimelineBand key={band.id} band={band} scale={scale} />)}
        {row.track ??
          row.bars.map((bar, b) => (
            <TimelineBar
              key={bar.id}
              bar={bar}
              scale={scale}
              roving={(offset) => roving(columns.length + b * COLUMNS_PER_BAR + offset)}
            />
          ))}
      </div>
    </div>
  );
}
