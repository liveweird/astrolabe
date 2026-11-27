import { describe, expect, test } from "vitest";
import { OPEN_LEAD_PX, OPEN_ROWS, OPEN_TODAY_SHARE, openScrollLeft, openSpans, TODAY_PILL_HALF_PX, type OpenSpan } from "./timelineOpen";
import type { TimelineRowData } from "./timelineModel";
import { makeScale, toEpochDay } from "./timelineScale";

// A year of Mondays-to-Sundays at 28 px a day (10,000 px). Today is 2026-06-10; the scroller is 1,000 px wide with a 200 px pane, so the visible grid is 800 px
// and a quarter of it 200 px.
const WEEK = makeScale("week", { from: toEpochDay("2026-01-05"), to: toEpochDay("2026-12-27") });
const TODAY = toEpochDay("2026-06-10");
const VIEWPORT = 1000;
const PANE = 200;
const VISIBLE = VIEWPORT - PANE;
const span = (start: string, end: string): OpenSpan => ({ start: toEpochDay(start), end: toEpochDay(end) });
const open = (spans: readonly OpenSpan[], viewport = VIEWPORT, pane = PANE) => openScrollLeft(WEEK, TODAY, spans, viewport, pane);
const todayX = WEEK.xOf(TODAY) + WEEK.dayWidth / 2;

/** Where the Today pill's centre falls in the visible grid for a `scrollLeft`. */
const pillAt = (left: number, visible = VISIBLE) => ({ at: todayX - left, visible });
function expectPillWhole(left: number, visible = VISIBLE) {
  const { at } = pillAt(left, visible);
  const [from, to] = [at - TODAY_PILL_HALF_PX, at + TODAY_PILL_HALF_PX];
  // Whole in the screen, or wholly out of it: never cut at an edge.
  expect((from >= 0 && to <= visible) || to <= 0 || from >= visible).toBe(true);
}

describe("openScrollLeft", () => {
  test("today in range with a bar in the first screen: today a quarter of the visible grid from the left", () => {
    const left = open([span("2026-06-08", "2026-06-19")]);
    expect(left).toBe(todayX - OPEN_TODAY_SHARE * VISIBLE);
    expect(pillAt(left).at).toBe(200);
  });

  test("a bar that only reaches into the first screen from the left keeps the today rule", () => {
    // Ends the day before the screen starts + 1: its last day is the screen's first pixel column.
    const screenStart = todayX - 200;
    const endDay = WEEK.dayAt(screenStart);
    expect(open([{ start: endDay - 20, end: endDay }])).toBe(screenStart);
  });

  test("no bars at all: the today rule", () => {
    expect(open([])).toBe(todayX - 200);
  });

  test("all the work in the future: the first bar, a lead before it", () => {
    const left = open([span("2027-01-04", "2027-01-31"), span("2026-11-02", "2026-11-13")]);
    expect(left).toBe(WEEK.xOf(toEpochDay("2026-11-02")) - OPEN_LEAD_PX);
  });

  test("all the work in the past: the first (earliest) bar", () => {
    const left = open([span("2026-02-09", "2026-02-20"), span("2026-03-02", "2026-03-13")]);
    expect(left).toBe(WEEK.xOf(toEpochDay("2026-02-09")) - OPEN_LEAD_PX);
  });

  test("work in the past and the future with nothing around today: the next work, not the oldest", () => {
    const left = open([span("2026-02-09", "2026-02-20"), span("2026-09-07", "2026-09-18")]);
    expect(left).toBe(WEEK.xOf(toEpochDay("2026-09-07")) - OPEN_LEAD_PX);
  });

  test("a bar that starts just after the first screen is not in it", () => {
    const afterScreen = WEEK.dayAt(todayX - 200 + VISIBLE) + 1;
    expect(open([{ start: afterScreen, end: afterScreen + 3 }])).toBe(WEEK.xOf(afterScreen) - OPEN_LEAD_PX);
  });

  test("the result stays inside the track: a first bar at the very start opens at 0, one near the end at the last full screen", () => {
    expect(open([span("2026-01-05", "2026-01-09")])).toBe(0);
    expect(open([span("2026-12-21", "2026-12-27")])).toBe(WEEK.totalWidth - VISIBLE);
  });

  test("a narrow scroller takes the quarter of what is visible, not of the screen", () => {
    // 400 px with a 190 px pane: 210 px visible, 52.5 px for the quarter.
    expect(open([], 400, 190)).toBe(todayX - 52.5);
  });

  test("a scroller with no room for a grid opens at 0", () => {
    expect(open([], 200, 200)).toBe(0);
    expect(open([], 100, 200)).toBe(0);
  });

  test("the range's start clamps the today rule at 0", () => {
    const early = makeScale("week", { from: TODAY - 7, to: TODAY + 200 });
    expect(openScrollLeft(early, TODAY, [], 1800, 200)).toBe(0);
  });

  test("a Today pill straddling the right edge after a first-bar open is brought into the screen", () => {
    // The bar lies 26 days before today: the pill's centre lands 782 px into the 800 px grid, 14 px short of whole.
    const bar = TODAY - 26;
    const left = open([{ start: bar, end: bar + 2 }]);
    expect(left).toBe(WEEK.xOf(bar) - OPEN_LEAD_PX + (782 + TODAY_PILL_HALF_PX - VISIBLE));
    expectPillWhole(left);
  });

  test("the Today pill is never cut, whatever the data and the width", () => {
    for (const bar of [-200, -120, -80, -60, -45, -30, -27, -26, -25, -10, 0, 10, 25, 26, 27, 28, 40, 60, 90, 150]) {
      for (const [viewport, pane] of [[1000, 200], [1400, 390], [700, 250], [400, 190], [360, 158]] as const) {
        const day = TODAY + bar;
        const left = openScrollLeft(WEEK, TODAY, [{ start: day, end: day + 1 }], viewport, pane);
        expectPillWhole(left, viewport - pane);
      }
    }
  });
});

describe("openSpans", () => {
  const row = (id: number, ...bars: Array<[string, string, TimelineRowData["bars"][number]["tone"]?]>): TimelineRowData => ({
    id,
    cells: [],
    bars: bars.map(([start, end, tone], index) => ({ id: `${id}:${index}`, start, end, label: "b", describe: "b", editable: false, tone })),
  });

  test("every bar of a row counts, whatever its tone, as epoch days", () => {
    const spans = openSpans([row(1, ["2026-06-01", "2026-06-05"], ["2026-06-02", "2026-06-03", "baseline"], ["2026-05-01", "2026-07-01", "window"])]);
    expect(spans).toEqual([span("2026-06-01", "2026-06-05"), span("2026-06-02", "2026-06-03"), span("2026-05-01", "2026-07-01")]);
  });

  test("only the rows of the first screen count", () => {
    const rows = Array.from({ length: OPEN_ROWS + 5 }, (_, i) => row(i, ["2026-06-01", "2026-06-02"]));
    expect(openSpans(rows)).toHaveLength(OPEN_ROWS);
  });

  test("rows without bars add nothing", () => {
    expect(openSpans([row(1), row(2)])).toEqual([]);
  });
});
