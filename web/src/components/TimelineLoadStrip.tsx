import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import { formatMd, stripCells, type LoadWeek, type StripCell } from "../utils/timelineLoad";
import type { TimelineScale } from "../utils/timelineScale";
import classes from "../theme.module.css";

/** The cell's full sentence (`title`): the figures, the peak of milestones in progress and, when flagged, the WIP verdict and the Flow capacity note. */
function titleOf(t: TFunction, cell: StripCell): string {
  const base =
    cell.capacity === null
      ? t("timeline.strip.cellNoCapacity", { week: cell.weekStart, load: formatMd(cell.load) })
      : t("timeline.strip.cell", { week: cell.weekStart, load: formatMd(cell.load), capacity: formatMd(cell.capacity) });
  const wip = cell.maxWip > 0 ? t("timeline.strip.wip", { count: cell.maxWip }) : "";
  const flow = cell.flowCapacity === null ? "" : t("timeline.strip.flowCapacity");
  return `${base}${wip}${cell.wipExceeded ? t("timeline.strip.wipExceeded") : ""}${flow}`;
}

/**
 * The weekly load, drawn into the Timeline's `strip` slot: one cell per ISO week at `scale.xOf(weekStart)`. The column rises from
 * the baseline to load / capacity of 24 px (the hairline across the cell is the capacity; a column past it is the overload — orange,
 * a warning); a week with NO capacity has no column and no line, only its figure, dimmed. A week over the WIP limit also carries a
 * small dashed chip (a dot at quarter zoom) — a shape, not a hue, tells it from the overload. A week whose sprint's capacity differs from
 * Flow (1.9) carries a corner mark in the top-left, again a SHAPE per severity: a solid orange triangle for a warning, a hollow gray ring for an
 * info. Decorative (the header row is
 * `aria-hidden`): the page's weekly table is the accessible surface, so nothing here is named, focusable or announced.
 * `data-week`/`data-overloaded`/`data-wip-exceeded`/`data-flow-capacity` (and the `data-part` of each mark) are what tests and e2e read — never colour.
 */
export default function TimelineLoadStrip({ weeks, scale }: { weeks: readonly LoadWeek[]; scale: TimelineScale }) {
  const { t } = useTranslation();
  return stripCells(weeks, scale).map((cell) => (
    <div
      key={cell.weekStart}
      className={classes.timelineStripCell}
      style={{ left: cell.x, width: cell.width }}
      title={titleOf(t, cell)}
      data-week={cell.weekStart}
      data-overloaded={cell.overloaded}
      data-wip-exceeded={cell.wipExceeded}
      data-flow-capacity={cell.flowCapacity ?? undefined}
    >
      {cell.hasCapacity && <span className={classes.timelineStripLine} data-part="capacity-line" />}
      {cell.fillHeight > 0 && (
        <span
          className={`${classes.timelineStripFill} ${cell.overloaded ? classes.timelineStripFillOverloaded : ""}`}
          data-part="fill"
          style={{ height: cell.fillHeight }}
        />
      )}
      {cell.text !== "" && (
        <span className={`${classes.timelineStripText} ${cell.hasCapacity ? "" : classes.timelineStripTextDim}`} data-part="figure">
          {cell.text}
        </span>
      )}
      {cell.wipExceeded && (
        <span className={`${classes.timelineStripWip} ${cell.wipText === "" ? classes.timelineStripWipDot : ""}`} data-part="wip">
          {cell.wipText}
        </span>
      )}
      {cell.flowCapacity !== null && (
        <span
          className={cell.flowCapacity === "WARNING" ? classes.timelineStripFlowWarning : classes.timelineStripFlowInfo}
          data-part="flow-capacity"
          data-severity={cell.flowCapacity}
        />
      )}
    </div>
  ));
}
