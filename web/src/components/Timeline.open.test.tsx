import { createRef, useEffect, type ComponentProps } from "react";
import { afterEach, describe, expect, test, vi } from "vitest";
import Timeline, { type TimelineHandle } from "./Timeline";
import TimelineColumnsControl from "./TimelineColumnsControl";
import TimelineDndContext from "./TimelineDndContext";
import { useTimelineColumns } from "../hooks/useTimelineColumns";
import type { TimelineBarData, TimelineColumn, TimelineRowData } from "../utils/timelineModel";
import { OPEN_LEAD_PX } from "../utils/timelineOpen";
import { makeScale, toEpochDay } from "../utils/timelineScale";
import { act, renderWithProviders, screen } from "../test/render";

// Where a Gantt opens (`timeline.md` "Where a Gantt opens"): the REAL Timeline over a year of weeks at 28 px a day (2026-01-05 to 2026-12-27, 9,996 px). The scroller is 1,000 px wide with a 200 px pane: 800 px of grid, a quarter of it 200 px.
const COLUMNS: TimelineColumn[] = [
  { id: "name", header: "Milestone", width: 160 },
  { id: "ops", header: "Operations", width: 40 },
];
const WIDER: TimelineColumn[] = [
  { id: "name", header: "Milestone", width: 220 },
  { id: "ops", header: "Operations", width: 80 },
];
const WEEK = makeScale("week", { from: toEpochDay("2026-01-05"), to: toEpochDay("2026-12-27") });
const QUARTER = makeScale("quarter", { from: toEpochDay("2025-10-01"), to: toEpochDay("2027-03-31") });
const TODAY = "2026-06-10";
const todayX = WEEK.xOf(toEpochDay(TODAY)) + WEEK.dayWidth / 2;

const row = (id: number, start: string, end: string): TimelineRowData => ({
  id,
  cells: [`Row ${id}`, ""],
  bars: [{ id, start, end, label: `Row ${id}`, describe: `Row ${id}, ${start} to ${end}`, editable: false } satisfies TimelineBarData],
});

type Props = Partial<ComponentProps<typeof Timeline>>;
function Page({ rows, onZoom, ...rest }: { rows: TimelineRowData[]; onZoom?: () => void } & Props) {
  return (
    <TimelineDndContext scale={rest.scale ?? WEEK} onSchedule={vi.fn(() => true)}>
      <Timeline label="Timeline" scale={WEEK} onZoomChange={onZoom ?? vi.fn()} today={TODAY} columns={COLUMNS} rows={rows} {...rest} />
    </TimelineDndContext>
  );
}

/** happy-dom lays nothing out: give the scroller the size the open rule reads. */
const originals = (["clientWidth", "clientHeight"] as const).map((name) => [name, Object.getOwnPropertyDescriptor(HTMLElement.prototype, name)] as const);
function stubViewport(width: number) {
  for (const [name, value] of [["clientWidth", width], ["clientHeight", 600]] as const) {
    Object.defineProperty(HTMLElement.prototype, name, { configurable: true, get: () => value });
  }
}
afterEach(() => {
  for (const [name, descriptor] of originals) {
    if (descriptor === undefined) delete (HTMLElement.prototype as unknown as Record<string, unknown>)[name];
    else Object.defineProperty(HTMLElement.prototype, name, descriptor);
  }
});

const scroller = () => screen.getByRole("region", { name: "Timeline" });

describe("where a Timeline opens", () => {
  test("with work around today, today sits a quarter of the visible grid from the left", () => {
    stubViewport(1000);
    renderWithProviders(<Page rows={[row(1, "2026-06-08", "2026-06-19")]} />);
    expect(scroller().scrollLeft).toBe(todayX - 200);
  });

  test("with all the work in the future, it opens at the first bar, a lead before it", () => {
    stubViewport(1000);
    renderWithProviders(<Page rows={[row(1, "2026-11-23", "2026-12-04"), row(2, "2026-10-05", "2026-10-16")]} />);
    expect(scroller().scrollLeft).toBe(WEEK.xOf(toEpochDay("2026-10-05")) - OPEN_LEAD_PX);
  });

  test("with all the work in the past, it opens at the first bar", () => {
    stubViewport(1000);
    renderWithProviders(<Page rows={[row(1, "2026-03-02", "2026-03-13"), row(2, "2026-02-02", "2026-02-13")]} />);
    expect(scroller().scrollLeft).toBe(WEEK.xOf(toEpochDay("2026-02-02")) - OPEN_LEAD_PX);
  });

  test("with no bars at all, it opens on today", () => {
    stubViewport(1000);
    renderWithProviders(<Page rows={[{ id: 1, cells: ["Row 1", ""], bars: [] }]} />);
    expect(scroller().scrollLeft).toBe(todayX - 200);
  });

  test("a scroller with no layout (a hidden tab, a test DOM) is left alone", () => {
    renderWithProviders(<Page rows={[row(1, "2026-11-23", "2026-12-04")]} />);
    expect(scroller().scrollLeft).toBe(0);
  });

  test("the pane's width counts: a wider pane leaves less grid, and a quarter of that", () => {
    stubViewport(1000);
    renderWithProviders(<Page rows={[row(1, "2026-06-08", "2026-06-19")]} columns={WIDER} />);
    expect(scroller().scrollLeft).toBe(todayX - 175);
  });

  test("an arrival target wins: scrolling to a day leaves the default behind, even when the pane is fitted afterwards", () => {
    stubViewport(1000);
    const handle = createRef<TimelineHandle>();
    function Arrival({ columns }: { columns: TimelineColumn[] }) {
      // What `useMilestoneArrival` does: an effect of the page, after the Timeline's own layout effect.
      useEffect(() => handle.current?.scrollToDay("2026-09-14"), []);
      return <Page rows={[row(1, "2026-06-08", "2026-06-19")]} columns={columns} ref={handle} />;
    }
    const { rerender } = renderWithProviders(<Arrival columns={COLUMNS} />);
    const target = WEEK.xOf(toEpochDay("2026-09-14")) + 14 - 400;
    expect(scroller().scrollLeft).toBe(target);
    // The scroller's width is known after the first paint on a phone: the fit changes the pane and the Timeline renders again. The arrival stays.
    rerender(<Arrival columns={WIDER} />);
    expect(scroller().scrollLeft).toBe(target);
  });

  test("Scroll to today after the open settles it for good", () => {
    stubViewport(1000);
    renderWithProviders(<Page rows={[row(1, "2026-11-23", "2026-12-04")]} />);
    act(() => screen.getByRole("button", { name: "Scroll to today" }).click());
    expect(scroller().scrollLeft).toBe(todayX - 400);
  });

  test("the pane fitted by the page's own hook re-applies the rule once; Hide columns and Show columns after that never move the grid", async () => {
    stubViewport(500);
    const FIT: TimelineColumn[] = [
      { id: "name", header: "Milestone", width: 160 },
      { id: "team", header: "Team", width: 100, hideable: true },
      { id: "ops", header: "Operations", width: 40 },
    ];
    function Fitted() {
      const view = useTimelineColumns("project", FIT);
      return <Page rows={[row(1, "2026-06-08", "2026-06-19")]} columns={view.columns} hiddenColumns={view.hidden} scrollRef={view.scrollRef} toolbar={<TimelineColumnsControl view={view} />} />;
    }
    renderWithProviders(<Fitted />);
    // A phone: the pane may take 55 % of 500 px (275 px, the name shrinks), so the quarter is of the 225 px that remain, not of the 200 px the unfitted pane left.
    expect(Number.parseFloat(screen.getByRole("grid", { name: "Timeline" }).style.getPropertyValue("--timeline-left"))).toBe(275);
    expect(scroller().scrollLeft).toBe(todayX - 56.25);
    await Promise.resolve();
    // Hide columns narrows the pane, Show columns widens it: the viewer's doing, and the grid stays.
    act(() => screen.getByRole("button", { name: "Hide columns" }).click());
    expect(scroller().scrollLeft).toBe(todayX - 56.25);
    act(() => screen.getByRole("button", { name: "Show columns" }).click());
    expect(scroller().scrollLeft).toBe(todayX - 56.25);
  });

  test("a pane that changes after the first pass does not re-open an unscrolled grid", async () => {
    stubViewport(1000);
    const rows = [row(1, "2026-06-08", "2026-06-19")];
    const { rerender } = renderWithProviders(<Page rows={rows} />);
    expect(scroller().scrollLeft).toBe(todayX - 200);
    await Promise.resolve();
    rerender(<Page rows={rows} columns={WIDER} />);
    expect(scroller().scrollLeft).toBe(todayX - 200);
  });

  test("a viewer who has scrolled is never moved again, by a new pane, a refetch or a zoom change", () => {
    stubViewport(1000);
    const rows = [row(1, "2026-06-08", "2026-06-19")];
    const { rerender } = renderWithProviders(<Page rows={rows} />);
    scroller().scrollLeft = 3210;
    rerender(<Page rows={rows} columns={WIDER} />);
    expect(scroller().scrollLeft).toBe(3210);
    rerender(<Page rows={[row(1, "2026-11-23", "2026-12-04")]} columns={WIDER} />);
    expect(scroller().scrollLeft).toBe(3210);
  });

  test("a refetch, a growing range or a zoom change after the open leaves the grid where it is", () => {
    stubViewport(1000);
    const { rerender } = renderWithProviders(<Page rows={[row(1, "2026-06-08", "2026-06-19")]} />);
    const opened = scroller().scrollLeft;
    rerender(<Page rows={[row(1, "2026-11-23", "2026-12-04")]} />);
    expect(scroller().scrollLeft).toBe(opened);
    rerender(<Page rows={[row(1, "2026-11-23", "2026-12-04")]} scale={QUARTER} />);
    expect(scroller().scrollLeft).toBe(opened);
    // Not even when the pane changes afterwards: the scale under it is no longer the one it opened on.
    rerender(<Page rows={[row(1, "2026-11-23", "2026-12-04")]} scale={QUARTER} columns={WIDER} />);
    expect(scroller().scrollLeft).toBe(opened);
  });
});
