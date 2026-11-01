import { useEffect, type ComponentProps } from "react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import userEvent from "@testing-library/user-event";
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { DndContext, useDndContext } from "@dnd-kit/core";
import Timeline from "./Timeline";
import TimelineArrows from "./TimelineArrows";
import TimelineDndContext from "./TimelineDndContext";
import TimelineLoadStrip from "./TimelineLoadStrip";
import TimelineUnscheduledTray, { type TrayItem } from "./TimelineUnscheduledTray";
import { TIMELINE_DROP_ID } from "../hooks/useTimelinePreview";
import {
  headerHeight,
  type TimelineArrowData,
  type TimelineBarData,
  type TimelineColumn,
  type TimelineGeometry,
  type TimelineRowData,
  type TimelineStripData,
} from "../utils/timelineModel";
import { makeScale, toEpochDay, type Zoom } from "../utils/timelineScale";
import { renderWithProviders } from "../test/render";

// happy-dom has no layout, so a pointer drag cannot run here (e2e drives the real one). The context is wrapped to hand the test
// its handlers and announcements: what happens WHEN dnd-kit reports a gesture is ours to pin.
let dndProps: ComponentProps<typeof DndContext> | null = null;
vi.mock("@dnd-kit/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@dnd-kit/core")>();
  return {
    ...actual,
    DndContext: (props: ComponentProps<typeof actual.DndContext>) => {
      dndProps = props;
      return <actual.DndContext {...props} />;
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
  onZoomChange = vi.fn(),
  ...rest
}: Partial<Omit<ComponentProps<typeof Timeline>, "scale">> & { zoom?: Zoom; onSchedule?: (id: number | string, start: string, end: string) => boolean }) {
  const scale = scaleOf(zoom);
  return (
    <TimelineDndContext scale={scale} onSchedule={onSchedule}>
      <Timeline label="Project timeline" scale={scale} onZoomChange={onZoomChange} today="2026-09-23" columns={COLUMNS} rows={rows} {...rest} />
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
