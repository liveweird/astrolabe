import { useTranslation } from "react-i18next";
import { HEADER_ROW_HEIGHT, type TimelineColumn } from "../utils/timelineModel";
import { headerRows, toEpochDay, type HeaderCell, type TimelineScale } from "../utils/timelineScale";
import classes from "../theme.module.css";

function HeaderCells({ cells, scale }: { cells: readonly HeaderCell[]; scale: TimelineScale }) {
  return cells.map((cell) => (
    <div
      key={cell.key}
      className={`${classes.timelineHeadCell} ${cell.weekend ? classes.timelineHeadWeekend : ""}`}
      style={{ left: scale.xOf(cell.from), width: scale.widthOf(cell.from, cell.to) }}
    >
      {cell.label}
    </div>
  ));
}

/**
 * The sticky header: a group row (weeks / months / quarters; with the today tag) over a cell row (days / weeks / months), both
 * clipped to the range. The group row is decoration; the cell row is the grid's one header `row` — it names the left columns
 * (the bars' dates are in each bar's accessible name, so the date cells are `aria-hidden` too).
 */
export default function TimelineHeader({
  scale,
  columns,
  leftWidth,
  today,
}: {
  scale: TimelineScale;
  columns: readonly TimelineColumn[];
  leftWidth: number;
  today: string;
}) {
  const { t } = useTranslation();
  const { groups, cells } = headerRows(scale);
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
    </div>
  );
}
