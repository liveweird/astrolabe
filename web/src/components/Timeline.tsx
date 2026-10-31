import { useEffect, useLayoutEffect, useRef, type CSSProperties, type KeyboardEvent, type ReactNode } from "react";
import { Stack } from "@mantine/core";
import { useDndContext, useDroppable } from "@dnd-kit/core";
import { useVirtualizer } from "@tanstack/react-virtual";
import { TIMELINE_DROP_ID, type DropZoneData } from "../hooks/useTimelinePreview";
import { useRovingGrid } from "../hooks/useRovingGrid";
import {
  BAR_HEIGHT,
  BAR_INSET,
  DEFAULT_VIRTUALIZE_FROM,
  HEADER_HEIGHT,
  hasColumn,
  lastColumn,
  OVERSCAN_ROWS,
  ROW_HEIGHT,
  type TimelineBandData,
  type TimelineColumn,
  type TimelineGeometry,
  type TimelineRowData,
} from "../utils/timelineModel";
import { scrollLeftToCenter, toEpochDay, weekendBackground, type TimelineScale, type Zoom } from "../utils/timelineScale";
import ScrollRegion from "./ScrollRegion";
import TimelineHeader from "./TimelineHeader";
import TimelineRow, { TimelineBand } from "./TimelineRow";
import TimelineToolbar from "./TimelineToolbar";
import classes from "../theme.module.css";

export interface TimelineProps {
  /** The grid's accessible name (the heading above it). */
  label: string;
  /** The page-built scale (zoom and range). The page keeps the range stable across edits. */
  scale: TimelineScale;
  onZoomChange: (zoom: Zoom) => void;
  /** Today as `YYYY-MM-DD` (injected so tests and the zone choice stay the page's). */
  today: string;
  columns: readonly TimelineColumn[];
  rows: readonly TimelineRowData[];
  /** Bands spanning every row (the project's target window). */
  bands?: readonly TimelineBandData[];
  /** Drawn over the body as one `pointer-events: none` svg, from data-derived geometry (v0.4 dependency arrows). */
  overlay?: (geometry: TimelineGeometry) => ReactNode;
  /** More rows than this are virtualised; fewer or equal are all mounted. */
  virtualizeFrom?: number;
  maxHeight?: number | string;
  /** A save is in flight (the page ignores further changes until it answers). */
  busy?: boolean;
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
  onZoomChange,
  today,
  columns,
  rows,
  bands = [],
  overlay,
  virtualizeFrom = DEFAULT_VIRTUALIZE_FROM,
  maxHeight = 640,
  busy = false,
}: TimelineProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const pendingFocus = useRef<{ r: number; c: number } | null>(null);
  const { active: dragging } = useDndContext();
  const leftWidth = columns.reduce((sum, column) => sum + column.width, 0);
  // The drop zone is as large as every row; a tray drop only counts inside what the scroller actually shows of it.
  const zoneData: DropZoneData = {
    visibleBounds: () => {
      const rect = scrollRef.current?.getBoundingClientRect();
      return rect === undefined ? null : { left: rect.left + leftWidth, right: rect.right, top: rect.top + HEADER_HEIGHT, bottom: rect.bottom };
    },
  };
  const { setNodeRef: dropRef } = useDroppable({ id: TIMELINE_DROP_ID, data: zoneData });
  const virtual = rows.length > virtualizeFrom;
  // TanStack Virtual returns a stable mutable instance the React compiler cannot memoise around; nothing here is memoised on it.
  // eslint-disable-next-line react-hooks/incompatible-library -- see above
  const virtualizer = useVirtualizer({
    count: virtual ? rows.length : 0,
    enabled: virtual,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: OVERSCAN_ROWS,
    scrollMargin: HEADER_HEIGHT,
    // scrollToIndex must land the row below the sticky header, not under it
    scrollPaddingStart: HEADER_HEIGHT,
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

  // Scrolled-to rows mount a frame later: focus the wanted cell (or the nearest to its left) as soon as it exists.
  useLayoutEffect(() => {
    const wanted = pendingFocus.current;
    const root = grid.ref.current;
    if (wanted === null || root === null) return;
    for (let c = wanted.c; c >= 0; c -= 1) {
      const cell = root.querySelector<HTMLElement>(`[data-grid-pos="${wanted.r},${c}"]`);
      if (cell !== null) {
        pendingFocus.current = null;
        cell.focus();
        return;
      }
    }
  });

  // A wish to focus a row that has not mounted yet must not outlive the user's intent: any other key, a focus elsewhere or a
  // scroll by hand (wheel, touch, pointer, keys on the scroller itself) drops it, so it cannot steal focus later.
  useEffect(() => {
    const scroller = scrollRef.current;
    const cancel = () => {
      pendingFocus.current = null;
    };
    const cancelOnScroller = (event: Event) => {
      if (event.type !== "keydown" || event.target === scroller) cancel();
    };
    const focusElsewhere = (event: FocusEvent) => {
      if (!grid.ref.current?.contains(event.target as Node)) cancel();
    };
    const events = ["wheel", "touchmove", "pointerdown", "keydown"];
    events.forEach((name) => scroller?.addEventListener(name, cancelOnScroller, { passive: true }));
    document.addEventListener("focusin", focusElsewhere);
    return () => {
      events.forEach((name) => scroller?.removeEventListener(name, cancelOnScroller));
      document.removeEventListener("focusin", focusElsewhere);
    };
  }, [grid.ref]);

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

  const todayDay = toEpochDay(today);
  const todayInRange = todayDay >= scale.from && todayDay <= scale.to;
  const scrollToToday = () => {
    const scroller = scrollRef.current;
    if (scroller !== null) scroller.scrollLeft = scrollLeftToCenter(scale, todayDay, scroller.clientWidth, leftWidth);
  };

  const hatch = weekendBackground(scale);
  const bodyHeight = rows.length * ROW_HEIGHT;
  const trackLeft = { left: leftWidth };

  const geometry: TimelineGeometry | null =
    overlay === undefined
      ? null
      : {
          scale,
          xOf: (iso) => scale.xOf(toEpochDay(iso)),
          rowTop: (index) => index * ROW_HEIGHT,
          rowHeight: ROW_HEIGHT,
          visibleRows: { first, last },
          barRect: (index, barId) => {
            const bar = rows[index]?.bars.find((candidate) => candidate.id === barId);
            if (bar === undefined) return null;
            const start = toEpochDay(bar.start);
            return { x: scale.xOf(start), y: index * ROW_HEIGHT + BAR_INSET, width: scale.widthOf(start, toEpochDay(bar.end)), height: BAR_HEIGHT };
          },
        };

  const gridStyle = { width: leftWidth + scale.totalWidth, "--timeline-left": `${leftWidth}px` } as CSSProperties;

  return (
    <Stack gap="xs">
      <TimelineToolbar zoom={scale.zoom} onZoomChange={onZoomChange} onToday={scrollToToday} todayDisabled={!todayInRange} />
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
            grid.onFocus(event);
          }}
        >
          <TimelineHeader scale={scale} columns={columns} leftWidth={leftWidth} today={today} />
          <div role="rowgroup" style={{ position: "relative", height: bodyHeight }}>
            {bands.map((band) => (
              <div key={band.id} style={{ position: "absolute", top: 0, bottom: 0, ...trackLeft }}>
                <TimelineBand band={band} scale={scale} />
              </div>
            ))}
            {todayInRange && <div aria-hidden="true" className={classes.timelineToday} style={{ left: leftWidth + scale.xOf(todayDay) + scale.dayWidth / 2 }} />}
            <div ref={dropRef} aria-hidden="true" style={{ position: "absolute", top: 0, height: bodyHeight, width: scale.totalWidth, pointerEvents: "none", ...trackLeft }} />
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
