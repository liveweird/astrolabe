import { createRef, useEffect, type ComponentProps, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import userEvent from "@testing-library/user-event";
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { DndContext, useDndContext } from "@dnd-kit/core";
import Timeline, { type TimelineHandle } from "./Timeline";
import TimelineArrows from "./TimelineArrows";
import TimelineDndContext from "./TimelineDndContext";
import TimelineLoadStrip from "./TimelineLoadStrip";
import TimelineUnscheduledTray, { type TrayItem } from "./TimelineUnscheduledTray";
import { TIMELINE_DROP_ID, TIMELINE_ROW_DROP_ID } from "../hooks/useTimelinePreview";
import { verticalOnly } from "../utils/timelineDrag";
import {
  headerHeight,
  type TimelineArrowData,
  type TimelineBarData,
  type TimelineColumn,
  type TimelineGeometry,
  type TimelineRowData,
  type TimelineStripData,
} from "../utils/timelineModel";
import { makeScale, PLAN_ZOOMS, toEpochDay, type Zoom } from "../utils/timelineScale";
import { renderWithProviders } from "../test/render";

// happy-dom has no layout, so a pointer drag cannot run here (e2e drives the real one). The context is wrapped to hand the test
// its handlers and announcements: what happens WHEN dnd-kit reports a gesture is ours to pin.
let dndProps: ComponentProps<typeof DndContext> | null = null;
// The real DragOverlay renders only while dnd-kit itself holds an active node, which fed events never set up: the stand-in renders its
// children in place (so the held row's card can be read) and records the props the context gave it.
let overlayProps: { modifiers?: unknown[]; dropAnimation?: unknown } | null = null;
let realOverlay = false;
vi.mock("@dnd-kit/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@dnd-kit/core")>();
  return {
    ...actual,
    DndContext: (props: ComponentProps<typeof actual.DndContext>) => {
      dndProps = props;
      return <actual.DndContext {...props} />;
    },
    DragOverlay: (props: ComponentProps<typeof actual.DragOverlay>) => {
      overlayProps = props;
      // `realOverlay` lets a test run the REAL one: it is what proves a bar drag mounts no overlay wrapper at all
      return realOverlay ? <actual.DragOverlay {...props} /> : <div data-testid="drag-overlay">{props.children}</div>;
    },
  };
});

const DAY = 28;
const COLUMNS: TimelineColumn[] = [
  { id: "name", header: "Milestone", width: 160 },
  { id: "team", header: "Team", width: 100 },
];

const bar = (id: number, name: string, start: string, end: string, editable = true): TimelineBarData => ({
  id,
  start,
  end,
  label: name,
  describe: `${name}, Team A, ${start} to ${end}`,
  editable,
});

const row = (id: number, name: string, bars: TimelineBarData[]): TimelineRowData => ({ id, cells: [name, "Team A"], bars });

const DISCOVERY = bar(1, "Discovery", "2026-09-16", "2026-09-18");
const BUILD = bar(2, "Build", "2026-09-21", "2026-09-25", false);
const ROWS = [row(1, "Discovery", [DISCOVERY]), row(2, "Build", [BUILD]), row(3, "Launch", [])];

const scaleOf = (zoom: Zoom = "week", from = "2026-09-14", to = "2026-10-11") => makeScale(zoom, { from: toEpochDay(from), to: toEpochDay(to) });

function Harness({
  rows = ROWS,
  zoom = "week",
  onSchedule = vi.fn(() => true),
  onReorder,
  onZoomChange = vi.fn(),
  probe,
  ...rest
}: Partial<Omit<ComponentProps<typeof Timeline>, "scale">> & {
  /** Rendered beside the Timeline, inside the drag context (to read dnd-kit's state). */
  probe?: ReactNode;
  zoom?: Zoom;
  onSchedule?: (id: number | string, start: string, end: string) => boolean;
  onReorder?: (id: number | string, slot: number) => boolean;
}) {
  const scale = scaleOf(zoom);
  return (
    <TimelineDndContext scale={scale} onSchedule={onSchedule} onReorder={onReorder}>
      <Timeline label="Project timeline" scale={scale} onZoomChange={onZoomChange} today="2026-09-23" columns={COLUMNS} rows={rows} {...rest} />
      {probe}
    </TimelineDndContext>
  );
}

const active = (kind: string, bar: TimelineBarData = DISCOVERY) => ({
  id: `bar:${bar.id}:${kind}`,
  data: { current: { kind, barId: bar.id, label: bar.label, start: bar.start, end: bar.end } },
});
const trayActive = { id: "tray:9", data: { current: { kind: "tray", barId: 9, label: "Rollout" } } };
// The zone data the real droppable publishes: its left edge and the scroller's visible part, both read at the moment of the drop.
const zone = (left: number, visibleBounds: () => unknown = () => null) => ({ id: TIMELINE_DROP_ID, data: { current: { zoneLeft: () => left, visibleBounds } } });
const EVERYWHERE = () => ({ left: 0, right: 5000, top: 0, bottom: 5000 });
const trayStart = (clientX: number, clientY = 0) => ({ active: trayActive, delta: { x: 0, y: 0 }, over: null, activatorEvent: { clientX, clientY } });


type Handler = "onDragStart" | "onDragMove" | "onDragEnd" | "onDragCancel";
const emit = (name: Handler, event: unknown) => act(() => (dndProps?.[name] as ((e: unknown) => void) | undefined)?.(event));
const gesture = (a: ReturnType<typeof active>, days: number, over: unknown = null) => ({
  active: a,
  delta: { x: days * DAY, y: 0 },
  over,
  activatorEvent: null,
});

const barBody = (name: string) => screen.getByRole("button", { name });
const geometryOf = (element: HTMLElement) => {
  const wrapper = element.parentElement as HTMLElement;
  return { left: wrapper.style.left, width: wrapper.style.width };
};

beforeEach(() => {
  dndProps = null;
  overlayProps = null;
  realOverlay = false;
});
// Every stub a test installs is undone here, pass or fail (the suite shares one registry: isolate is off).
afterEach(() => {
  unstubViewport();
  vi.useRealTimers();
});

/** happy-dom lays nothing out: give the scroller a size for the code that reads it (the virtualiser, "Today"). */
const VIEWPORT_PROPS = ["clientWidth", "clientHeight"] as const;
const originals = VIEWPORT_PROPS.map((name) => [name, Object.getOwnPropertyDescriptor(HTMLElement.prototype, name)] as const);
function stubViewport(width: number, height: number) {
  for (const [name, value] of [["clientWidth", width], ["clientHeight", height]] as const) {
    Object.defineProperty(HTMLElement.prototype, name, { configurable: true, get: () => value });
  }
}
function unstubViewport() {
  for (const [name, descriptor] of originals) {
    if (descriptor === undefined) delete (HTMLElement.prototype as unknown as Record<string, unknown>)[name];
    else Object.defineProperty(HTMLElement.prototype, name, descriptor);
  }
}

describe("Timeline frame", () => {
  test("draws a bar at left = xOf(start) and width = days x 28 px", () => {
    renderWithProviders(<Harness />);
    // 2026-09-16 is two days after the range start; Wed-Fri is three days
    expect(geometryOf(barBody("Discovery, Team A, 2026-09-16 to 2026-09-18"))).toEqual({ left: "56px", width: "84px" });
  });

  test("is a labelled grid in a labelled scroll region, with a header row and a row per item", () => {
    renderWithProviders(<Harness />);
    const grid = screen.getByRole("grid", { name: "Project timeline" });
    expect(screen.getByRole("region", { name: "Project timeline" })).toContainElement(grid);
    expect(grid).toHaveAttribute("aria-rowcount", "4");
    const rows = within(grid).getAllByRole("row");
    expect(rows.map((r) => r.getAttribute("aria-rowindex"))).toEqual(["1", "2", "3", "4"]);
    expect(within(grid).getAllByRole("columnheader").map((h) => h.textContent)).toEqual(["Milestone", "Team"]);
    expect(within(grid).getByRole("rowheader", { name: "Discovery" })).toBeInTheDocument();
  });

  test("an empty or nearly empty timeline keeps a body tall enough to drop an Unscheduled item on", () => {
    const { unmount } = renderWithProviders(<Harness rows={[]} />);
    const bodyHeight = () => screen.getAllByRole("rowgroup").map((group) => group.style.height).find((height) => height !== "");
    expect(bodyHeight()).toBe("108px");
    unmount();
    renderWithProviders(<Harness rows={[ROWS[0]]} />);
    expect(bodyHeight()).toBe("108px");
  });

  test("the header shows ISO-week groups and day numbers at week zoom, months and weeks at month zoom", () => {
    const { unmount } = renderWithProviders(<Harness />);
    expect(screen.getByText("W38 2026")).toBeInTheDocument();
    expect(screen.getByText("W41 2026")).toBeInTheDocument();
    expect(screen.getAllByText("14").length).toBeGreaterThan(0);
    unmount();
    renderWithProviders(<Harness zoom="month" />);
    expect(screen.getByText("2026-09")).toBeInTheDocument();
    expect(screen.getByText("2026-10")).toBeInTheDocument();
    expect(screen.getByText("W39")).toBeInTheDocument();
  });

  test("the toolbar zooms and scrolls to today", async () => {
    const user = userEvent.setup();
    const onZoomChange = vi.fn();
    renderWithProviders(<Harness onZoomChange={onZoomChange} />);
    await user.click(screen.getByRole("radio", { name: "Month" }));
    expect(onZoomChange).toHaveBeenCalledWith("month");
    expect(screen.getByRole("radio", { name: "Week" })).toBeChecked();

    const scroller = screen.getByRole("region", { name: "Project timeline" });
    stubViewport(560, 300);
    await user.click(screen.getByRole("button", { name: "Today" }));
    // today = day 9 of the range: x = 9 * 28 = 252, centre = 252 + 14; the track part of the viewport is 560 - 260 = 300 wide
    expect(scroller.scrollLeft).toBe(252 + 14 - 150);
  });

  test("Today is disabled when today lies outside the range", () => {
    renderWithProviders(<Harness today="2027-01-01" />);
    expect(screen.getByRole("button", { name: "Today" })).toBeDisabled();
  });

  test("a whole-timeline band and a row band are decorations with a title", () => {
    const withBand: TimelineRowData[] = [{ ...ROWS[0], bands: [{ id: "r", start: "2026-09-15", end: "2026-09-16", label: "Row band", tone: "drift" }] }];
    renderWithProviders(
      <Harness rows={withBand} bands={[{ id: "w", start: "2026-09-14", end: "2026-09-20", label: "Target window", tone: "window" }]} />,
    );
    const window = screen.getByTitle("Target window");
    expect(window).toHaveAttribute("aria-hidden", "true");
    expect(window.style.left).toBe("0px");
    expect(window.style.width).toBe(`${7 * DAY}px`);
    expect(screen.getByTitle("Row band").style.left).toBe(`${DAY}px`);
  });

  test("every band carries its tone as data-band-tone; an idle band is a hatched decoration over its days", () => {
    renderWithProviders(
      <Harness
        rows={ROWS}
        bands={[
          { id: "w", start: "2026-09-14", end: "2026-09-20", label: "Target window", tone: "window" },
          { id: "d", start: "2026-09-21", end: "2026-09-22", label: "Overrun", tone: "drift" },
          { id: "i", start: "2026-09-16", end: "2026-09-18", label: "Idle 2026-09-16 to 2026-09-18, 3 working days", tone: "idle" },
        ]}
      />,
    );
    expect(screen.getByTitle("Target window")).toHaveAttribute("data-band-tone", "window");
    expect(screen.getByTitle("Overrun")).toHaveAttribute("data-band-tone", "drift");
    const idle = screen.getByTitle("Idle 2026-09-16 to 2026-09-18, 3 working days");
    expect(idle).toHaveAttribute("data-band-tone", "idle");
    expect(idle).toHaveAttribute("aria-hidden", "true");
    expect(idle.style.left).toBe(`${2 * DAY}px`);
    expect(idle.style.width).toBe(`${3 * DAY}px`);
    // Decoration only: no role, no focus stop.
    expect(idle).not.toHaveAttribute("tabindex");
  });

  test("a row's own track replaces its bars", () => {
    const custom: TimelineRowData[] = [{ ...ROWS[0], track: <div data-testid="load-strip" /> }];
    renderWithProviders(<Harness rows={custom} />);
    expect(screen.getByTestId("load-strip")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Discovery, Team A/ })).not.toBeInTheDocument();
  });

  test("the overlay slot gets data-derived geometry and is one decorative svg", () => {
    const overlay = vi.fn((_geometry: TimelineGeometry) => <line data-testid="arrow" />);
    const { container } = renderWithProviders(<Harness overlay={overlay} />);
    expect(container.querySelector("svg[aria-hidden='true']")).toContainElement(screen.getByTestId("arrow"));
    const geometry = overlay.mock.calls[0][0];
    expect(geometry.rowTop(2)).toBe(72);
    expect(geometry.rowHeight).toBe(36);
    expect(geometry.rowIndexOf(2)).toBe(1);
    expect(geometry.rowIndexOf(99)).toBeNull();
    expect(geometry.xOf("2026-09-16")).toBe(56);
    expect(geometry.barRect(0, 1)).toEqual({ x: 56, y: 6, width: 84, height: 24 });
    expect(geometry.barRect(1, 2)).toEqual({ x: 7 * DAY, y: 42, width: 5 * DAY, height: 24 });
    expect(geometry.barRect(2, 1)).toBeNull();
    expect(geometry.barRect(9, 1)).toBeNull();
    expect(geometry.visibleRows).toEqual({ first: 0, last: 2 });
  });
});

describe("a focused item is revealed clear of the sticky parts", () => {
  // the scroller shows x 100..900, y 50..650; the sticky columns take 260 px (x < 360), the header 56 px (y < 106)
  const rect = (left: number, top: number, width = 100, height = 24) => ({ left, top, right: left + width, bottom: top + height, width, height }) as DOMRect;
  function setup(target: HTMLElement, box: DOMRect) {
    const scroller = screen.getByRole("region", { name: "Project timeline" });
    vi.spyOn(scroller, "getBoundingClientRect").mockReturnValue(rect(100, 50, 800, 600));
    // the inner (padding) box: what is left after the borders and a classic scrollbar (here a 15 px one on the right)
    for (const [name, value] of [["clientLeft", 0], ["clientTop", 0], ["clientWidth", 785], ["clientHeight", 600]] as const) {
      Object.defineProperty(scroller, name, { configurable: true, value });
    }
    vi.spyOn(target, "getBoundingClientRect").mockReturnValue(box);
    scroller.scrollLeft = 1000;
    scroller.scrollTop = 200;
    return scroller;
  }

  test("a bar half under the sticky columns is scrolled right of them", () => {
    renderWithProviders(<Harness />);
    const body = barBody("Discovery, Team A, 2026-09-16 to 2026-09-18");
    const scroller = setup(body, rect(300, 200));
    act(() => body.focus());
    expect(scroller.scrollLeft).toBe(1000 - 60);
  });

  test("a bar beyond the right edge is scrolled into view", () => {
    renderWithProviders(<Harness />);
    const body = barBody("Discovery, Team A, 2026-09-16 to 2026-09-18");
    const scroller = setup(body, rect(850, 200));
    act(() => body.focus());
    // the visible track ends at 885 (the scrollbar is excluded), the bar at 950: 65 px, and its start (850) stays clear of the columns (360)
    expect(scroller.scrollLeft).toBe(1000 + 65);
  });

  test("a bar wider than the visible track aligns its START, never pushing it under the columns", () => {
    renderWithProviders(<Harness />);
    const body = barBody("Discovery, Team A, 2026-09-16 to 2026-09-18");
    // starts at 700 and is 900 wide: ending at 1600, far past the right edge; only 340 px may scroll before its start meets the columns
    const scroller = setup(body, rect(700, 200, 900));
    act(() => body.focus());
    expect(scroller.scrollLeft).toBe(1000 + 340);
  });

  test("a mouse press focuses without moving the grid (only keyboard-style focus reveals)", () => {
    renderWithProviders(<Harness />);
    const body = barBody("Discovery, Team A, 2026-09-16 to 2026-09-18");
    const scroller = setup(body, rect(300, 200));
    const matches = vi.spyOn(body, "matches").mockImplementation((selector: string) => selector !== ":focus-visible");
    act(() => body.focus());
    expect([scroller.scrollLeft, scroller.scrollTop]).toEqual([1000, 200]);
    matches.mockRestore();
  });

  test("a row under the sticky header is scrolled below it", () => {
    renderWithProviders(<Harness />);
    const cell = screen.getByRole("rowheader", { name: "Discovery" });
    const scroller = setup(cell, rect(110, 90, 150));
    act(() => cell.focus());
    expect(scroller.scrollTop).toBe(200 - 16);
    // a left cell is sticky itself: no horizontal correction
    expect(scroller.scrollLeft).toBe(1000);
  });

  test("an item already clear of the sticky parts is left alone", () => {
    renderWithProviders(<Harness />);
    const body = barBody("Discovery, Team A, 2026-09-16 to 2026-09-18");
    const scroller = setup(body, rect(500, 300));
    act(() => body.focus());
    expect([scroller.scrollLeft, scroller.scrollTop]).toEqual([1000, 200]);
  });
});

describe("drag configuration", () => {
  test("a bar gets a narrow horizontal autoscroll zone and a hairline vertical one; a tray drag a real vertical zone, only while it is held", () => {
    renderWithProviders(<Harness />);
    expect(dndProps?.autoScroll).toEqual({ threshold: { x: 0.05, y: 0.02 } });
    emit("onDragStart", trayStart(400));
    expect(dndProps?.autoScroll).toEqual({ threshold: { x: 0.05, y: 0.15 } });
    emit("onDragCancel", {});
    expect(dndProps?.autoScroll).toEqual({ threshold: { x: 0.05, y: 0.02 } });
  });

  describe("the window pointer listener of a tray drag", () => {
    const moves = (spy: { mock: { calls: unknown[][] } }) => spy.mock.calls.filter(([type]) => type === "pointermove").length;

    test("is added at the drag's start and removed on drop, on cancel and on unmount", () => {
      const add = vi.spyOn(window, "addEventListener");
      const remove = vi.spyOn(window, "removeEventListener");
      try {
        const { unmount } = renderWithProviders(<Harness />);
        emit("onDragStart", trayStart(400));
        expect(moves(add)).toBe(1);
        emit("onDragEnd", { active: trayActive, delta: { x: 0, y: 0 }, over: null, activatorEvent: null });
        expect(moves(remove)).toBe(1);
        emit("onDragStart", trayStart(400));
        emit("onDragCancel", {});
        expect(moves(remove)).toBe(2);
        emit("onDragStart", trayStart(400));
        const before = moves(remove);
        unmount();
        expect(moves(remove)).toBeGreaterThan(before);
      } finally {
        add.mockRestore();
        remove.mockRestore();
      }
    });

    test("a pointer that is not the primary one never moves the held item", () => {
      const onSchedule = vi.fn(() => true);
      renderWithProviders(<Harness onSchedule={onSchedule} />);
      emit("onDragStart", trayStart(400, 10));
      act(() => {
        window.dispatchEvent(new PointerEvent("pointermove", { clientX: 900, clientY: 10, isPrimary: false }));
      });
      emit("onDragEnd", { active: trayActive, delta: { x: 0, y: 0 }, over: zone(120, EVERYWHERE), activatorEvent: { clientX: 400 } });
      // still the day under x = 400: (400 - 120) / 28 = day 10
      expect(onSchedule).toHaveBeenCalledExactlyOnceWith(9, "2026-09-24", "2026-09-30");
    });
  });
});

describe("bars and handles", () => {
  test("an editable bar is a movable button with a start and an end handle", () => {
    renderWithProviders(<Harness />);
    expect(barBody("Discovery, Team A, 2026-09-16 to 2026-09-18")).toHaveAttribute("aria-roledescription", "movable bar");
    expect(screen.getByRole("button", { name: "Resize start of Discovery" })).toHaveAttribute("aria-roledescription", "resize handle");
    expect(screen.getByRole("button", { name: "Resize end of Discovery" })).toBeInTheDocument();
  });

  test("a read-only bar is a labelled image with no handle", () => {
    renderWithProviders(<Harness />);
    expect(screen.getByRole("img", { name: "Build, Team A, 2026-09-21 to 2026-09-25, read-only" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Build/ })).not.toBeInTheDocument();
  });

  test("the handles sit outside the bar with a constant width per zoom, so a 1-day bar at quarter zoom keeps its whole body", () => {
    const tiny = [row(1, "Tiny", [bar(1, "Tiny", "2026-09-16", "2026-09-16")])];
    const { unmount } = renderWithProviders(<Harness rows={tiny} zoom="quarter" />);
    const start = screen.getByRole("button", { name: "Resize start of Tiny" });
    const end = screen.getByRole("button", { name: "Resize end of Tiny" });
    expect([start.style.left, start.style.width, end.style.right, end.style.width]).toEqual(["-4px", "4px", "-4px", "4px"]);
    expect(geometryOf(barBody("Tiny, Team A, 2026-09-16 to 2026-09-16")).width).toBe("3px");
    unmount();
    renderWithProviders(<Harness rows={tiny} zoom="month" />);
    expect(screen.getByRole("button", { name: "Resize start of Tiny" }).style.width).toBe("6px");
  });

  test("a handle keeps its width while its edge is dragged (a resize must not re-measure the dragged node)", () => {
    renderWithProviders(<Harness zoom="month" />);
    const handle = screen.getByRole("button", { name: "Resize end of Discovery" });
    const before = handle.style.width;
    const end = active("resize-end");
    emit("onDragStart", gesture(end, 0));
    emit("onDragMove", { ...gesture(end, 0), delta: { x: 8 * 5, y: 0 } });
    expect(geometryOf(barBody("Discovery, Team A, 2026-09-16 to 2026-09-18")).width).toBe(`${8 * 8}px`);
    expect(screen.getByRole("button", { name: "Resize end of Discovery" }).style.width).toBe(before);
  });
});

describe("the roving grid", () => {
  const stops = () => document.querySelectorAll('[data-grid-pos][tabindex="0"]');

  test("exactly one stop: the first row header", () => {
    renderWithProviders(<Harness />);
    expect(stops()).toHaveLength(1);
    expect(stops()[0]).toBe(screen.getByRole("rowheader", { name: "Discovery" }));
  });

  test("arrows walk the left cells, the bar and its handles; read-only rows have no handle cells", () => {
    renderWithProviders(<Harness />);
    const name = screen.getByRole("rowheader", { name: "Discovery" });
    act(() => name.focus());
    fireEvent.keyDown(name, { key: "ArrowRight" });
    expect(screen.getAllByRole("gridcell", { name: "Team A" })[0]).toHaveFocus();
    fireEvent.keyDown(document.activeElement as HTMLElement, { key: "ArrowRight" });
    expect(barBody("Discovery, Team A, 2026-09-16 to 2026-09-18")).toHaveFocus();
    fireEvent.keyDown(document.activeElement as HTMLElement, { key: "ArrowRight" });
    expect(screen.getByRole("button", { name: "Resize start of Discovery" })).toHaveFocus();
    fireEvent.keyDown(document.activeElement as HTMLElement, { key: "ArrowRight" });
    expect(screen.getByRole("button", { name: "Resize end of Discovery" })).toHaveFocus();
    // down from the end handle: the read-only bar on the next row is the nearest lower column
    fireEvent.keyDown(document.activeElement as HTMLElement, { key: "ArrowDown" });
    expect(screen.getByRole("img", { name: /Build/ })).toHaveFocus();
    // and further down, the last row has no bar at all: the nearest lower column is its last left cell
    fireEvent.keyDown(document.activeElement as HTMLElement, { key: "ArrowDown" });
    expect(screen.getAllByRole("gridcell", { name: "Team A" })[2]).toHaveFocus();
    expect(stops()).toHaveLength(1);
  });

  test("a left cell given as a function receives the stop for its own focusable", () => {
    const rows: TimelineRowData[] = [
      { id: 1, cells: [(stop) => <a href="#x" {...stop}>Open</a>, "Team A"], bars: [] },
    ];
    renderWithProviders(<Harness rows={rows} />);
    const link = screen.getByRole("link", { name: "Open" });
    expect(link).toHaveAttribute("tabindex", "0");
    expect(link).toHaveAttribute("data-grid-pos", "1,0");
    expect(screen.getByRole("rowheader")).not.toHaveAttribute("tabindex");
  });

  test("the tab stop falls back to the first row when its row disappears", () => {
    const { rerender } = renderWithProviders(<Harness />);
    act(() => screen.getAllByRole("gridcell", { name: "Team A" })[2].focus());
    expect(stops()[0]).toBe(screen.getAllByRole("gridcell", { name: "Team A" })[2]);
    rerender(<Harness rows={ROWS.slice(0, 1)} />);
    expect(stops()[0]).toBe(screen.getByRole("rowheader", { name: "Discovery" }));
  });

  test("aria-busy follows the save in flight", () => {
    renderWithProviders(<Harness busy />);
    expect(screen.getByRole("grid")).toHaveAttribute("aria-busy", "true");
  });
});

describe("a drag proposes dates through onSchedule", () => {
  test("moving by two days moves both ends", () => {
    const onSchedule = vi.fn(() => true);
    renderWithProviders(<Harness onSchedule={onSchedule} />);
    const move = active("move");
    emit("onDragStart", gesture(move, 0));
    emit("onDragMove", gesture(move, 2));
    emit("onDragEnd", gesture(move, 2));
    expect(onSchedule).toHaveBeenCalledExactlyOnceWith(1, "2026-09-18", "2026-09-20");
  });

  test("a pointer delta that is not a whole number of days rounds to the nearest day", () => {
    const onSchedule = vi.fn(() => true);
    renderWithProviders(<Harness onSchedule={onSchedule} />);
    emit("onDragEnd", { ...gesture(active("move"), 0), delta: { x: DAY * 2 + 9, y: 3 } });
    expect(onSchedule).toHaveBeenCalledExactlyOnceWith(1, "2026-09-18", "2026-09-20");
  });

  test("the start handle changes only the start and cannot cross the end", () => {
    const onSchedule = vi.fn(() => true);
    renderWithProviders(<Harness onSchedule={onSchedule} />);
    emit("onDragEnd", gesture(active("resize-start"), -2));
    expect(onSchedule).toHaveBeenLastCalledWith(1, "2026-09-14", "2026-09-18");
    emit("onDragEnd", gesture(active("resize-start"), 9));
    expect(onSchedule).toHaveBeenLastCalledWith(1, "2026-09-18", "2026-09-18");
  });

  test("the end handle changes only the end and cannot cross the start", () => {
    const onSchedule = vi.fn(() => true);
    renderWithProviders(<Harness onSchedule={onSchedule} />);
    emit("onDragEnd", gesture(active("resize-end"), 3));
    expect(onSchedule).toHaveBeenLastCalledWith(1, "2026-09-16", "2026-09-21");
    emit("onDragEnd", gesture(active("resize-end"), -9));
    expect(onSchedule).toHaveBeenLastCalledWith(1, "2026-09-16", "2026-09-16");
  });

  test("a drop that changes nothing proposes nothing", () => {
    const onSchedule = vi.fn(() => true);
    renderWithProviders(<Harness onSchedule={onSchedule} />);
    emit("onDragEnd", gesture(active("move"), 0));
    expect(onSchedule).not.toHaveBeenCalled();
  });

  test("a cancelled drag proposes nothing and the bar returns", () => {
    const onSchedule = vi.fn(() => true);
    renderWithProviders(<Harness onSchedule={onSchedule} />);
    const end = active("resize-end");
    emit("onDragStart", gesture(end, 0));
    emit("onDragMove", gesture(end, 2));
    emit("onDragCancel", gesture(end, 2));
    expect(onSchedule).not.toHaveBeenCalled();
    expect(geometryOf(barBody("Discovery, Team A, 2026-09-16 to 2026-09-18")).width).toBe(`${3 * DAY}px`);
  });

  test("a resize redraws the bar from the preview while the edge is held, then lets go", () => {
    renderWithProviders(<Harness />);
    const end = active("resize-end");
    const body = () => barBody("Discovery, Team A, 2026-09-16 to 2026-09-18");
    emit("onDragStart", gesture(end, 0));
    emit("onDragMove", gesture(end, 2));
    expect(geometryOf(body())).toEqual({ left: "56px", width: `${5 * DAY}px` });
    emit("onDragMove", gesture(active("resize-start"), -1));
    // only the held bar's own preview counts; a different gesture on the same bar replaces it
    expect(geometryOf(body()).left).toBe(`${DAY}px`);
    emit("onDragEnd", gesture(end, 0));
    expect(geometryOf(body())).toEqual({ left: "56px", width: `${3 * DAY}px` });
  });

  test("a move keeps its geometry (the bar is translated in place), so no other bar is redrawn", () => {
    renderWithProviders(<Harness />);
    const move = active("move");
    emit("onDragStart", gesture(move, 0));
    emit("onDragMove", gesture(move, 3));
    expect(geometryOf(barBody("Discovery, Team A, 2026-09-16 to 2026-09-18"))).toEqual({ left: "56px", width: `${3 * DAY}px` });
    expect(geometryOf(screen.getByRole("img", { name: /Build/ }))).toEqual({ left: `${7 * DAY}px`, width: `${5 * DAY}px` });
  });

  test("a tray item dropped on the track is scheduled for a week from the day under the pointer", () => {
    const onSchedule = vi.fn(() => true);
    renderWithProviders(<Harness onSchedule={onSchedule} />);
    // the pointer went down at x = 400 and moved 100 px right; the track starts at x = 120: 380 px in = day 13 of the range
    emit("onDragStart", trayStart(400));
    act(() => {
      window.dispatchEvent(new PointerEvent("pointermove", { clientX: 500, clientY: 0, isPrimary: true }));
    });
    emit("onDragEnd", { active: trayActive, delta: { x: 100, y: 0 }, over: zone(120, EVERYWHERE), activatorEvent: { clientX: 400 } });
    expect(onSchedule).toHaveBeenCalledExactlyOnceWith(9, "2026-09-27", "2026-10-03");
  });

  test("the day comes from the pointer, not from dnd-kit's delta (which adds the over-scroller's scroll offset to a tray item)", () => {
    const onSchedule = vi.fn(() => true);
    renderWithProviders(<Harness onSchedule={onSchedule} />);
    // the grid is scrolled 3357 px: its zone starts at x = -2575, the pointer is at 920, and dnd-kit's delta claims 3996 px of travel
    emit("onDragStart", trayStart(281));
    act(() => {
      window.dispatchEvent(new PointerEvent("pointermove", { clientX: 920, clientY: 0, isPrimary: true }));
    });
    emit("onDragEnd", { active: trayActive, delta: { x: 3996, y: 0 }, over: zone(-2575, EVERYWHERE), activatorEvent: { clientX: 281 } });
    // (920 + 2575) / 28 = day 124 of the range (which starts 2026-09-14)
    expect(onSchedule).toHaveBeenCalledExactlyOnceWith(9, "2027-01-16", "2027-01-22");
  });

  describe("a tray drop counts only inside the visible track", () => {
    // the scroller shows x 100..900 and y 50..650 on screen; the sticky columns take the first 260 px and the header 56 px
    const bounds = { left: 360, right: 900, top: 106, bottom: 650 };
    const dropAt = (clientX: number, clientY: number, visibleBounds: () => unknown = () => bounds) => {
      const onSchedule = vi.fn(() => true);
      renderWithProviders(<Harness onSchedule={onSchedule} />);
      emit("onDragStart", trayStart(clientX, clientY));
      emit("onDragEnd", { active: trayActive, delta: { x: 0, y: 0 }, over: zone(360, visibleBounds), activatorEvent: { clientX, clientY } });
      return onSchedule;
    };

    test("inside it", () => {
      expect(dropAt(400, 200)).toHaveBeenCalledExactlyOnceWith(9, "2026-09-15", "2026-09-21");
    });

    test("below the scroller (over the tray or the footer)", () => {
      expect(dropAt(400, 700)).not.toHaveBeenCalled();
    });

    test("over the sticky left columns", () => {
      expect(dropAt(300, 200)).not.toHaveBeenCalled();
    });

    test("over the sticky header, or right of the scroller", () => {
      expect(dropAt(400, 80)).not.toHaveBeenCalled();
      expect(dropAt(950, 200)).not.toHaveBeenCalled();
    });

    test("when the scroller is gone", () => {
      expect(dropAt(400, 200, () => null)).not.toHaveBeenCalled();
    });

    test("the drop zone reports the scroller's live rectangle, right of the columns and below the header", () => {
      let visibleBounds: (() => unknown) | undefined;
      let zoneLeft: (() => unknown) | undefined;
      function Probe() {
        const { droppableContainers } = useDndContext();
        useEffect(() => {
          // the droppable registers a render after mount; every later render finds it
          const data = droppableContainers.get(TIMELINE_DROP_ID)?.data.current as { visibleBounds?: () => unknown; zoneLeft?: () => unknown } | undefined;
          if (data?.visibleBounds) visibleBounds = data.visibleBounds;
          if (data?.zoneLeft) zoneLeft = data.zoneLeft;
        });
        return null;
      }
      const scale = scaleOf();
      renderWithProviders(
        <TimelineDndContext scale={scale} onSchedule={vi.fn()}>
          <Probe />
          <Timeline label="Project timeline" scale={scale} onZoomChange={vi.fn()} today="2026-09-23" columns={COLUMNS} rows={ROWS} />
        </TimelineDndContext>,
      );
      const scroller = screen.getByRole("region", { name: "Project timeline" });
      vi.spyOn(scroller, "getBoundingClientRect").mockReturnValue({ left: 100, right: 900, top: 50, bottom: 650 } as DOMRect);
      // 260 px of sticky columns and a 56 px header
      expect(visibleBounds?.()).toEqual({ left: 360, right: 900, top: 106, bottom: 650 });
      // the zone's left edge is read live from its element (here: happy-dom's empty rect)
      expect(zoneLeft?.()).toBe(0);
    });
  });

  test("a tray item dropped elsewhere, or started from the keyboard, is not scheduled", () => {
    const onSchedule = vi.fn(() => true);
    renderWithProviders(<Harness onSchedule={onSchedule} />);
    emit("onDragStart", trayStart(400));
    emit("onDragEnd", { active: trayActive, delta: { x: 0, y: 0 }, over: null, activatorEvent: { clientX: 400 } });
    emit("onDragStart", trayStart(400));
    emit("onDragEnd", { active: trayActive, delta: { x: 0, y: 0 }, over: { id: "other", data: { current: {} } }, activatorEvent: { clientX: 400 } });
    // a keyboard activator has no coordinates, so there is no pointer to read a day from
    emit("onDragStart", { active: trayActive, delta: { x: 0, y: 0 }, over: null, activatorEvent: new Event("keydown") });
    emit("onDragEnd", { active: trayActive, delta: { x: 0, y: 0 }, over: zone(0, EVERYWHERE), activatorEvent: new Event("keydown") });
    expect(onSchedule).not.toHaveBeenCalled();
  });

  test("a foreign draggable is ignored", () => {
    const onSchedule = vi.fn(() => true);
    renderWithProviders(<Harness onSchedule={onSchedule} />);
    const foreign = { id: "x", data: { current: {} } };
    emit("onDragStart", gesture(foreign as never, 0));
    emit("onDragMove", gesture(foreign as never, 1));
    emit("onDragEnd", gesture(foreign as never, 1));
    expect(onSchedule).not.toHaveBeenCalled();
  });
});

describe("a row drag proposes a slot through onReorder", () => {
  // The held row is Discovery: position 1 of 3 (index 0). The row zone's top is at client y = 100 (rows 36 px), the grid shows y 100..600.
  const rowActive = { id: "row:1", data: { current: { kind: "row", barId: 1, label: "Discovery", position: 1, count: 3 } } };
  // the scroller spans y 44..600 and its sticky header takes the first 56 px
  const BOUNDS = { left: 0, right: 900, top: 100, bottom: 600, scrollerTop: 44 };
  const rowZone = (zoneTop = 100, rowBounds: () => unknown = () => BOUNDS) => ({
    id: TIMELINE_ROW_DROP_ID,
    data: { current: { zoneTop: () => zoneTop, rowBounds, rowCount: 3 } },
  });
  const rowEvent = (over: unknown = null, activatorEvent: unknown = null) => ({ active: rowActive, delta: { x: 0, y: 0 }, over, activatorEvent });
  const pointerAt = (clientY: number, clientX = 40) =>
    act(() => {
      window.dispatchEvent(new PointerEvent("pointermove", { clientX, clientY, isPrimary: true }));
    });
  const indicator = () => document.querySelector<HTMLElement>("[data-row-slot]");
  const say = () => dndProps!.accessibility!.announcements!;
  // y = 100 + 36 n + 20 sits in the lower half of row n: the slot after it
  const startRowDrag = () => emit("onDragStart", rowEvent(null, { clientX: 20, clientY: 110 }));

  test("picking a row up shows its card in the overlay, says so, and widens the vertical autoscroll zone until it lets go", () => {
    renderWithProviders(<Harness onReorder={vi.fn(() => true)} />);
    // no overlay is mounted until a row is held (a mounted DragOverlay changes how dnd-kit moves EVERY drag)
    expect(screen.queryByTestId("drag-overlay")).toBeNull();
    expect(say().onDragStart({ active: rowActive } as never)).toBe(
      "Picked up Discovery, position 1 of 3. Move the pointer to the new place and release; Escape cancels.",
    );
    startRowDrag();
    expect(within(screen.getByTestId("drag-overlay")).getByText("Discovery")).toBeInTheDocument();
    expect(dndProps?.autoScroll).toEqual({ threshold: { x: 0.02, y: 0.15 } });
    // the card only goes up and down, and no drop animation plays over the real row
    expect(overlayProps?.modifiers).toEqual([verticalOnly]);
    expect(overlayProps?.dropAnimation).toBeNull();
    emit("onDragCancel", {});
    expect(screen.queryByTestId("drag-overlay")).toBeNull();
    expect(dndProps?.autoScroll).toEqual({ threshold: { x: 0.05, y: 0.02 } });
  });

  test("the insertion line follows the slot under the pointer, and each new slot is announced once", () => {
    renderWithProviders(<Harness onReorder={vi.fn(() => true)} />);
    startRowDrag();
    expect(indicator()).toBeNull();
    // y = 190: 90 px into the body = 2.5 rows -> slot 3 (the lower half of row 2)
    pointerAt(190);
    emit("onDragMove", rowEvent(rowZone()));
    expect(indicator()).toHaveAttribute("data-row-slot", "3");
    expect(indicator()).toHaveStyle({ top: "107px" });
    expect(say().onDragMove?.({ active: rowActive } as never)).toBe("Discovery: position 3 of 3");
    // still the same slot: neither a new line nor a new sentence
    pointerAt(192);
    emit("onDragMove", rowEvent(rowZone()));
    expect(say().onDragMove?.({ active: rowActive } as never)).toBeUndefined();
    // y = 140: 40 px in = slot 1
    pointerAt(140);
    emit("onDragMove", rowEvent(rowZone()));
    expect(indicator()).toHaveAttribute("data-row-slot", "1");
    expect(indicator()).toHaveStyle({ top: "35px" });
    expect(say().onDragMove?.({ active: rowActive } as never)).toBe("Discovery: position 1 of 3");
    emit("onDragEnd", rowEvent(rowZone()));
    expect(indicator()).toBeNull();
  });

  test("the slot is read against the zone's LIVE top (a scrolled grid: negative) and reaches rows that are not mounted", () => {
    const onReorder = vi.fn(() => true);
    renderWithProviders(<Harness onReorder={onReorder} />);
    startRowDrag();
    // scrolled so that the body starts 70 px above the viewport: y = 200 is 270 px in = 7.5 rows -> clamped to the row count, 3
    pointerAt(200);
    emit("onDragEnd", rowEvent(rowZone(-70)));
    expect(onReorder).toHaveBeenCalledExactlyOnceWith(1, 3);
  });

  test("a drop proposes the slot once and is announced with the position the row takes", () => {
    const onReorder = vi.fn(() => true);
    renderWithProviders(<Harness onReorder={onReorder} />);
    startRowDrag();
    pointerAt(190);
    emit("onDragEnd", rowEvent(rowZone()));
    expect(onReorder).toHaveBeenCalledExactlyOnceWith(1, 3);
    expect(say().onDragEnd({ active: rowActive } as never)).toBe("Dropped Discovery at position 3 of 3.");
    // a finished drag is announced once and forgotten
    expect(say().onDragEnd({ active: rowActive } as never)).toBeUndefined();
  });

  test("a slot beside the row itself is still PROPOSED (the page compares with the order it shows now) but announced as staying", () => {
    const onReorder = vi.fn(() => true);
    renderWithProviders(<Harness onReorder={onReorder} />);
    for (const [clientY, slot] of [[105, 0], [125, 1]] as const) {
      // the slot before the row (0) and the slot after it (1)
      startRowDrag();
      pointerAt(clientY);
      emit("onDragEnd", rowEvent(rowZone()));
      expect(onReorder).toHaveBeenLastCalledWith(1, slot);
      expect(say().onDragEnd({ active: rowActive } as never)).toBe("Discovery stays at position 1 of 3.");
    }
  });

  test("released where nothing lands (no zone, outside the scroller) proposes nothing and says the row stays", () => {
    const onReorder = vi.fn(() => true);
    renderWithProviders(<Harness onReorder={onReorder} />);
    // over: null (no zone at all)
    startRowDrag();
    pointerAt(190);
    emit("onDragEnd", rowEvent(null));
    expect(say().onDragEnd({ active: rowActive } as never)).toBe("Discovery stays at position 1 of 3.");
    // above the scroller
    startRowDrag();
    pointerAt(30);
    emit("onDragMove", rowEvent(rowZone()));
    expect(indicator()).toBeNull();
    expect(say().onDragMove?.({ active: rowActive } as never)).toBeUndefined();
    emit("onDragEnd", rowEvent(rowZone()));
    expect(say().onDragEnd({ active: rowActive } as never)).toBe("Discovery stays at position 1 of 3.");
    // below the grid (the tray) and beside it
    startRowDrag();
    pointerAt(640);
    emit("onDragEnd", rowEvent(rowZone()));
    startRowDrag();
    pointerAt(190, 1200);
    emit("onDragEnd", rowEvent(rowZone()));
    expect(onReorder).not.toHaveBeenCalled();
  });

  test("over the sticky header the line stays at the first slot below it, so scrolling up with a held row keeps a target", () => {
    const onReorder = vi.fn(() => true);
    renderWithProviders(<Harness onReorder={onReorder} />);
    startRowDrag();
    // scrolled 90 px: the body starts at y = 10, under the header (rows start at y = 100): rows 0..2 are hidden, the first slot fully below it is 3
    pointerAt(70);
    emit("onDragMove", rowEvent(rowZone(10)));
    expect(indicator()).toHaveAttribute("data-row-slot", "3");
    expect(say().onDragMove?.({ active: rowActive } as never)).toBe("Discovery: position 3 of 3");
    // not scrolled: the first slot
    pointerAt(70);
    emit("onDragMove", rowEvent(rowZone(100)));
    expect(indicator()).toHaveAttribute("data-row-slot", "0");
    expect(indicator()).toHaveStyle({ top: "0px" }); // never above the body's own edge
    emit("onDragEnd", rowEvent(rowZone(100)));
    expect(onReorder).toHaveBeenCalledExactlyOnceWith(1, 0);
  });

  test("a drop the page refuses is announced as not changed, never as a drop", () => {
    const onReorder = vi.fn(() => false);
    renderWithProviders(<Harness onReorder={onReorder} />);
    startRowDrag();
    pointerAt(190);
    emit("onDragEnd", rowEvent(rowZone()));
    expect(onReorder).toHaveBeenCalledOnce();
    expect(say().onDragEnd({ active: rowActive } as never)).toBe("Discovery was not changed: a save is still running. Try again in a moment.");
  });

  test("cancelling proposes nothing and says where the row stays", () => {
    const onReorder = vi.fn(() => true);
    renderWithProviders(<Harness onReorder={onReorder} />);
    startRowDrag();
    pointerAt(190);
    emit("onDragMove", rowEvent(rowZone()));
    emit("onDragCancel", {});
    expect(say().onDragCancel?.({ active: rowActive } as never)).toBe("Cancelled; Discovery stays at position 1 of 3.");
    expect(onReorder).not.toHaveBeenCalled();
    expect(indicator()).toBeNull();
  });

  test("the drop still knows the held row when dnd-kit has lost its data (the handle's row left the window mid-drag)", () => {
    const onReorder = vi.fn(() => true);
    renderWithProviders(<Harness onReorder={onReorder} />);
    startRowDrag();
    pointerAt(190);
    const orphan = { id: "row:1", data: { current: {} } };
    emit("onDragMove", { ...rowEvent(rowZone()), active: orphan });
    expect(indicator()).toHaveAttribute("data-row-slot", "3");
    expect(dndProps?.modifiers?.[0]({ active: orphan, transform: { x: 40, y: 17, scaleX: 1, scaleY: 1 } } as never)).toMatchObject({ x: 40, y: 17 });
    emit("onDragEnd", { ...rowEvent(rowZone()), active: orphan });
    expect(onReorder).toHaveBeenCalledExactlyOnceWith(1, 3);
  });

  test("the window pointer listener of a row drag is added at the start and removed on drop and on cancel", () => {
    const add = vi.spyOn(window, "addEventListener");
    const remove = vi.spyOn(window, "removeEventListener");
    const moves = (spy: { mock: { calls: unknown[][] } }) => spy.mock.calls.filter(([type]) => type === "pointermove").length;
    try {
      renderWithProviders(<Harness onReorder={vi.fn(() => true)} />);
      startRowDrag();
      expect(moves(add)).toBe(1);
      emit("onDragEnd", rowEvent(rowZone()));
      expect(moves(remove)).toBe(1);
      startRowDrag();
      emit("onDragCancel", {});
      expect(moves(remove)).toBe(2);
    } finally {
      add.mockRestore();
      remove.mockRestore();
    }
  });

  test("after the drop or the cancel, an orphaned event (no data, as dnd-kit sends for an unmounted node) resolves to nothing", () => {
    const onReorder = vi.fn(() => true);
    renderWithProviders(<Harness onReorder={onReorder} />);
    const orphan = { id: "row:1", data: { current: {} } };
    const snap = { transform: { x: 40, y: 17, scaleX: 1, scaleY: 1 } };
    for (const finish of ["onDragEnd", "onDragCancel"] as const) {
      startRowDrag();
      pointerAt(190);
      emit(finish, rowEvent(rowZone()));
      // `held` was cleared: nothing is proposed or previewed, and the modifier treats it like any other item (a bar's snap)
      emit("onDragMove", { ...rowEvent(rowZone()), active: orphan });
      emit("onDragEnd", { ...rowEvent(rowZone()), active: orphan });
      expect(indicator()).toBeNull();
      expect(dndProps?.modifiers?.[0]({ active: orphan, ...snap } as never)).toMatchObject({ x: DAY, y: 0 });
    }
    expect(onReorder).toHaveBeenCalledTimes(1); // only the first, real drop
  });

  test("a bar drag draws no insertion line and mounts no overlay; a held row leaves the bars where they are", () => {
    renderWithProviders(<Harness onReorder={vi.fn(() => true)} />);
    const move = active("move");
    emit("onDragStart", gesture(move, 0));
    emit("onDragMove", gesture(move, 2));
    expect(indicator()).toBeNull();
    expect(screen.queryByTestId("drag-overlay")).toBeNull();
    emit("onDragCancel", {});
    startRowDrag();
    pointerAt(190);
    emit("onDragMove", rowEvent(rowZone()));
    expect(geometryOf(barBody("Discovery, Team A, 2026-09-16 to 2026-09-18"))).toEqual({ left: "56px", width: `${3 * DAY}px` });
  });

  describe("the collision filter", () => {
    const rect = (top: number, left = 0) => ({ top, left, right: left + 900, bottom: top + 400, width: 900, height: 400 });
    const args = (activeItem: unknown) => ({
      active: activeItem,
      collisionRect: rect(0),
      // both zones cover the pointer: the track zone and the whole-body row zone
      droppableRects: new Map([
        [TIMELINE_DROP_ID, rect(0, 100)],
        [TIMELINE_ROW_DROP_ID, rect(0)],
      ]),
      droppableContainers: [{ id: TIMELINE_DROP_ID }, { id: TIMELINE_ROW_DROP_ID }],
      pointerCoordinates: { x: 300, y: 100 },
    });
    const hits = (activeItem: unknown) => (dndProps!.collisionDetection!(args(activeItem) as never) ?? []).map((collision) => collision.id);

    test("a row drag collides only with the row zone; a bar or tray drag never does", () => {
      renderWithProviders(<Harness onReorder={vi.fn(() => true)} />);
      expect(hits(rowActive)).toEqual([TIMELINE_ROW_DROP_ID]);
      expect(hits(trayActive)).toEqual([TIMELINE_DROP_ID]);
      expect(hits(active("move"))).toEqual([TIMELINE_DROP_ID]);
      expect(hits(active("resize-end"))).toEqual([TIMELINE_DROP_ID]);
    });

    test("a row drag keeps the row zone wherever the pointer is (dnd-kit's snapshot of the zone does not reach over the header)", () => {
      renderWithProviders(<Harness onReorder={vi.fn(() => true)} />);
      const outside = { ...args(rowActive), pointerCoordinates: { x: 300, y: -40 } };
      expect((dndProps!.collisionDetection!(outside as never) ?? []).map((collision) => collision.id)).toEqual([TIMELINE_ROW_DROP_ID]);
      // a bar drag at the same point still meets nothing
      expect(dndProps!.collisionDetection!({ ...outside, active: active("move") } as never)).toEqual([]);
    });

    test("an orphaned active (no data) follows the held drag, and is an ordinary item once that drag is over", () => {
      renderWithProviders(<Harness onReorder={vi.fn(() => true)} />);
      const orphan = { id: "row:1", data: { current: {} } };
      emit("onDragStart", rowEvent(null, { clientX: 20, clientY: 110 }));
      expect(hits(orphan)).toEqual([TIMELINE_ROW_DROP_ID]);
      emit("onDragCancel", {});
      expect(hits(orphan)).toEqual([TIMELINE_DROP_ID]);
    });
  });
});

describe("what Timeline publishes for a row drop", () => {
  const seen: { data: { zoneTop: () => number | null; rowBounds: () => unknown; rowCount: number } | null } = { data: null };
  /** Reads the row zone's droppable `data` the way dnd-kit hands it to the context. */
  function ZoneProbe() {
    const data = useDndContext().droppableContainers.get(TIMELINE_ROW_DROP_ID)?.data.current as typeof seen.data;
    useEffect(() => {
      seen.data = data;
    });
    return null;
  }
  /** happy-dom lays nothing out: the scroller is at y 50..650 and x 10..910, the row zone starts at `zoneTop`. */
  function stubRects(zoneTop: number) {
    return vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (this: Element) {
      const at = (top: number, left: number, right: number, bottom: number) => ({ top, left, right, bottom, width: right - left, height: bottom - top, x: left, y: top, toJSON: () => ({}) });
      if (this.getAttribute("role") === "region") return at(50, 10, 910, 650);
      if (this.getAttribute("aria-hidden") === "true" && (this as HTMLElement).style.left === "0px" && (this as HTMLElement).style.top === "0px") return at(zoneTop, 10, 1000, zoneTop + 900);
      return at(0, 0, 0, 0);
    });
  }
  beforeEach(() => {
    seen.data = null;
  });

  test("zoneTop and rowBounds are read live from the DOM; the rows start below the header (56 px, 92 px with a strip); rowCount counts every row", () => {
    const spy = stubRects(-300);
    try {
      renderWithProviders(<Harness probe={<ZoneProbe />} />);
      expect(seen.data?.rowCount).toBe(3);
      expect(seen.data?.zoneTop()).toBe(-300);
      expect(seen.data?.rowBounds()).toEqual({ left: 10, right: 910, top: 50 + headerHeight(false), bottom: 650, scrollerTop: 50 });
      // the zone moves with the scroll: the reader asks again every time
      spy.mockRestore();
      const scrolled = stubRects(-420);
      expect(seen.data?.zoneTop()).toBe(-420);
      scrolled.mockRestore();
    } finally {
      vi.restoreAllMocks();
    }
  });

  test("with a strip the rows start 36 px lower", () => {
    stubRects(0);
    try {
      const strip: TimelineStripData = { label: "Load", render: () => null };
      renderWithProviders(<Harness strip={strip} probe={<ZoneProbe />} />);
      expect(seen.data?.rowBounds()).toMatchObject({ top: 50 + headerHeight(true), scrollerTop: 50 });
      expect(headerHeight(true) - headerHeight(false)).toBe(36);
    } finally {
      vi.restoreAllMocks();
    }
  });

  test("on the virtual path rowCount is every row, mounted or not, and a drop in a far slot is proposed", () => {
    const many = Array.from({ length: 200 }, (_, i) => row(i + 1, `Item ${i + 1}`, [bar(i + 1, `Item ${i + 1}`, "2026-09-16", "2026-09-18")]));
    stubViewport(900, 400);
    stubRects(-3000);
    try {
      const onReorder = vi.fn(() => true);
      renderWithProviders(<Harness rows={many} virtualizeFrom={5} onReorder={onReorder} probe={<ZoneProbe />} />);
      expect(within(screen.getByRole("grid")).getAllByRole("rowheader").length).toBeLessThan(30);
      expect(seen.data?.rowCount).toBe(200);
      const held = { id: "row:1", data: { current: { kind: "row", barId: 1, label: "Item 1", position: 1, count: 200 } } };
      const over = { id: TIMELINE_ROW_DROP_ID, data: { current: seen.data } };
      emit("onDragStart", { active: held, delta: { x: 0, y: 0 }, over: null, activatorEvent: { clientX: 40, clientY: 120 } });
      act(() => {
        window.dispatchEvent(new PointerEvent("pointermove", { clientX: 40, clientY: 300, isPrimary: true }));
      });
      // the body starts 3,000 px above the viewport: y = 300 is 3,300 px in = row 91.67 -> slot 92, a row that is not mounted
      emit("onDragMove", { active: held, delta: { x: 0, y: 0 }, over, activatorEvent: null });
      expect(document.querySelector("[data-row-slot]")).toHaveAttribute("data-row-slot", "92");
      emit("onDragEnd", { active: held, delta: { x: 0, y: 0 }, over, activatorEvent: null });
      expect(onReorder).toHaveBeenCalledExactlyOnceWith(1, 92);
    } finally {
      vi.restoreAllMocks();
    }
  });
});

describe("modifiers and sensors", () => {
  test("bars are held to whole days on one row; a tray item is left free", () => {
    renderWithProviders(<Harness />);
    const modifier = dndProps?.modifiers?.[0];
    const run = (a: unknown) => modifier?.({ active: a, transform: { x: 40, y: 17, scaleX: 1, scaleY: 1 } } as never);
    expect(run(active("move"))).toMatchObject({ x: DAY, y: 0 });
    expect(run(active("resize-end"))).toMatchObject({ x: DAY, y: 0 });
    expect(run(trayActive)).toMatchObject({ x: 40, y: 17 });
  });
});

describe("announcements (EN)", () => {
  const announcements = () => dndProps!.accessibility!.announcements!;

  test("instructions are localized", () => {
    renderWithProviders(<Harness />);
    expect(dndProps?.accessibility?.screenReaderInstructions?.draggable).toMatch(/Space or Enter.*arrow keys/);
  });

  test("pick up, each step, drop", () => {
    renderWithProviders(<Harness />);
    const move = active("move");
    emit("onDragStart", gesture(move, 0));
    expect(announcements().onDragStart({ active: move } as never)).toBe(
      "Picked up Discovery, 2026-09-16 to 2026-09-18. Left and right arrows move it by a day, with Shift by a week; Space drops it, Escape cancels.",
    );
    emit("onDragMove", gesture(move, 0));
    expect(announcements().onDragMove?.({ active: move } as never)).toBeUndefined();
    emit("onDragMove", gesture(move, 1));
    expect(announcements().onDragMove?.({ active: move } as never)).toBe("Discovery: 2026-09-17 to 2026-09-19");
    // the same dates twice are said once
    expect(announcements().onDragMove?.({ active: move } as never)).toBeUndefined();
    emit("onDragEnd", gesture(move, 7));
    expect(announcements().onDragEnd({ active: move } as never)).toBe("Dropped Discovery: 2026-09-23 to 2026-09-25.");
    expect(announcements().onDragOver({ active: move } as never)).toBeUndefined();
  });

  test("resize pick-up and cancel", () => {
    renderWithProviders(<Harness />);
    const start = active("resize-start");
    const end = active("resize-end");
    expect(announcements().onDragStart({ active: start } as never)).toMatch(/^Resizing the start of Discovery, 2026-09-16 to 2026-09-18/);
    expect(announcements().onDragStart({ active: end } as never)).toMatch(/^Resizing the end of Discovery/);
    emit("onDragStart", gesture(end, 0));
    emit("onDragMove", gesture(end, 2));
    expect(announcements().onDragCancel?.({ active: end } as never)).toBe("Cancelled; Discovery stays at 2026-09-16 to 2026-09-18.");
  });

  test("a drop the page refuses is announced as not changed, never as a drop", () => {
    renderWithProviders(<Harness onSchedule={vi.fn(() => false)} />);
    const move = active("move");
    emit("onDragStart", gesture(move, 0));
    emit("onDragMove", gesture(move, 2));
    emit("onDragEnd", gesture(move, 2));
    expect(announcements().onDragEnd({ active: move } as never)).toBe("Discovery was not changed: a save is still running. Try again in a moment.");
    // a refused tray drop too
    emit("onDragStart", trayStart(2 * DAY));
    emit("onDragEnd", { active: trayActive, delta: { x: 0, y: 0 }, over: zone(0, EVERYWHERE), activatorEvent: { clientX: 2 * DAY } });
    expect(announcements().onDragEnd({ active: trayActive } as never)).toBe("Rollout was not changed: a save is still running. Try again in a moment.");
  });

  test("a tray item: pick-up, scheduled, not scheduled, cancelled", () => {
    renderWithProviders(<Harness />);
    expect(announcements().onDragStart({ active: trayActive } as never)).toBe("Picked up Rollout from the unscheduled list.");
    emit("onDragStart", { active: trayActive, delta: { x: 0, y: 0 }, over: null, activatorEvent: null });
    emit("onDragMove", { active: trayActive, delta: { x: 0, y: 0 }, over: null, activatorEvent: null });
    expect(announcements().onDragMove?.({ active: trayActive } as never)).toBeUndefined();
    emit("onDragEnd", { active: trayActive, delta: { x: 0, y: 0 }, over: null, activatorEvent: null });
    expect(announcements().onDragEnd({ active: trayActive } as never)).toBe("Rollout was not scheduled.");
    emit("onDragStart", trayStart(2 * DAY));
    emit("onDragEnd", { active: trayActive, delta: { x: 0, y: 0 }, over: zone(0, EVERYWHERE), activatorEvent: { clientX: 2 * DAY } });
    expect(announcements().onDragEnd({ active: trayActive } as never)).toBe("Scheduled Rollout: 2026-09-16 to 2026-09-22.");
    // a finished drag is announced once and forgotten
    expect(announcements().onDragEnd({ active: trayActive } as never)).toBeUndefined();
    emit("onDragStart", { active: trayActive, delta: { x: 0, y: 0 }, over: null, activatorEvent: null });
    expect(announcements().onDragCancel?.({ active: trayActive } as never)).toBe("Cancelled; Rollout was not scheduled.");
    expect(announcements().onDragCancel?.({ active: trayActive } as never)).toBeUndefined();
  });

  test("with nothing running, the announcements stay silent", () => {
    renderWithProviders(<Harness />);
    expect(announcements().onDragEnd({ active: move() } as never)).toBeUndefined();
    expect(announcements().onDragCancel?.({ active: move() } as never)).toBeUndefined();
    expect(announcements().onDragStart({ active: { id: "x", data: { current: {} } } } as never)).toBeUndefined();
    expect(announcements().onDragMove?.({ active: move() } as never)).toBeUndefined();
  });
});

function move() {
  return active("move");
}

describe("the keyboard sensor, end to end", () => {
  test("Space, ArrowRight, Space moves a bar by one day", async () => {
    const onSchedule = vi.fn(() => true);
    renderWithProviders(<Harness onSchedule={onSchedule} />);
    const body = barBody("Discovery, Team A, 2026-09-16 to 2026-09-18");
    act(() => body.focus());
    // the sensor attaches its document listener in a zero-delay timeout: run just that one by hand
    vi.useFakeTimers({ toFake: ["setTimeout"] });
    fireEvent.keyDown(body, { code: "Space", key: " " });
    act(() => {
      vi.advanceTimersByTime(1);
    });
    vi.useRealTimers();
    // while a bar is held the grid does not navigate: the arrow belongs to dnd-kit (it bubbles to the document listener)
    fireEvent.keyDown(body, { code: "ArrowRight", key: "ArrowRight" });
    expect(body).toHaveFocus();
    fireEvent.keyDown(document, { code: "Space", key: " " });
    await waitFor(() => expect(onSchedule).toHaveBeenCalledWith(1, "2026-09-17", "2026-09-19"));
  });

  test("a held bar mounts no overlay wrapper: dnd-kit's DragOverlay (the REAL one here) would change how every bar drag moves", async () => {
    realOverlay = true;
    renderWithProviders(<Harness />);
    const body = barBody("Discovery, Team A, 2026-09-16 to 2026-09-18");
    act(() => body.focus());
    vi.useFakeTimers({ toFake: ["setTimeout"] });
    fireEvent.keyDown(body, { code: "Space", key: " " });
    act(() => {
      vi.advanceTimersByTime(1);
    });
    vi.useRealTimers();
    // the bar IS held (the grid yields the arrows to dnd-kit) ...
    fireEvent.keyDown(body, { code: "ArrowRight", key: "ArrowRight" });
    expect(body).toHaveFocus();
    // ... and no overlay wrapper (fixed, z-index 999; dnd-kit's own hidden live region is fixed too, without a z-index) was rendered over it
    expect(document.querySelector('[style*="z-index: 999"]')).toBeNull();
    fireEvent.keyDown(document, { code: "Escape", key: "Escape" });
  });
});

describe("virtualisation", () => {
  const MANY: TimelineRowData[] = Array.from({ length: 40 }, (_, i) => row(i + 1, `Item ${i + 1}`, [bar(i + 1, `Item ${i + 1}`, "2026-09-16", "2026-09-18")]));

  beforeEach(() => {
    // 180 px of viewport = five 36 px rows
    stubViewport(900, 180);
  });

  test("at or below virtualizeFrom every row is mounted", () => {
    renderWithProviders(<Harness rows={MANY} virtualizeFrom={40} />);
    expect(within(screen.getByRole("grid")).getAllByRole("rowheader")).toHaveLength(40);
  });

  test("above it only the window plus the overscan is mounted, positioned by row", () => {
    renderWithProviders(<Harness rows={MANY} virtualizeFrom={5} />);
    const headers = within(screen.getByRole("grid")).getAllByRole("rowheader");
    expect(headers.length).toBeGreaterThanOrEqual(5);
    expect(headers.length).toBeLessThan(20);
    expect(headers[0]).toHaveTextContent("Item 1");
    expect(screen.queryByRole("rowheader", { name: "Item 40" })).not.toBeInTheDocument();
    expect(screen.getByRole("grid")).toHaveAttribute("aria-rowcount", "41");
    const third = screen.getByRole("rowheader", { name: "Item 3" }).closest('[role="row"]') as HTMLElement;
    expect(third.style.top).toBe("72px");
    expect(third).toHaveAttribute("aria-rowindex", "4");
  });

  test("the tab stop is a mounted cell", () => {
    renderWithProviders(<Harness rows={MANY} virtualizeFrom={5} />);
    expect(document.querySelectorAll('[data-grid-pos][tabindex="0"]')).toHaveLength(1);
  });

  const scrollTo = (row: number) => {
    const scroller = screen.getByRole("region", { name: "Project timeline" });
    scroller.scrollTop = row * 36;
    fireEvent.scroll(scroller);
  };

  test("Ctrl+End aimed at an unmounted last row scrolls there and focuses its last cell once it is mounted", async () => {
    renderWithProviders(<Harness rows={MANY} virtualizeFrom={5} />);
    const first = screen.getByRole("rowheader", { name: "Item 1" });
    act(() => first.focus());
    expect(screen.queryByRole("rowheader", { name: "Item 40" })).not.toBeInTheDocument();
    // taken by the Timeline: the default is prevented, the key is not dropped
    expect(fireEvent.keyDown(first, { key: "End", ctrlKey: true })).toBe(false);
    scrollTo(35);
    await waitFor(() => expect(screen.getByRole("button", { name: "Resize end of Item 40" })).toHaveFocus());
  });

  test("Ctrl+Home from the far end scrolls back to the first row", async () => {
    renderWithProviders(<Harness rows={MANY} virtualizeFrom={5} />);
    scrollTo(35);
    await screen.findByRole("rowheader", { name: "Item 40" });
    const cell = within(screen.getByRole("grid")).getAllByRole("rowheader").at(-1) as HTMLElement;
    act(() => cell.focus());
    expect(fireEvent.keyDown(cell, { key: "Home", ctrlKey: true })).toBe(false);
    scrollTo(0);
    await waitFor(() => expect(screen.getByRole("rowheader", { name: "Item 1" })).toHaveFocus());
  });

  test("arrowing down from the last mounted row takes the key (scroll and wait) instead of skipping ahead", async () => {
    renderWithProviders(<Harness rows={MANY} virtualizeFrom={5} />);
    const mounted = within(screen.getByRole("grid")).getAllByRole("rowheader");
    const edge = mounted[mounted.length - 1];
    act(() => edge.focus());
    expect(fireEvent.keyDown(edge, { key: "ArrowDown" })).toBe(false);
    scrollTo(mounted.length - 3);
    await waitFor(() => expect(screen.getByRole("rowheader", { name: `Item ${mounted.length + 1}` })).toHaveFocus());
  });

  describe("a wish to focus a row that is not mounted yet is dropped when the user does something else", () => {
    const wish = () => {
      renderWithProviders(
        <>
          <button>Elsewhere</button>
          <Harness rows={MANY} virtualizeFrom={5} />
        </>,
      );
      const first = screen.getByRole("rowheader", { name: "Item 1" });
      act(() => first.focus());
      expect(fireEvent.keyDown(first, { key: "End", ctrlKey: true })).toBe(false);
      return first;
    };
    const arrives = async () => {
      scrollTo(35);
      await screen.findByRole("rowheader", { name: "Item 40" });
    };

    test("another key", async () => {
      const first = wish();
      fireEvent.keyDown(first, { key: "a" });
      await arrives();
      expect(screen.getByRole("button", { name: "Resize end of Item 40" })).not.toHaveFocus();
    });

    test("focus moving elsewhere", async () => {
      wish();
      act(() => screen.getByRole("button", { name: "Elsewhere" }).focus());
      await arrives();
      expect(screen.getByRole("button", { name: "Elsewhere" })).toHaveFocus();
    });

    test("scrolling by hand", async () => {
      wish();
      fireEvent.wheel(screen.getByRole("region", { name: "Project timeline" }));
      await arrives();
      expect(screen.getByRole("button", { name: "Resize end of Item 40" })).not.toHaveFocus();
    });

    test("a key pressed on the scroller itself", async () => {
      wish();
      fireEvent.keyDown(screen.getByRole("region", { name: "Project timeline" }), { key: "PageDown" });
      await arrives();
      expect(screen.getByRole("button", { name: "Resize end of Item 40" })).not.toHaveFocus();
    });
  });
});

describe("the Unscheduled tray", () => {
  const ITEMS: TrayItem[] = [
    { id: 7, label: "Rollout", cells: ["Rollout", "Team A"], canSchedule: true, actions: <button>Menu</button> },
    { id: 8, label: "Training", cells: ["Training", "Team B"], canSchedule: false },
  ];

  function renderTray(items = ITEMS, onSchedule = vi.fn()) {
    const scale = scaleOf();
    renderWithProviders(
      <TimelineDndContext scale={scale} onSchedule={vi.fn()}>
        <TimelineUnscheduledTray label="Unscheduled" columns={["Milestone", "Team"]} items={items} emptyText="Nothing waits" onSchedule={onSchedule} />
      </TimelineDndContext>,
    );
    return onSchedule;
  }

  test("a schedulable row has a Schedule button that hands the page its id; others have none", async () => {
    const user = userEvent.setup();
    const onSchedule = renderTray();
    expect(screen.getByRole("table", { name: "Unscheduled" })).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: /^Schedule / })).toHaveLength(1);
    await user.click(screen.getByRole("button", { name: "Schedule Rollout" }));
    expect(onSchedule).toHaveBeenCalledExactlyOnceWith(7);
    expect(screen.getByText("Training")).toBeInTheDocument();
  });

  test("the drag handle is a pointer affordance only: hidden from assistive technology, no keyboard stop", () => {
    renderTray();
    const rows = screen.getAllByRole("row").slice(1);
    const handle = rows[0].querySelector("[aria-hidden='true']");
    expect(handle).not.toBeNull();
    expect(handle).not.toHaveAttribute("tabindex");
    expect(handle).not.toHaveAttribute("role");
    expect(rows[1].querySelector("[aria-hidden='true']")).toBeNull();
  });

  test("with nothing in it, it says so", () => {
    renderTray([]);
    expect(screen.getByText("Nothing waits")).toBeInTheDocument();
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
  });
});

describe("bar tones", () => {
  const ghost = { ...bar(5, "Their milestone", "2026-09-22", "2026-09-24", false), tone: "ghost" as const };
  const summary = { ...bar(6, "Project", "2026-09-16", "2026-09-25", false), tone: "summary" as const };

  test("a read-only ghost and summary bar keep their accessible name and expose the tone as an attribute", () => {
    renderWithProviders(<Harness rows={[row(1, "Own", [summary]), row(2, "Other › Theirs", [ghost])]} />);
    const ghostBody = screen.getByRole("img", { name: "Their milestone, Team A, 2026-09-22 to 2026-09-24, read-only" });
    const summaryBody = screen.getByRole("img", { name: /^Project, Team A/ });
    expect(ghostBody).toHaveAttribute("data-tone", "ghost");
    expect(summaryBody).toHaveAttribute("data-tone", "summary");
    expect(ghostBody.className).not.toBe(summaryBody.className);
  });

  test("an ordinary read-only bar has no tone, and an editable bar ignores one", () => {
    renderWithProviders(<Harness rows={[row(1, "Build", [BUILD]), row(2, "Editable", [{ ...bar(7, "Edit", "2026-09-16", "2026-09-18"), tone: "ghost" }])]} />);
    expect(screen.getByRole("img", { name: /^Build,/ })).not.toHaveAttribute("data-tone");
    expect(barBody("Edit, Team A, 2026-09-16 to 2026-09-18")).not.toHaveAttribute("data-tone");
  });
});

describe("dependency arrows in the overlay", () => {
  const arrow = (id: string, fromRow: number, fromBar: number, toRow: number, toBar: number, violated = false): TimelineArrowData => ({
    id,
    from: { row: fromRow, bar: fromBar, kind: "END" },
    to: { row: toRow, bar: toBar, kind: "START" },
    violated,
    label: `${id} label`,
  });
  const drawn = (container: HTMLElement) => Array.from(container.querySelectorAll<SVGPathElement>("path[data-arrow]"));

  test("one decorative path per arrow, with data-arrow and data-violated, inside the Timeline's one svg", () => {
    const arrows = [arrow("ok", 1, 1, 2, 2), arrow("late", 2, 2, 1, 1, true)];
    const { container } = renderWithProviders(<Harness overlay={(geometry) => <TimelineArrows arrows={arrows} geometry={geometry} />} />);
    const paths = drawn(container);
    expect(paths.map((p) => [p.dataset.arrow, p.dataset.violated])).toEqual([["ok", "false"], ["late", "true"]]);
    expect(container.querySelectorAll("svg[aria-hidden='true']")).toHaveLength(1);
    expect(container.querySelector("svg[aria-hidden='true']")).toContainElement(paths[0]);
    // Discovery (row 1) ends 09-18 → x 140; Build (row 2) starts 09-21 → x 196: stub, down, straight in
    expect(paths[0].getAttribute("d")).toBe("M140 18 L148 18 L148 54 L196 54");
    expect(paths[0].querySelector("title")).toHaveTextContent("ok label");
    expect(paths[0].getAttribute("marker-end")).toBe("url(#timeline-arrowhead)");
    expect(paths[1].getAttribute("marker-end")).toBe("url(#timeline-arrowhead-violated)");
    expect(container.querySelector("marker#timeline-arrowhead")).not.toBeNull();
    expect(container.querySelector("marker#timeline-arrowhead-violated")).not.toBeNull();
  });

  test("an arrow to a row or bar that is not there draws nothing", () => {
    const { container } = renderWithProviders(
      <Harness overlay={(geometry) => <TimelineArrows arrows={[arrow("gone", 1, 1, 99, 2), arrow("nobar", 1, 1, 2, 77)]} geometry={geometry} />} />,
    );
    expect(drawn(container)).toHaveLength(0);
  });

  test("only the mounted window draws on the virtual path, from the same data-derived geometry", () => {
    stubViewport(900, 180);
    const many: TimelineRowData[] = Array.from({ length: 40 }, (_, i) => row(i + 1, `Item ${i + 1}`, [bar(i + 1, `Item ${i + 1}`, "2026-09-16", "2026-09-18")]));
    const arrows = [arrow("top", 1, 1, 2, 2), arrow("across", 2, 2, 40, 40), arrow("far", 30, 30, 31, 31)];
    const { container } = renderWithProviders(<Harness rows={many} virtualizeFrom={5} overlay={(geometry) => <TimelineArrows arrows={arrows} geometry={geometry} />} />);
    expect(drawn(container).map((p) => p.dataset.arrow)).toEqual(["top", "across"]);
    // the unmounted end (row 40, index 39) is positioned from data: y = 39 * 36 + 18
    expect(drawn(container)[1].getAttribute("d")).toMatch(/ 1422 /);
  });

  test("arrows follow committed dates: a pending resize preview does not move them", () => {
    const { container } = renderWithProviders(<Harness overlay={(geometry) => <TimelineArrows arrows={[arrow("ok", 1, 1, 2, 2)]} geometry={geometry} />} />);
    const before = drawn(container)[0].getAttribute("d");
    emit("onDragStart", { active: active("resize-end"), activatorEvent: null });
    emit("onDragMove", gesture(active("resize-end"), 3));
    expect(drawn(container)[0].getAttribute("d")).toBe(before);
  });
});

describe("the load strip", () => {
  const WEEKS = [
    { weekStart: "2026-09-14", load: 4, capacity: 10, overloaded: false, overloadMd: null, maxWip: 1, wipExceeded: false },
    { weekStart: "2026-09-21", load: 12, capacity: 10, overloaded: true, overloadMd: 2, maxWip: 3, wipExceeded: true },
  ];
  const STRIP: TimelineStripData = { label: "Weekly load", render: (scale) => <TimelineLoadStrip weeks={WEEKS} scale={scale} /> };
  const MANY: TimelineRowData[] = Array.from({ length: 40 }, (_, i) => row(i + 1, `Item ${i + 1}`, [bar(i + 1, `Item ${i + 1}`, "2026-09-16", "2026-09-18")]));
  const gridHead = () => screen.getByRole("grid").style.getPropertyValue("--timeline-head");
  // the header's rows, exposed or not (the group row and the strip are decoration)
  const headRows = () => screen.getByRole("grid").querySelector('[role="rowgroup"]')?.children.length;

  test("the header height is a pure function of whether a strip exists", () => {
    expect([headerHeight(false), headerHeight(true)]).toEqual([56, 92]);
  });

  test.each(["week", "month", "quarter"] as const)("at %s zoom the strip is a third, decorative header row with a visible caption and one cell per week", (zoom) => {
    renderWithProviders(<Harness zoom={zoom} strip={STRIP} />);
    expect(headRows()).toBe(3);
    const cells = document.querySelectorAll<HTMLElement>("[data-week]");
    expect([...cells].map((c) => c.dataset.week)).toEqual(["2026-09-14", "2026-09-21"]);
    // the second week sits at xOf(Monday): seven days after the range start (2026-09-14)
    expect(cells[1].style.left).toBe(`${7 * { week: 28, month: 8, quarter: 3 }[zoom]}px`);
    const stripRow = screen.getByText("Weekly load").closest('[aria-hidden="true"]');
    expect(stripRow).toContainElement(cells[0]);
    // decorative: not a grid row, so the row indices and the count are untouched
    expect(screen.getByRole("grid")).toHaveAttribute("aria-rowcount", "4");
    expect(within(screen.getByRole("grid")).getAllByRole("row").map((r) => r.getAttribute("aria-rowindex"))).toEqual(["1", "2", "3", "4"]);
  });

  test("the overload and the WIP mark are read from the week's data", () => {
    renderWithProviders(<Harness strip={STRIP} />);
    const second = document.querySelector<HTMLElement>('[data-week="2026-09-21"]') as HTMLElement;
    expect(second).toHaveAttribute("data-overloaded", "true");
    expect(second).toHaveAttribute("data-wip-exceeded", "true");
    expect(document.querySelector('[data-week="2026-09-14"]')).toHaveAttribute("data-overloaded", "false");
  });

  test("a week with no capacity is drawn as a figure without a column", () => {
    const none: TimelineStripData = {
      label: "Weekly load",
      render: (scale) => (
        <TimelineLoadStrip weeks={[{ weekStart: "2026-09-14", load: 3, capacity: null, overloaded: false, overloadMd: null, maxWip: 1, wipExceeded: false }]} scale={scale} />
      ),
    };
    renderWithProviders(<Harness strip={none} />);
    const cell = document.querySelector<HTMLElement>('[data-week="2026-09-14"]') as HTMLElement;
    expect(cell.querySelector('[data-part="fill"]')).toBeNull();
    expect(cell).toHaveAttribute("data-overloaded", "false");
  });

  test("with a strip --timeline-head is 92 px; without one the geometry is what it was (56 px, two header rows, no strip)", () => {
    const { unmount } = renderWithProviders(<Harness strip={STRIP} />);
    expect(gridHead()).toBe("92px");
    unmount();
    renderWithProviders(<Harness />);
    expect(gridHead()).toBe("56px");
    expect(headRows()).toBe(2);
    expect(document.querySelector("[data-week]")).toBeNull();
  });

  test("the tray drop zone's visible top clears the taller header", () => {
    let visibleBounds: (() => unknown) | undefined;
    function Probe() {
      const { droppableContainers } = useDndContext();
      useEffect(() => {
        const data = droppableContainers.get(TIMELINE_DROP_ID)?.data.current as { visibleBounds?: () => unknown } | undefined;
        if (data?.visibleBounds) visibleBounds = data.visibleBounds;
      });
      return null;
    }
    const probe = (strip?: TimelineStripData) => {
      const scale = scaleOf();
      const view = renderWithProviders(
        <TimelineDndContext scale={scale} onSchedule={vi.fn()}>
          <Probe />
          <Timeline label="Project timeline" scale={scale} onZoomChange={vi.fn()} today="2026-09-23" columns={COLUMNS} rows={ROWS} strip={strip} />
        </TimelineDndContext>,
      );
      vi.spyOn(screen.getByRole("region", { name: "Project timeline" }), "getBoundingClientRect").mockReturnValue({ left: 100, right: 900, top: 50, bottom: 650 } as DOMRect);
      const top = (visibleBounds?.() as { top: number }).top;
      view.unmount();
      return top;
    };
    expect(probe()).toBe(106);
    expect(probe(STRIP)).toBe(142);
  });

  test("a focused row is revealed below the taller header", () => {
    renderWithProviders(<Harness strip={STRIP} />);
    const cell = screen.getByRole("rowheader", { name: "Discovery" });
    const scroller = screen.getByRole("region", { name: "Project timeline" });
    vi.spyOn(scroller, "getBoundingClientRect").mockReturnValue({ left: 100, top: 50, right: 900, bottom: 650, width: 800, height: 600 } as DOMRect);
    for (const [name, value] of [["clientLeft", 0], ["clientTop", 0], ["clientWidth", 785], ["clientHeight", 600]] as const) {
      Object.defineProperty(scroller, name, { configurable: true, value });
    }
    vi.spyOn(cell, "getBoundingClientRect").mockReturnValue({ left: 110, top: 90, right: 260, bottom: 114, width: 150, height: 24 } as DOMRect);
    scroller.scrollTop = 200;
    act(() => cell.focus());
    // the clear top is 50 + 92 = 142: the cell at 90 is 52 px under it (with the 56 px header it would be 16)
    expect(scroller.scrollTop).toBe(200 - 52);
  });

  test("the virtual window follows the header height (scrollMargin)", () => {
    stubViewport(900, 180);
    const firstMounted = (strip?: TimelineStripData) => {
      const view = renderWithProviders(<Harness rows={MANY} virtualizeFrom={5} strip={strip} />);
      const scroller = screen.getByRole("region", { name: "Project timeline" });
      scroller.scrollTop = 20 * 36 + 56;
      fireEvent.scroll(scroller);
      const names = within(screen.getByRole("grid")).getAllByRole("rowheader").map((h) => Number(h.textContent?.replace("Item ", "")));
      view.unmount();
      return Math.min(...names);
    };
    // a 36 px taller header shifts the first visible row up by one
    expect(firstMounted(STRIP) - firstMounted()).toBe(-1);
  });
});

describe("the zooms prop", () => {
  const radios = () => screen.getAllByRole("radio").map((radio) => (radio as HTMLInputElement).value);

  test("the toolbar offers week / month / quarter by default, as before the Year zoom existed", () => {
    renderWithProviders(<Harness />);
    expect(radios()).toEqual(["week", "month", "quarter"]);
    expect(screen.queryByRole("radio", { name: "Year" })).not.toBeInTheDocument();
  });

  test("a plan page passes PLAN_ZOOMS: month / quarter / year, no Week", async () => {
    const user = userEvent.setup();
    const onZoomChange = vi.fn();
    renderWithProviders(<Harness zoom="year" zooms={PLAN_ZOOMS} onZoomChange={onZoomChange} />);
    expect(radios()).toEqual(["month", "quarter", "year"]);
    expect(screen.getByRole("radio", { name: "Year" })).toBeChecked();
    expect(screen.queryByRole("radio", { name: "Week" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("radio", { name: "Quarter" }));
    expect(onZoomChange).toHaveBeenCalledWith("quarter");
  });

  test("year zoom draws a year group over quarter cells, one pixel per day, and no weekend hatch", () => {
    renderWithProviders(<Harness zoom="year" zooms={PLAN_ZOOMS} />);
    expect(screen.getByText("2026")).toBeInTheDocument();
    expect(screen.getByText("2026-Q3")).toBeInTheDocument();
    expect(screen.getByText("2026-Q4")).toBeInTheDocument();
    // 2026-09-16 is two days after the range start; Wed-Fri is three days
    expect(geometryOf(barBody("Discovery, Team A, 2026-09-16 to 2026-09-18"))).toEqual({ left: "2px", width: "3px" });
    expect(document.querySelector<HTMLElement>('[role="row"] [role="gridcell"]')?.style.backgroundImage).toBe("");
  });
});

describe("the window tone", () => {
  const WINDOW: TimelineBarData = {
    id: "window:4",
    start: "2026-09-16",
    end: "2026-09-25",
    label: "Orbit window",
    describe: "Orbit, target window 2026-09-16 to 2026-09-25",
    editable: true,
    tone: "window",
  };
  const NAME = WINDOW.describe;

  test("an editable window bar keeps its name, its handles and its keyboard path, and exposes the tone", () => {
    renderWithProviders(<Harness rows={[row(4, "Orbit", [WINDOW]), ROWS[0]]} />);
    const body = barBody(NAME);
    expect(body).toHaveAttribute("data-tone", "window");
    expect(body).toHaveAttribute("tabindex");
    expect(screen.getByRole("button", { name: "Resize start of Orbit window" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Resize end of Orbit window" })).toBeInTheDocument();
    // the window fills the row (its own frame class), an ordinary bar sits inset
    expect(body.parentElement?.className).not.toBe(barBody("Discovery, Team A, 2026-09-16 to 2026-09-18").parentElement?.className);
    expect(barBody("Discovery, Team A, 2026-09-16 to 2026-09-18")).not.toHaveAttribute("data-tone");
  });

  test("a read-only window bar is a labelled image that says so", () => {
    renderWithProviders(<Harness rows={[row(4, "Orbit", [{ ...WINDOW, editable: false }])]} />);
    expect(screen.getByRole("img", { name: `${NAME}, read-only` })).toHaveAttribute("data-tone", "window");
    expect(screen.queryByRole("button", { name: /Resize/ })).not.toBeInTheDocument();
  });

  test("a window bar and the span bar of its row are two bars; the window is mounted first, so the span paints over it", () => {
    const span: TimelineBarData = { ...bar(9, "Orbit span", "2026-09-17", "2026-09-30", false), tone: "summary" };
    renderWithProviders(<Harness rows={[row(4, "Orbit", [WINDOW, span])]} />);
    const tones = Array.from(screen.getAllByRole("row")[1].querySelectorAll("[data-tone]"), (el) => el.getAttribute("data-tone"));
    expect(tones).toEqual(["window", "summary"]);
  });

  test("a read-only summary bar lets the pointer through to the window and the draw surface under it; no other bar does", () => {
    const span: TimelineBarData = { ...bar(9, "Orbit span", "2026-09-17", "2026-09-30", false), tone: "summary" };
    const ghost: TimelineBarData = { ...bar(10, "Orbit ghost", "2026-09-17", "2026-09-30", false), tone: "ghost" };
    renderWithProviders(<Harness rows={[row(4, "Orbit", [WINDOW, span, ghost])]} />);
    const frameOf = (tone: string) => (screen.getAllByRole("row")[1].querySelector(`[data-tone="${tone}"]`) as HTMLElement).parentElement as HTMLElement;
    expect(frameOf("summary").className).toMatch(/timelineBarInert/);
    expect(frameOf("window").className).not.toMatch(/timelineBarInert/);
    expect(frameOf("ghost").className).not.toMatch(/timelineBarInert/);
  });

  test("a move and each resize propose through onSchedule with the window's own id", () => {
    const onSchedule = vi.fn(() => true);
    renderWithProviders(<Harness rows={[row(4, "Orbit", [WINDOW])]} onSchedule={onSchedule} />);
    const dragged = (kind: string, days: number) => {
      const a = active(kind, WINDOW as TimelineBarData);
      emit("onDragStart", gesture(a, 0));
      emit("onDragEnd", gesture(a, days));
    };
    dragged("move", 7);
    dragged("resize-start", -2);
    dragged("resize-end", 3);
    expect(onSchedule.mock.calls).toEqual([
      ["window:4", "2026-09-23", "2026-10-02"],
      ["window:4", "2026-09-14", "2026-09-25"],
      ["window:4", "2026-09-16", "2026-09-28"],
    ]);
  });

  test("the window bar's keyboard path is the bar's: Space, ArrowRight, Space moves it by a day", async () => {
    const user = userEvent.setup();
    vi.useFakeTimers({ toFake: ["setTimeout"], shouldAdvanceTime: true });
    const onSchedule = vi.fn(() => true);
    renderWithProviders(<Harness rows={[row(4, "Orbit", [WINDOW])]} onSchedule={onSchedule} />);
    act(() => barBody(NAME).focus());
    await user.keyboard(" ");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5);
    });
    await user.keyboard("{ArrowRight}");
    await user.keyboard(" ");
    await waitFor(() => expect(onSchedule).toHaveBeenCalledExactlyOnceWith("window:4", "2026-09-17", "2026-09-26"));
  });
});

describe("the draw gesture", () => {
  const LABEL = "Orbit target window";
  const DRAW_ROW: TimelineRowData = { ...row(4, "Orbit", []), draw: { barId: "window:4", label: LABEL } };
  // The surface's live left edge is 120 px; the range starts 2026-09-14 and a day is 28 px, so x = 120 + 28 n is the left edge of day n.
  const drawActive = { id: "draw:window:4", data: { current: { kind: "draw", barId: "window:4", label: LABEL, trackLeft: () => 120 } } };
  const drawEvent = (over: unknown = null, activatorX: number | null = 120 + 2 * DAY) => ({
    active: drawActive,
    delta: { x: 0, y: 0 },
    over,
    activatorEvent: activatorX === null ? null : { clientX: activatorX, clientY: 0 },
  });
  const pointerAt = (clientX: number) =>
    act(() => {
      window.dispatchEvent(new PointerEvent("pointermove", { clientX, clientY: 0, isPrimary: true }));
    });
  const ghost = () => document.querySelector<HTMLElement>("[data-draw-preview]");
  const say = () => dndProps!.accessibility!.announcements!;
  const drawRows = [...ROWS, DRAW_ROW];

  test("the surface mounts only in a row that opts in, hidden from assistive technology and out of the tab order", () => {
    renderWithProviders(<Harness rows={drawRows} />);
    const surfaces = document.querySelectorAll<HTMLElement>("[data-draw-surface]");
    expect(surfaces).toHaveLength(1);
    expect(surfaces[0]).toHaveAttribute("aria-hidden", "true");
    for (const attribute of ["tabindex", "role", "aria-describedby", "aria-roledescription"]) expect(surfaces[0]).not.toHaveAttribute(attribute);
    expect(surfaces[0].closest('[role="row"]')).toHaveTextContent("Orbit");
    // no roving stop of its own: the row keeps its single header cell
    expect(document.querySelectorAll('[data-grid-pos][tabindex="0"]')).toHaveLength(1);
  });

  test("without draw there is no surface", () => {
    renderWithProviders(<Harness />);
    expect(document.querySelector("[data-draw-surface]")).toBeNull();
  });

  test("drawing rightwards proposes the span through onSchedule with the bar id the row would get", () => {
    const onSchedule = vi.fn(() => true);
    renderWithProviders(<Harness rows={drawRows} onSchedule={onSchedule} />);
    emit("onDragStart", drawEvent());
    // the pointer went down on day 2 (2026-09-16): a one-day ghost at once
    expect(ghost()).toHaveStyle({ left: "56px", width: "28px" });
    pointerAt(120 + 5 * DAY + 3);
    emit("onDragMove", drawEvent(zone(120)));
    expect(ghost()).toHaveStyle({ left: "56px", width: "112px" });
    pointerAt(120 + 5 * DAY + 3);
    emit("onDragEnd", drawEvent(zone(120)));
    expect(onSchedule).toHaveBeenCalledExactlyOnceWith("window:4", "2026-09-16", "2026-09-19");
    expect(ghost()).toBeNull();
  });

  test("drawing leftwards: the day under the pointer is the start", () => {
    const onSchedule = vi.fn(() => true);
    renderWithProviders(<Harness rows={drawRows} onSchedule={onSchedule} />);
    emit("onDragStart", drawEvent());
    pointerAt(120 + 5);
    emit("onDragMove", drawEvent(zone(120)));
    expect(ghost()).toHaveStyle({ left: "0px", width: "84px" });
    emit("onDragEnd", drawEvent(zone(120)));
    expect(onSchedule).toHaveBeenCalledExactlyOnceWith("window:4", "2026-09-14", "2026-09-16");
  });

  test("the day is read against the zone's LIVE left edge (a scrolled grid: negative) while the anchor keeps the day it began on", () => {
    const onSchedule = vi.fn(() => true);
    renderWithProviders(<Harness rows={drawRows} onSchedule={onSchedule} />);
    emit("onDragStart", drawEvent());
    // the grid autoscrolled 280 px left under the held pointer: the zone now starts at x = -160, the pointer sits at 120 + 5 * 28
    pointerAt(120 + 5 * DAY);
    emit("onDragEnd", drawEvent(zone(-160)));
    // (260 + 160) / 28 = day 15 of the range; the anchor is still day 2
    expect(onSchedule).toHaveBeenCalledExactlyOnceWith("window:4", "2026-09-16", "2026-09-29");
  });

  test("the pointer's day is clamped to the range: a stale zone rect after an autoscroll can put it over the sticky columns, or past the end", () => {
    const onSchedule = vi.fn(() => true);
    renderWithProviders(<Harness rows={drawRows} onSchedule={onSchedule} />);
    emit("onDragStart", drawEvent());
    // a zone left of 400 with the pointer at 120 is -280 px in: 10 days before the range start, which must read as the first day
    pointerAt(120);
    emit("onDragMove", drawEvent(zone(400)));
    expect(ghost()).toHaveStyle({ left: "0px", width: "84px" });
    emit("onDragEnd", drawEvent(zone(400)));
    expect(onSchedule).toHaveBeenLastCalledWith("window:4", "2026-09-14", "2026-09-16");
    // far beyond the last day (2026-10-11): the last day of the range
    emit("onDragStart", drawEvent());
    pointerAt(120 + 500 * DAY);
    emit("onDragEnd", drawEvent(zone(120)));
    expect(onSchedule).toHaveBeenLastCalledWith("window:4", "2026-09-16", "2026-10-11");
  });

  test("the drop still knows the draw when dnd-kit has lost the surface's data (its virtualised row left the window mid-drag)", () => {
    const onSchedule = vi.fn(() => true);
    renderWithProviders(<Harness rows={drawRows} onSchedule={onSchedule} />);
    emit("onDragStart", drawEvent());
    pointerAt(120 + 5 * DAY);
    const orphan = { id: "draw:window:4", data: { current: {} } };
    emit("onDragMove", { ...drawEvent(zone(120)), active: orphan });
    expect(ghost()).toHaveStyle({ left: "56px", width: "112px" });
    emit("onDragEnd", { ...drawEvent(zone(120)), active: orphan });
    expect(onSchedule).toHaveBeenCalledExactlyOnceWith("window:4", "2026-09-16", "2026-09-19");
  });

  test("a click that never leaves its day is a one-day window", () => {
    const onSchedule = vi.fn(() => true);
    renderWithProviders(<Harness rows={drawRows} onSchedule={onSchedule} />);
    emit("onDragStart", drawEvent());
    emit("onDragEnd", drawEvent(zone(120)));
    expect(onSchedule).toHaveBeenCalledExactlyOnceWith("window:4", "2026-09-16", "2026-09-16");
  });

  test("while the pointer is not over the track zone the last span is kept, and a drop there still proposes it", () => {
    const onSchedule = vi.fn(() => true);
    renderWithProviders(<Harness rows={drawRows} onSchedule={onSchedule} />);
    emit("onDragStart", drawEvent());
    pointerAt(120 + 5 * DAY);
    emit("onDragMove", drawEvent(zone(120)));
    pointerAt(2000);
    emit("onDragMove", drawEvent({ id: "somewhere-else", data: { current: {} } }));
    expect(ghost()).toHaveStyle({ left: "56px", width: "112px" });
    emit("onDragEnd", drawEvent(null));
    expect(onSchedule).toHaveBeenCalledExactlyOnceWith("window:4", "2026-09-16", "2026-09-19");
  });

  test("a draw with no pointer-down position (not a pointer activator) has no anchor and proposes nothing", () => {
    const onSchedule = vi.fn(() => true);
    renderWithProviders(<Harness rows={drawRows} onSchedule={onSchedule} />);
    emit("onDragStart", drawEvent(null, null));
    expect(ghost()).toBeNull();
    emit("onDragEnd", drawEvent(zone(120)));
    expect(onSchedule).not.toHaveBeenCalled();
  });

  test("cancelling proposes nothing and takes the ghost away", () => {
    const onSchedule = vi.fn(() => true);
    renderWithProviders(<Harness rows={drawRows} onSchedule={onSchedule} />);
    emit("onDragStart", drawEvent());
    pointerAt(120 + 5 * DAY);
    emit("onDragMove", drawEvent(zone(120)));
    expect(ghost()).not.toBeNull();
    emit("onDragCancel", {});
    expect(ghost()).toBeNull();
    expect(onSchedule).not.toHaveBeenCalled();
  });

  test("the same seam as a bar move: a page that refuses the proposal gets the 'not changed' announcement, never a drop", () => {
    renderWithProviders(<Harness rows={drawRows} onSchedule={vi.fn(() => false)} />);
    emit("onDragStart", drawEvent());
    pointerAt(120 + 5 * DAY);
    emit("onDragMove", drawEvent(zone(120)));
    emit("onDragEnd", drawEvent(zone(120)));
    expect(say().onDragEnd({ active: drawActive } as never)).toBe(`${LABEL} was not changed: a save is still running. Try again in a moment.`);
  });

  test("announcements: pick-up, each distinct span once, the drop, the cancel", () => {
    renderWithProviders(<Harness rows={drawRows} />);
    expect(say().onDragStart({ active: drawActive } as never)).toBe("Drawing Orbit target window. Move the pointer across the days and release; Escape cancels.");
    emit("onDragStart", drawEvent());
    pointerAt(120 + 5 * DAY);
    emit("onDragMove", drawEvent(zone(120)));
    expect(say().onDragMove?.({ active: drawActive } as never)).toBe("Orbit target window: 2026-09-16 to 2026-09-19");
    emit("onDragMove", drawEvent(zone(120)));
    expect(say().onDragMove?.({ active: drawActive } as never)).toBeUndefined();
    emit("onDragEnd", drawEvent(zone(120)));
    expect(say().onDragEnd({ active: drawActive } as never)).toBe("Drew Orbit target window: 2026-09-16 to 2026-09-19.");
    expect(say().onDragEnd({ active: drawActive } as never)).toBeUndefined();
    emit("onDragStart", drawEvent());
    emit("onDragCancel", {});
    expect(say().onDragCancel?.({ active: drawActive } as never)).toBe("Cancelled; nothing was drawn for Orbit target window.");
  });

  test("it keeps the bars' autoscroll (along time only) and leaves the surface untransformed", () => {
    renderWithProviders(<Harness rows={drawRows} />);
    emit("onDragStart", drawEvent());
    expect(dndProps?.autoScroll).toEqual({ threshold: { x: 0.05, y: 0.02 } });
    expect(dndProps?.modifiers?.[0]({ active: drawActive, transform: { x: 40, y: 17, scaleX: 1, scaleY: 1 } } as never)).toMatchObject({ x: 40, y: 17 });
    emit("onDragCancel", {});
  });

  test("the window pointer listener is added at the start and removed on drop and on cancel", () => {
    const add = vi.spyOn(window, "addEventListener");
    const remove = vi.spyOn(window, "removeEventListener");
    const moves = (spy: { mock: { calls: unknown[][] } }) => spy.mock.calls.filter(([type]) => type === "pointermove").length;
    try {
      renderWithProviders(<Harness rows={drawRows} />);
      emit("onDragStart", drawEvent());
      expect(moves(add)).toBe(1);
      emit("onDragEnd", drawEvent(zone(120)));
      expect(moves(remove)).toBe(1);
      emit("onDragStart", drawEvent());
      emit("onDragCancel", {});
      expect(moves(remove)).toBe(2);
    } finally {
      add.mockRestore();
      remove.mockRestore();
    }
  });

  test("it collides like a bar does: with the track zone and never with the row zone", () => {
    renderWithProviders(<Harness rows={drawRows} />);
    emit("onDragStart", drawEvent());
    const container = (id: string) => ({ id, rect: { current: { left: 0, top: 0, right: 100, bottom: 100, width: 100, height: 100 } }, data: { current: {} } });
    const found = dndProps?.collisionDetection?.({
      active: drawActive,
      collisionRect: { left: 0, top: 0, right: 10, bottom: 10, width: 10, height: 10 },
      droppableRects: new Map([
        [TIMELINE_DROP_ID, container(TIMELINE_DROP_ID).rect.current],
        [TIMELINE_ROW_DROP_ID, container(TIMELINE_ROW_DROP_ID).rect.current],
      ]),
      droppableContainers: [container(TIMELINE_DROP_ID), container(TIMELINE_ROW_DROP_ID)],
      pointerCoordinates: { x: 50, y: 50 },
    } as never);
    expect(found?.map((collision) => collision.id)).toEqual([TIMELINE_DROP_ID]);
    emit("onDragCancel", {});
  });
});

describe("focusRow", () => {
  const MANY: TimelineRowData[] = Array.from({ length: 40 }, (_, i) => row(i + 1, `Item ${i + 1}`, [bar(i + 1, `Item ${i + 1}`, "2026-09-16", "2026-09-18")]));
  const handleRef = () => createRef<TimelineHandle>();
  const call = (ref: { current: TimelineHandle | null }, rowId: number | string) => act(() => ref.current?.focusRow(rowId));
  const rect = (left: number, top: number, width = 100, height = 24) => ({ left, top, right: left + width, bottom: top + height, width, height }) as DOMRect;

  test("a mounted row: its header cell takes the focus and becomes the tab stop", () => {
    const ref = handleRef();
    renderWithProviders(<Harness ref={ref} />);
    call(ref, 2);
    expect(screen.getByRole("rowheader", { name: "Build" })).toHaveFocus();
    expect(screen.getByRole("rowheader", { name: "Build" })).toHaveAttribute("tabindex", "0");
    expect(screen.getByRole("rowheader", { name: "Discovery" })).toHaveAttribute("tabindex", "-1");
  });

  test("it reveals the row clear of the sticky header even though a programmatic focus is not :focus-visible", () => {
    const ref = handleRef();
    renderWithProviders(<Harness ref={ref} />);
    const cell = screen.getByRole("rowheader", { name: "Build" });
    const scroller = screen.getByRole("region", { name: "Project timeline" });
    // the scroller shows y 50..650 and its sticky header takes 56 px (y < 106); the row sits under the header
    vi.spyOn(scroller, "getBoundingClientRect").mockReturnValue(rect(100, 50, 800, 600));
    for (const [name, value] of [["clientLeft", 0], ["clientTop", 0], ["clientWidth", 785], ["clientHeight", 600]] as const) {
      Object.defineProperty(scroller, name, { configurable: true, value });
    }
    vi.spyOn(cell, "getBoundingClientRect").mockReturnValue(rect(110, 90, 150));
    scroller.scrollTop = 200;
    const matches = vi.spyOn(cell, "matches").mockImplementation((selector: string) => selector !== ":focus-visible");
    call(ref, 2);
    expect(scroller.scrollTop).toBe(200 - 16);
    matches.mockRestore();
  });

  test("an unknown row id does nothing", () => {
    const ref = handleRef();
    renderWithProviders(<Harness ref={ref} />);
    expect(() => call(ref, 99)).not.toThrow();
    expect(document.activeElement).toBe(document.body);
  });

  test("a row the virtual path has not mounted is scrolled to and focused once it mounts; a mounted one at once", async () => {
    stubViewport(900, 180);
    const ref = handleRef();
    renderWithProviders(<Harness ref={ref} rows={MANY} virtualizeFrom={5} />);
    call(ref, 2);
    expect(screen.getByRole("rowheader", { name: "Item 2" })).toHaveFocus();
    expect(screen.queryByRole("rowheader", { name: "Item 40" })).not.toBeInTheDocument();
    call(ref, 40);
    const scroller = screen.getByRole("region", { name: "Project timeline" });
    scroller.scrollTop = 35 * 36;
    fireEvent.scroll(scroller);
    await waitFor(() => expect(screen.getByRole("rowheader", { name: "Item 40" })).toHaveFocus());
  });

  test("the wish to focus an unmounted row is dropped by a keypress, like the arrow keys' (it cannot steal focus later)", async () => {
    stubViewport(900, 180);
    const ref = handleRef();
    renderWithProviders(<Harness ref={ref} rows={MANY} virtualizeFrom={5} />);
    call(ref, 40);
    const grid = screen.getByRole("grid");
    fireEvent.keyDown(grid.querySelector('[data-grid-pos="1,0"]') as HTMLElement, { key: "Shift" });
    const scroller = screen.getByRole("region", { name: "Project timeline" });
    scroller.scrollTop = 35 * 36;
    fireEvent.scroll(scroller);
    await screen.findByRole("rowheader", { name: "Item 40" });
    expect(screen.getByRole("rowheader", { name: "Item 40" })).not.toHaveFocus();
  });
});

describe("public holidays", () => {
  // The range starts on Monday 2026-09-14 (28 px a day at week zoom): Wednesday the 16th starts at x = 56.
  const HOLIDAYS = [{ date: "2026-09-16", name: "Founders' Day" }];
  // The first body row's track: the LAST gridcell of the row (its left cells come first).
  const trackOf = () => Array.from(document.querySelectorAll<HTMLElement>('[aria-rowindex="2"] [role="gridcell"]')).at(-1);
  const gradientCount = (css: string | undefined) => (css?.match(/gradient\(/g) ?? []).length;

  test("a holiday adds a second gradient layer to the row hatch, on top of the weekend one", () => {
    renderWithProviders(<Harness holidays={HOLIDAYS} />);
    const css = trackOf()?.style.backgroundImage;
    expect(gradientCount(css)).toBe(2);
    expect(css).toMatch(/^linear-gradient/);
    expect(css).toContain("repeating-linear-gradient");
    expect(css).toContain("56px");
    expect(css).toContain("84px");
  });

  test("without a holiday in range the hatch is the weekend layer alone", () => {
    renderWithProviders(<Harness holidays={[{ date: "2027-03-01", name: "Elsewhere" }]} />);
    expect(gradientCount(trackOf()?.style.backgroundImage)).toBe(1);
  });

  test("the holiday's header day cell is tinted and named in its title; the other day cells are not", () => {
    renderWithProviders(<Harness holidays={HOLIDAYS} />);
    const cells = document.querySelectorAll<HTMLElement>("[data-holiday]");
    expect(cells).toHaveLength(1);
    expect(cells[0]).toHaveAttribute("title", "Public holiday: Founders' Day");
    expect(cells[0]).toHaveTextContent("16");
    expect(document.querySelectorAll("[title^='Public holiday']")).toHaveLength(1);
  });

  test("a visually hidden paragraph lists the holidays in view with their dates, since the header and tracks are aria-hidden", () => {
    renderWithProviders(
      <Harness
        holidays={[
          { date: "2026-10-05", name: "Second" },
          { date: "2026-09-16", name: "Founders' Day" },
          { date: "2027-03-01", name: "Out of view" },
        ]}
      />,
    );
    expect(screen.getByText("Public holidays shown: 2026-09-16 Founders' Day, 2026-10-05 Second")).toBeInTheDocument();
  });

  test("at quarter zoom nothing is drawn or listed (3 px a day is noise, like the weekend hatch)", () => {
    renderWithProviders(<Harness holidays={HOLIDAYS} zoom="quarter" />);
    expect(screen.queryByText(/Public holidays shown/)).not.toBeInTheDocument();
    expect(gradientCount(trackOf()?.style.backgroundImage)).toBe(0);
    expect(document.querySelectorAll("[data-holiday]")).toHaveLength(0);
  });

  test("at month zoom the row is hatched and the paragraph lists, but the week cells carry no title", () => {
    renderWithProviders(<Harness holidays={HOLIDAYS} zoom="month" />);
    expect(gradientCount(trackOf()?.style.backgroundImage)).toBe(2);
    expect(screen.getByText(/Public holidays shown: 2026-09-16 Founders' Day/)).toBeInTheDocument();
    expect(document.querySelectorAll("[data-holiday]")).toHaveLength(0);
  });

  test("above ten holidays in view the paragraph counts them and names only the ones from today (2026-09-23) on, at most ten", () => {
    const many = ["2026-09-14", "2026-09-15", "2026-09-21", "2026-09-22", "2026-09-28", "2026-09-29", "2026-10-05", "2026-10-06", "2026-10-07", "2026-10-08", "2026-10-09", "2026-09-30"].map(
      (date) => ({ date, name: `H${date.slice(5)}` }),
    );
    renderWithProviders(<Harness holidays={many} />);
    const text = screen.getByText(/12 public holidays shown; the next ones:/).textContent ?? "";
    expect(text).toContain("2026-09-28 H09-28");
    expect(text).toContain("2026-10-09 H10-09");
    expect(text).not.toContain("2026-09-14");
    expect(text).not.toContain("2026-09-22");
    expect(text.split(", ")).toHaveLength(8);
  });

  test("a failed dictionary load shows a small muted note, and none otherwise", () => {
    const { unmount } = renderWithProviders(<Harness holidaysFailed />);
    expect(screen.getByText("Public holidays could not be loaded; days off are not marked.")).toBeInTheDocument();
    unmount();
    renderWithProviders(<Harness />);
    expect(screen.queryByText(/could not be loaded/)).not.toBeInTheDocument();
  });

  test("no holidays prop: nothing changes (no paragraph, one gradient layer)", () => {
    renderWithProviders(<Harness />);
    expect(screen.queryByText(/Public holidays shown/)).not.toBeInTheDocument();
    expect(gradientCount(trackOf()?.style.backgroundImage)).toBe(1);
  });
});

describe("the critical-path highlight (v0.7)", () => {
  const critical = (b: TimelineBarData, over: Partial<TimelineBarData> = {}): TimelineBarData => ({ ...b, emphasis: "critical", ...over });
  const arrow = (id: string, critical?: boolean, violated = false): TimelineArrowData => ({
    id,
    from: { row: 1, bar: 1, kind: "END" },
    to: { row: 2, bar: 2, kind: "START" },
    violated,
    critical,
    label: `${id} label`,
  });

  test("the toolbar slot renders the page's controls after Today, inside the toolbar group", () => {
    renderWithProviders(<Harness toolbar={<button type="button">Page control</button>} />);
    const group = screen.getByRole("group", { name: "Timeline controls" });
    const labels = within(group).getAllByRole("button").map((b) => b.textContent);
    expect(labels).toEqual(expect.arrayContaining(["Today", "Page control"]));
    expect(labels.indexOf("Page control")).toBeGreaterThan(labels.indexOf("Today"));
  });

  test("an emphasised bar carries data-critical on the editable and the read-only bar, whatever its tone; the others carry nothing", () => {
    const rows = [
      row(1, "Discovery", [critical(DISCOVERY)]),
      row(2, "Build", [critical(BUILD, { tone: "ghost" })]),
      row(3, "Launch", [bar(3, "Launch", "2026-09-28", "2026-09-30", false)]),
    ];
    renderWithProviders(<Harness rows={rows} />);
    expect(screen.getByRole("button", { name: /^Discovery, Team A/ })).toHaveAttribute("data-critical", "true");
    expect(screen.getByRole("img", { name: /^Build, Team A/ })).toHaveAttribute("data-critical", "true");
    expect(screen.getByRole("img", { name: /^Launch, Team A/ })).not.toHaveAttribute("data-critical");
  });

  test("a bar without emphasis renders exactly as before (no critical attribute, no critical class)", () => {
    const { container } = renderWithProviders(<Harness />);
    expect(container.querySelector("[data-critical]")).toBeNull();
    expect(container.innerHTML).not.toMatch(/timelineBarCritical/);
  });

  test("a critical arrow has data-critical and its own arrowhead; the plain and the violated ones (red, even if flagged) do not", () => {
    const arrows = [arrow("plain"), arrow("crit", true), arrow("late", true, true)];
    const { container } = renderWithProviders(<Harness overlay={(geometry) => <TimelineArrows arrows={arrows} geometry={geometry} />} />);
    const paths = Array.from(container.querySelectorAll<SVGPathElement>("path[data-arrow]"));
    expect(paths.map((p) => [p.dataset.arrow, p.dataset.critical])).toEqual([
      ["plain", undefined],
      ["crit", "true"],
      ["late", undefined],
    ]);
    expect(paths[0].getAttribute("marker-end")).toBe("url(#timeline-arrowhead)");
    expect(paths[1].getAttribute("marker-end")).toBe("url(#timeline-arrowhead-critical)");
    // a violated arrow stays red, flagged or not
    expect(paths[2].getAttribute("marker-end")).toBe("url(#timeline-arrowhead-violated)");
    expect(container.querySelector("marker#timeline-arrowhead-critical")).not.toBeNull();
  });

  test("with no critical arrow there is no third marker", () => {
    const { container } = renderWithProviders(<Harness overlay={(geometry) => <TimelineArrows arrows={[arrow("plain")]} geometry={geometry} />} />);
    expect(container.querySelector("marker#timeline-arrowhead-critical")).toBeNull();
  });
});
