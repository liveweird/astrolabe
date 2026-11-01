import { useTranslation } from "react-i18next";
import { HEADER_ROW_HEIGHT, STRIP_HEIGHT, type TimelineColumn, type TimelineStripData } from "../utils/timelineModel";
import { headerRows, toEpochDay, type HeaderCell, type TimelineScale } from "../utils/timelineScale";
import classes from "../theme.module.css";

function HeaderCells({ cells, scale }: { cells: readonly HeaderCell[]; scale: TimelineScale }) {
  const { t } = useTranslation();
  return cells.map((cell) => (
    <div
      key={cell.key}
      className={`${classes.timelineHeadCell} ${cell.weekend || cell.holiday !== undefined ? classes.timelineHeadWeekend : ""}`}
      title={cell.holiday === undefined ? undefined : t("timeline.holidayTitle", { name: cell.holiday })}
      data-holiday={cell.holiday === undefined ? undefined : "true"}
      style={{ left: scale.xOf(cell.from), width: scale.widthOf(cell.from, cell.to) }}
    >
      {cell.label}
    </div>
  ));
}

/**
 * The sticky header: a group row (weeks / months / quarters; with the today tag) over a cell row (days / weeks / months), both
 * clipped to the range. The group row is decoration; the cell row is the grid's one header `row` — it names the left columns
 * (the bars' dates are in each bar's accessible name, so the date cells are `aria-hidden` too). An optional third row, the page's
 * `strip` (the load strip), sits under them: a sticky caption over a track part; decorative, like the group row.
 */
export default function TimelineHeader({
  scale,
  columns,
  leftWidth,
  today,
  strip,
  holidays,
}: {
  scale: TimelineScale;
  columns: readonly TimelineColumn[];
  leftWidth: number;
  today: string;
  strip?: TimelineStripData;
  /** Public holidays by epoch day: a day cell on one is tinted like a weekend and carries the holiday's name as its `title`. */
  holidays?: ReadonlyMap<number, string>;
}) {
  const { t } = useTranslation();
  const { groups, cells } = headerRows(scale, holidays);
  const todayDay = toEpochDay(today);
  const todayVisible = todayDay >= scale.from && todayDay <= scale.to;
  const trackStyle = { width: scale.totalWidth, height: HEADER_ROW_HEIGHT };

  return (
    <div role="rowgroup" className={classes.timelineHead}>
      <div className={classes.timelineHeadRow} aria-hidden="true">
        <div className={classes.timelineLeft} style={{ width: leftWidth }} />
        <div className={classes.timelineTrack} style={trackStyle}>
          <HeaderCells cells={groups} scale={scale} />
          {todayVisible && (
            <span className={classes.timelineTodayTag} style={{ left: scale.xOf(todayDay) + scale.dayWidth / 2 }}>
              {t("timeline.todayTag")}
            </span>
          )}
        </div>
      </div>
      <div role="row" aria-rowindex={1} className={classes.timelineHeadRow}>
        <div role="presentation" className={classes.timelineLeft} style={{ width: leftWidth }}>
          {columns.map((column) => (
            <div
              key={column.id}
              role="columnheader"
              className={`${classes.timelineCell} ${classes.timelineHeadCaption}`}
              style={{ width: column.width }}
            >
              {column.header}
            </div>
          ))}
        </div>
        <div className={classes.timelineTrack} style={trackStyle} aria-hidden="true">
          <HeaderCells cells={cells} scale={scale} />
        </div>
      </div>
      {strip !== undefined && (
        <div className={`${classes.timelineHeadRow} ${classes.timelineStripRow}`} aria-hidden="true">
          <div className={classes.timelineLeft} style={{ width: leftWidth }}>
            <div className={`${classes.timelineCell} ${classes.timelineHeadCaption}`} style={{ width: leftWidth }}>
              {strip.label}
            </div>
          </div>
          <div className={classes.timelineTrack} style={{ width: scale.totalWidth, height: STRIP_HEIGHT }}>
            {strip.render(scale)}
          </div>
        </div>
      )}
    </div>
  );
}
