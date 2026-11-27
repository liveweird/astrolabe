import { createRef, useEffect, type ComponentProps } from "react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import userEvent from "@testing-library/user-event";
import { useDndContext } from "@dnd-kit/core";
import Timeline, { type TimelineHandle } from "./Timeline";
import TimelineColumnsControl from "./TimelineColumnsControl";
import TimelineDndContext from "./TimelineDndContext";
import { useTimelineColumns } from "../hooks/useTimelineColumns";
import { TIMELINE_DROP_ID } from "../hooks/useTimelinePreview";
import type { TimelineBarData, TimelineColumn, TimelineRowData } from "../utils/timelineModel";
import { makeScale, toEpochDay } from "../utils/timelineScale";
import { act, fireEvent, renderWithProviders, screen, waitFor, within } from "../test/render";
import { withoutGeneratedIds } from "../test/generatedIds";
import classes from "../theme.module.css";

// The REAL hook, control and drag context: what a page does (no dnd-kit mock). The pane is 160 + 100 + 80 + 50 px; the range
// starts Monday 2026-09-14 at 28 px a day, so today (the 23rd) is day 9.
const COLUMNS: TimelineColumn[] = [
  { id: "name", header: "Milestone", width: 160 },
  { id: "team", header: "Team", width: 100, hideable: true },
  { id: "estimate", header: "Estimate", width: 80, hideable: true },
  { id: "ops", header: "Operations", width: 50 },
];
const STORAGE_KEY = "astrolabe.viewSettings.timeline.columns.project";
const FULL_PANE = 390;
const PANE_WITHOUT_TEAM = 290;
const BARE_PANE = 210;
const TRACK = 28 * 28;

const bar = (id: number, name: string): TimelineBarData => ({
  id,
  start: "2026-09-16",
  end: "2026-09-18",
  label: name,
  describe: `${name}, 2026-09-16 to 2026-09-18`,
  editable: true,
});
const row = (id: number, name: string): TimelineRowData => ({
  id,
  cells: [name, "Team A", "5", (stop) => <button {...stop}>{`Operations for ${name}`}</button>],
  bars: [bar(id, name)],
});
const ROWS = [row(1, "Discovery"), row(2, "Build"), row(3, "Launch")];
const MANY = Array.from({ length: 40 }, (_, i) => row(i + 1, `Item ${i + 1}`));
const scale = makeScale("week", { from: toEpochDay("2026-09-14"), to: toEpochDay("2026-10-11") });

function Page({ rows = ROWS, withToolbar = true, ...rest }: { rows?: TimelineRowData[]; withToolbar?: boolean } & Partial<ComponentProps<typeof Timeline>>) {
  const view = useTimelineColumns("project", COLUMNS);
  return (
    <TimelineDndContext scale={scale} onSchedule={vi.fn(() => true)}>
      <Timeline
        label="Project timeline"
        scale={scale}
        onZoomChange={vi.fn()}
        today="2026-09-23"
        columns={COLUMNS}
        hiddenColumns={view.hidden}
        rows={rows}
        toolbar={withToolbar ? <TimelineColumnsControl view={view} /> : undefined}
        {...rest}
      />
    </TimelineDndContext>
  );
}

/** happy-dom lays nothing out: give the scroller a size for the code that reads it (the virtualiser, "Scroll to today"). */
const originals = (["clientWidth", "clientHeight"] as const).map((name) => [name, Object.getOwnPropertyDescriptor(HTMLElement.prototype, name)] as const);
function stubViewport(width: number, height: number) {
  for (const [name, value] of [["clientWidth", width], ["clientHeight", height]] as const) {
    Object.defineProperty(HTMLElement.prototype, name, { configurable: true, get: () => value });
  }
}

beforeEach(() => localStorage.clear());
afterEach(() => {
  for (const [name, descriptor] of originals) {
    if (descriptor === undefined) delete (HTMLElement.prototype as unknown as Record<string, unknown>)[name];
    else Object.defineProperty(HTMLElement.prototype, name, descriptor);
  }
});

const grid = () => screen.getByRole("grid", { name: "Project timeline" });
const scroller = () => screen.getByRole("region", { name: "Project timeline" });
const collapse = async (user: ReturnType<typeof userEvent.setup>) => user.click(screen.getByRole("button", { name: "Hide columns" }));
const hideTeam = () => localStorage.setItem(STORAGE_KEY, JSON.stringify({ collapsed: false, hidden: ["team"] }));
const pos = (r: number, c: number) => grid().querySelector<HTMLElement>(`[data-grid-pos="${r},${c}"]`);
const positionsOf = (r: number) => Array.from(grid().querySelectorAll<HTMLElement>(`[data-grid-pos^="${r},"]`)).map((element) => element.dataset.gridPos);

describe("a Timeline with hidden columns", () => {
  test("the header and every row lose the cell; nothing else is renumbered", async () => {
    const user = userEvent.setup();
    renderWithProviders(<Page />);
    expect(within(grid()).getAllByRole("columnheader").map((h) => h.textContent)).toEqual(["Milestone", "Team", "Estimate", "Operations"]);
    expect(positionsOf(1)).toEqual(["1,0", "1,1", "1,2", "1,3", "1,4", "1,5", "1,6"]);
    await collapse(user);
    expect(within(grid()).getAllByRole("columnheader").map((h) => h.textContent)).toEqual(["Milestone", "Operations"]);
    for (const r of [1, 2, 3]) {
      // the bar's cells keep their numbers: a hole, never a re-index
      expect(positionsOf(r)).toEqual([`${r},0`, `${r},3`, `${r},4`, `${r},5`, `${r},6`]);
    }
    expect(screen.queryByText("Team A")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Discovery, 2026-09-16 to 2026-09-18" })).toHaveAttribute("data-grid-pos", "1,4");
  });

  test("the pane narrows and everything measured from it follows: the grid, --timeline-left, the rows, the today line and the overlay", async () => {
    const user = userEvent.setup();
    renderWithProviders(<Page overlay={() => <line />} />);
    const todayLine = () => document.querySelector<HTMLElement>(`.${classes.timelineToday}`);
    const overlay = () => document.querySelector<HTMLElement>(`.${classes.timelineOverlay}`);
    const pane = () => Array.from(document.querySelectorAll<HTMLElement>(`.${classes.timelineLeft}`)).map((element) => element.style.width);
    expect(grid().style.width).toBe(`${FULL_PANE + TRACK}px`);
    expect(grid().style.getPropertyValue("--timeline-left")).toBe(`${FULL_PANE}px`);
    expect(todayLine()?.style.left).toBe(`${FULL_PANE + 9 * 28 + 14}px`);
    expect(overlay()?.style.left).toBe(`${FULL_PANE}px`);
    expect(new Set(pane())).toEqual(new Set([`${FULL_PANE}px`]));
    await collapse(user);
    expect(grid().style.width).toBe(`${BARE_PANE + TRACK}px`);
    expect(grid().style.getPropertyValue("--timeline-left")).toBe(`${BARE_PANE}px`);
    expect(todayLine()?.style.left).toBe(`${BARE_PANE + 9 * 28 + 14}px`);
    expect(overlay()?.style.left).toBe(`${BARE_PANE}px`);
    expect(new Set(pane())).toEqual(new Set([`${BARE_PANE}px`]));
  });

  test("the cells that stay are the ones the page gave: a picked column is hidden alone", () => {
    hideTeam();
    renderWithProviders(<Page />);
    expect(within(grid()).getAllByRole("columnheader").map((h) => h.textContent)).toEqual(["Milestone", "Estimate", "Operations"]);
    expect(grid().style.getPropertyValue("--timeline-left")).toBe(`${PANE_WITHOUT_TEAM}px`);
    expect(positionsOf(2).slice(0, 3)).toEqual(["2,0", "2,2", "2,3"]);
  });

  test("an absent hiddenColumns prop draws exactly what an empty set draws", () => {
    const plain = renderWithProviders(<Page withToolbar={false} hiddenColumns={undefined} />);
    const without = withoutGeneratedIds(plain.container.innerHTML);
    plain.unmount();
    const empty = renderWithProviders(<Page withToolbar={false} hiddenColumns={new Set()} />);
    expect(withoutGeneratedIds(empty.container.innerHTML)).toBe(without);
  });

  test("Scroll to today centres in the wider track: with the Team column gone the track part of the viewport is 100 px wider", () => {
    stubViewport(560, 300);
    hideTeam();
    renderWithProviders(<Page />);
    fireEvent.click(screen.getByRole("button", { name: "Scroll to today" }));
    // today's centre is 9 * 28 + 14 = 266; the track part of the viewport is 560 - 290 = 270 wide (all four columns: 170, scroll 181)
    expect(scroller().scrollLeft).toBe(266 - 135);
  });

  test("Scroll to today with the whole pane gone: 560 - 210 = 350 wide", async () => {
    stubViewport(560, 300);
    const user = userEvent.setup();
    renderWithProviders(<Page />);
    await collapse(user);
    await user.click(screen.getByRole("button", { name: "Scroll to today" }));
    expect(scroller().scrollLeft).toBe(266 - 175);
  });

  test("the track zone's visible left edge is the scroller's left plus the DRAWN pane", async () => {
    const user = userEvent.setup();
    let visibleBounds: (() => unknown) | undefined;
    function Probe() {
      const { droppableContainers } = useDndContext();
      useEffect(() => {
        const data = droppableContainers.get(TIMELINE_DROP_ID)?.data.current as { visibleBounds?: () => unknown } | undefined;
        if (data?.visibleBounds) visibleBounds = data.visibleBounds;
      });
      return null;
    }
    function WithProbe() {
      const view = useTimelineColumns("project", COLUMNS);
      return (
        <TimelineDndContext scale={scale} onSchedule={vi.fn(() => true)}>
          <Probe />
          <Timeline label="Project timeline" scale={scale} onZoomChange={vi.fn()} today="2026-09-23" columns={COLUMNS} hiddenColumns={view.hidden} rows={ROWS} toolbar={<TimelineColumnsControl view={view} />} />
        </TimelineDndContext>
      );
    }
    renderWithProviders(<WithProbe />);
    vi.spyOn(scroller(), "getBoundingClientRect").mockReturnValue({ left: 100, right: 900, top: 50, bottom: 650 } as DOMRect);
    expect(visibleBounds?.()).toEqual({ left: 100 + FULL_PANE, right: 900, top: 106, bottom: 650 });
    await collapse(user);
    expect(visibleBounds?.()).toEqual({ left: 100 + BARE_PANE, right: 900, top: 106, bottom: 650 });
  });
});

describe("the roving grid over hidden columns", () => {
  test("→ from the name lands on the next drawn column, then on the bar", async () => {
    const user = userEvent.setup();
    renderWithProviders(<Page />);
    await collapse(user);
    act(() => pos(1, 0)?.focus());
    await user.keyboard("{ArrowRight}");
    expect(screen.getByRole("button", { name: "Operations for Discovery" })).toHaveFocus();
    await user.keyboard("{ArrowRight}");
    expect(screen.getByRole("button", { name: "Discovery, 2026-09-16 to 2026-09-18" })).toHaveFocus();
    await user.keyboard("{ArrowLeft}{ArrowLeft}");
    expect(screen.getByRole("rowheader", { name: "Discovery" })).toHaveFocus();
  });

  test("Home and End step over the hole, and ↓ keeps the column", async () => {
    const user = userEvent.setup();
    renderWithProviders(<Page />);
    await collapse(user);
    act(() => pos(1, 3)?.focus());
    await user.keyboard("{ArrowDown}");
    expect(screen.getByRole("button", { name: "Operations for Build" })).toHaveFocus();
    await user.keyboard("{End}");
    expect(screen.getByRole("button", { name: "Resize end of Build" })).toHaveFocus();
    await user.keyboard("{Home}");
    expect(screen.getByRole("rowheader", { name: "Build" })).toHaveFocus();
  });

  test("there is one tab stop; one on a column that gets hidden moves to that row's header", async () => {
    const user = userEvent.setup();
    renderWithProviders(<Page />);
    act(() => pos(2, 1)?.focus());
    expect(document.querySelectorAll('[data-grid-pos][tabindex="0"]')).toHaveLength(1);
    expect(pos(2, 1)).toHaveAttribute("tabindex", "0");
    await collapse(user);
    const stops = document.querySelectorAll('[data-grid-pos][tabindex="0"]');
    expect(stops).toHaveLength(1);
    expect(stops[0]).toBe(screen.getByRole("rowheader", { name: "Build" }));
    // a stop on a column that stays is left alone
    act(() => pos(3, 3)?.focus());
    await user.click(screen.getByRole("button", { name: "Show columns" }));
    expect(pos(3, 3)).toHaveAttribute("tabindex", "0");
  });

  test("focusRow reaches the row header of a mounted row", async () => {
    const user = userEvent.setup();
    const ref = createRef<TimelineHandle>();
    renderWithProviders(<Page ref={ref} />);
    await collapse(user);
    act(() => ref.current?.focusRow(2));
    expect(screen.getByRole("rowheader", { name: "Build" })).toHaveFocus();
  });

  test("on the virtual path focusRow and Ctrl+End still land on the same cells", async () => {
    stubViewport(900, 180);
    const user = userEvent.setup();
    const ref = createRef<TimelineHandle>();
    renderWithProviders(<Page ref={ref} rows={MANY} virtualizeFrom={5} />);
    await collapse(user);
    act(() => ref.current?.focusRow(40));
    scroller().scrollTop = 35 * 36;
    fireEvent.scroll(scroller());
    await waitFor(() => expect(screen.getByRole("rowheader", { name: "Item 40" })).toHaveFocus());

    act(() => screen.getByRole("rowheader", { name: "Item 40" }).blur());
    act(() => pos(1, 0)?.focus());
    scroller().scrollTop = 0;
    fireEvent.scroll(scroller());
    expect(fireEvent.keyDown(pos(1, 0) as HTMLElement, { key: "End", ctrlKey: true })).toBe(false);
    scroller().scrollTop = 35 * 36;
    fireEvent.scroll(scroller());
    await waitFor(() => expect(screen.getByRole("button", { name: "Resize end of Item 40" })).toHaveFocus());
    expect(screen.getByRole("button", { name: "Resize end of Item 40" })).toHaveAttribute("data-grid-pos", "40,6");
  });
});
