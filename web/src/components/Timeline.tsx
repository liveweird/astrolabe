import { useImperativeHandle, useRef, type CSSProperties, type KeyboardEvent, type ReactNode, type Ref } from "react";
import { Stack, Text, VisuallyHidden } from "@mantine/core";
import { useTranslation } from "react-i18next";
import { useDndContext } from "@dnd-kit/core";
import { useVirtualizer } from "@tanstack/react-virtual";
import { useRovingGrid } from "../hooks/useRovingGrid";
import { useTimelineDropZones } from "../hooks/useTimelineDropZones";
import { useTimelinePendingFocus } from "../hooks/useTimelinePendingFocus";
import {
  DEFAULT_VIRTUALIZE_FROM,
  hasColumn,
  headerHeight,
  lastColumn,
  MIN_BODY_ROWS,
  OVERSCAN_ROWS,
  ROW_HEIGHT,
  type TimelineBandData,
  type TimelineColumn,
  type TimelineGeometry,
  type TimelineRowData,
  type TimelineStripData,
} from "../utils/timelineModel";
import { buildTimelineGeometry } from "../utils/timelineGeometry";
import { revealFocused } from "../utils/timelineReveal";
import {
  holidayDayMap,
  holidayListing,
  holidaysShown,
  MILESTONE_ZOOMS,
  scrollLeftToCenter,
  toEpochDay,
  trackBackground,
  type TimelineHoliday,
  type TimelineScale,
  type Zoom,
} from "../utils/timelineScale";
import ScrollRegion from "./ScrollRegion";
import TimelineHeader from "./TimelineHeader";
import TimelineRowDropIndicator from "./TimelineRowDropIndicator";
import TimelineRow, { TimelineBand } from "./TimelineRow";
import TimelineToolbar from "./TimelineToolbar";
import classes from "../theme.module.css";

/** What a page can ask of a mounted Timeline (`ref`): move the keyboard focus to a row, whether or not the virtual path has mounted it. */
export interface TimelineHandle {
  /**
   * Focus the row-header cell of the row with this `TimelineRowData.id` and reveal it clear of the sticky parts (a programmatic focus after a
   * click is not `:focus-visible`, so the grid's own reveal would skip it). A row the virtual path has not mounted is scrolled to and focused
   * once it mounts. An unknown id does nothing.
   */
  focusRow: (rowId: number | string) => void;
}

export interface TimelineProps {
  /** The grid's accessible name (the heading above it). */
  label: string;
  /** The page-built scale (zoom and range). The page keeps the range stable across edits. */
  scale: TimelineScale;
  /** The zooms the toolbar offers (default `MILESTONE_ZOOMS`: week / month / quarter; the plan pages pass `PLAN_ZOOMS`). */
  zooms?: readonly Zoom[];
  onZoomChange: (zoom: Zoom) => void;
  /** Today as `YYYY-MM-DD` (injected so tests and the zone choice stay the page's). */
  today: string;
  columns: readonly TimelineColumn[];
  rows: readonly TimelineRowData[];
  /** Bands spanning every row (the project's target window). */
  bands?: readonly TimelineBandData[];
  /** Drawn over the body as one `pointer-events: none` svg, from data-derived geometry (the dependency arrows). */
  overlay?: (geometry: TimelineGeometry) => ReactNode;
  /**
   * A third, sticky header row under the date cells (the team's weekly load strip). Decorative: the page's table is the accessible
   * surface. It makes the header taller, which every sticky-header consumer follows (`headerHeight`, `--timeline-head`).
   */
  strip?: TimelineStripData;
  /**
   * The public holidays (the dictionary's `{date, name}` rows, any range): at week and month zoom a holiday working day is hatched
   * like a weekend (a second gradient layer on the row), at week zoom its header day cell is tinted and named in its `title`, and a visually
   * hidden paragraph lists the ones in view (the header and the tracks are `aria-hidden`).
   */
  holidays?: readonly TimelineHoliday[];
  /** The dictionary could not be loaded, so `holidays` is empty for want of it: a small muted note says the days off are not marked. */
  holidaysFailed?: boolean;
  /** The page's own toolbar controls (the project page's critical-path toggle), rendered after Today inside the toolbar group. */
  toolbar?: ReactNode;
  /** More rows than this are virtualised; fewer or equal are all mounted. */
  virtualizeFrom?: number;
  maxHeight?: number | string;
  /** A save is in flight (the page ignores further changes until it answers). */
  busy?: boolean;
  /** The imperative handle ({@link TimelineHandle}); a plain prop in React 19. */
  ref?: Ref<TimelineHandle>;
}

/** `r,c` of the roving element holding the event target. */
function gridPosOf(event: KeyboardEvent<HTMLElement>): { r: number; c: number } | null {
  const raw = (event.target as HTMLElement).closest<HTMLElement>("[data-grid-pos]")?.dataset.gridPos;
  if (raw === undefined) return null;
  const [r, c] = raw.split(",").map(Number);
  return { r, c };
}

/**
 * The shared timeline frame: toolbar, a sticky header, rows of [sticky left cells | track], the range-wide bands, the today
 * line and the overlay slot, in a labelled scroll region. It draws and proposes — bars are dragged inside the page's
 * `TimelineDndContext`, which reports the new dates; nothing here writes. ONE roving tab stop (`useRovingGrid`): ↑/↓ rows, ←/→
 * cells (left cells, then each bar, its start handle, its end handle). Above `virtualizeFrom` rows only a window of them is
 * mounted (TanStack Virtual); ↑/↓ and Ctrl+Home/End then scroll to a row that is not mounted and focus it once it is.
 * `.claude/docs/timeline.md` is the binding reference.
 */
export default function Timeline({
  label,
  scale,
  zooms = MILESTONE_ZOOMS,
  onZoomChange,
  today,
  columns,
  rows,
  bands = [],
  overlay,
  strip,
  holidays,
  holidaysFailed = false,
  toolbar,
  virtualizeFrom = DEFAULT_VIRTUALIZE_FROM,
  maxHeight = 640,
  busy = false,
  ref,
}: TimelineProps) {
  const { t } = useTranslation();
  const scrollRef = useRef<HTMLDivElement>(null);
  const { active: dragging } = useDndContext();
  const leftWidth = columns.reduce((sum, column) => sum + column.width, 0);
  // The sticky header's height: the ONE number the drop zone, the virtualiser, the reveal and the CSS scroll margins all follow.
  const head = headerHeight(strip !== undefined);
  const { zoneRef, rowZoneRef } = useTimelineDropZones({ scrollRef, head, leftWidth, rowCount: rows.length });
  const virtual = rows.length > virtualizeFrom;
  // TanStack Virtual returns a stable mutable instance the React compiler cannot memoise around; nothing here is memoised on it.
  // eslint-disable-next-line react-hooks/incompatible-library -- see above
  const virtualizer = useVirtualizer({
    count: virtual ? rows.length : 0,
    enabled: virtual,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: OVERSCAN_ROWS,
    scrollMargin: head,
    // scrollToIndex must land the row below the sticky header, not under it
    scrollPaddingStart: head,
  });
  const windowItems = virtual ? virtualizer.getVirtualItems() : null;
  const first = windowItems === null ? 0 : (windowItems[0]?.index ?? 0);
  const last = windowItems === null ? rows.length - 1 : (windowItems[windowItems.length - 1]?.index ?? -1);
  const mountedIndexes = windowItems === null ? rows.map((_, index) => index) : windowItems.map((item) => item.index);

  const lastCol = lastColumn(rows, columns.length);
  const grid = useRovingGrid<HTMLDivElement>({
    bounds: { rMin: 1, rMax: rows.length, cMax: lastCol },
    // A position is a stop only if its row is mounted and has that column (a read-only row has no handles).
    isValid: ({ r, c }) => r - 1 >= first && r - 1 <= last && hasColumn(rows[r - 1], columns.length, c),
    fallback: { r: first + 1, c: 0 },
  });

  const pendingFocus = useTimelinePendingFocus(scrollRef, grid.ref);

  /** ↑/↓ and Ctrl+Home/End aimed at a row that is not mounted: scroll to it and let the layout effect focus it. */
  const jumpToUnmountedRow = (event: KeyboardEvent<HTMLElement>): boolean => {
    const from = gridPosOf(event);
    if (from === null || event.altKey || event.metaKey) return false;
    let target: number | null = null;
    let column = from.c;
    if (event.key === "ArrowDown") target = from.r + 1;
    else if (event.key === "ArrowUp") target = from.r - 1;
    else if (event.ctrlKey && event.key === "End") [target, column] = [rows.length, lastCol];
    else if (event.ctrlKey && event.key === "Home") [target, column] = [1, 0];
    if (target === null || target < 1 || target > rows.length || (target - 1 >= first && target - 1 <= last)) return false;
    event.preventDefault();
    pendingFocus.current = { r: target, c: column };
    virtualizer.scrollToIndex(target - 1);
    return true;
  };

  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    pendingFocus.current = null;
    // While a bar is held, dnd-kit's keyboard sensor owns the arrows.
    if (dragging !== null) return;
    if (virtual && jumpToUnmountedRow(event)) return;
    grid.onKeyDown(event);
  };

  const reveal = (target: HTMLElement, force = false) => revealFocused(scrollRef.current, target, head, leftWidth, force);

  useImperativeHandle(
    ref,
    () => ({
      focusRow: (rowId) => {
        const index = rows.findIndex((candidate) => candidate.id === rowId);
        if (index < 0) return;
        if (index >= first && index <= last) {
          const cell = grid.ref.current?.querySelector<HTMLElement>(`[data-grid-pos="${index + 1},0"]`);
          if (cell === null || cell === undefined) return;
          cell.focus();
          reveal(cell, true);
          return;
        }
        // Not mounted (the virtual path): scroll to it and let the pending-focus layout effect (useTimelinePendingFocus) focus it as soon as it exists.
        pendingFocus.current = { r: index + 1, c: 0 };
        virtualizer.scrollToIndex(index);
      },
    }),
  );

  const todayDay = toEpochDay(today);
  const todayInRange = todayDay >= scale.from && todayDay <= scale.to;
  const scrollToToday = () => {
    const scroller = scrollRef.current;
    if (scroller !== null) scroller.scrollLeft = scrollLeftToCenter(scale, todayDay, scroller.clientWidth, leftWidth);
  };

  const holidayByDay = holidayDayMap(holidays ?? []);
  const hatch = trackBackground(scale, holidayByDay);
  const listing = holidayListing(holidaysShown(scale, holidayByDay), today);
  const listed = listing.listed.map((holiday) => `${holiday.date} ${holiday.name}`).join(", ");
  const bodyHeight = Math.max(rows.length, MIN_BODY_ROWS) * ROW_HEIGHT;
  const trackLeft = { left: leftWidth };

  const geometry = overlay === undefined ? null : buildTimelineGeometry(rows, scale, { first, last });

  const gridStyle = { width: leftWidth + scale.totalWidth, "--timeline-left": `${leftWidth}px`, "--timeline-head": `${head}px` } as CSSProperties;

  return (
    <Stack gap="xs">
      <TimelineToolbar zoom={scale.zoom} zooms={zooms} onZoomChange={onZoomChange} onToday={scrollToToday} todayDisabled={!todayInRange}>
        {toolbar}
      </TimelineToolbar>
      {holidaysFailed && (
        <Text size="xs" c="dimmed">
          {t("timeline.holidaysUnavailable")}
        </Text>
      )}
      {listing.count > 0 && (
        <VisuallyHidden component="p">
          {listing.truncated
            ? t("timeline.holidaysInViewMany", { count: listing.count, list: listed })
            : t("timeline.holidaysInView", { list: listed })}
        </VisuallyHidden>
      )}
      <ScrollRegion label={label} minWidth={leftWidth + scale.totalWidth} maxHeight={maxHeight} scrollRef={scrollRef}>
        <div
          ref={grid.ref}
          role="grid"
          aria-label={label}
          aria-rowcount={rows.length + 1}
          aria-busy={busy}
          className={classes.timelineGrid}
          style={gridStyle}
          onKeyDown={onKeyDown}
          onFocus={(event) => {
            pendingFocus.current = null;
            reveal(event.target as HTMLElement);
            grid.onFocus(event);
          }}
        >
          <TimelineHeader scale={scale} columns={columns} leftWidth={leftWidth} today={today} strip={strip} holidays={holidayByDay} />
          <div role="rowgroup" style={{ position: "relative", height: bodyHeight }}>
            {bands.map((band) => (
              <div key={band.id} style={{ position: "absolute", top: 0, bottom: 0, ...trackLeft }}>
                <TimelineBand band={band} scale={scale} />
              </div>
            ))}
            {todayInRange && <div aria-hidden="true" className={classes.timelineToday} style={{ left: leftWidth + scale.xOf(todayDay) + scale.dayWidth / 2 }} />}
            <div ref={zoneRef} aria-hidden="true" style={{ position: "absolute", top: 0, height: bodyHeight, width: scale.totalWidth, pointerEvents: "none", ...trackLeft }} />
            <div ref={rowZoneRef} aria-hidden="true" style={{ position: "absolute", top: 0, left: 0, height: bodyHeight, width: leftWidth + scale.totalWidth, pointerEvents: "none" }} />
            {mountedIndexes.map((index) => (
              <TimelineRow
                key={rows[index].id}
                row={rows[index]}
                index={index}
                scale={scale}
                columns={columns}
                leftWidth={leftWidth}
                active={grid.active}
                hatch={hatch}
                top={virtual ? index * ROW_HEIGHT : undefined}
              />
            ))}
            <TimelineRowDropIndicator width={leftWidth + scale.totalWidth} />
            {geometry !== null && overlay !== undefined && (
              <svg aria-hidden="true" className={classes.timelineOverlay} style={{ ...trackLeft, width: scale.totalWidth, height: bodyHeight }}>
                {overlay(geometry)}
              </svg>
            )}
          </div>
        </div>
      </ScrollRegion>
    </Stack>
  );
}
