import { describe, expect, test } from "vitest";
import { screen } from "@testing-library/react";
import TimelineLoadStrip from "./TimelineLoadStrip";
import type { LoadWeek } from "../utils/timelineLoad";
import { makeScale, toEpochDay, type Zoom } from "../utils/timelineScale";
import { renderWithProviders } from "../test/render";

const scaleOf = (zoom: Zoom) => makeScale(zoom, { from: toEpochDay("2027-01-25"), to: toEpochDay("2027-02-21") });

const WEEKS: LoadWeek[] = [
  // no capacity yet (before the team's first period)
  { weekStart: "2027-01-25", load: 3, capacity: null, overloaded: false, overloadMd: null, maxWip: 1, wipExceeded: false },
  // fine
  { weekStart: "2027-02-01", load: 8.5, capacity: 14, overloaded: false, overloadMd: null, maxWip: 2, wipExceeded: false },
  // overloaded and over the WIP limit
  { weekStart: "2027-02-08", load: 20, capacity: 14, overloaded: true, overloadMd: 6, maxWip: 3, wipExceeded: true },
  // over the WIP limit only
  { weekStart: "2027-02-15", load: 5, capacity: 14, overloaded: false, overloadMd: null, maxWip: 4, wipExceeded: true },
];

const cell = (week: string) => document.querySelector<HTMLElement>(`[data-week="${week}"]`) as HTMLElement;
const part = (week: string, name: string) => cell(week).querySelector<HTMLElement>(`[data-part="${name}"]`);

function renderStrip(zoom: Zoom = "week") {
  return renderWithProviders(<TimelineLoadStrip weeks={WEEKS} scale={scaleOf(zoom)} />);
}

describe("TimelineLoadStrip", () => {
  test("one cell per week at xOf(monday), seven days wide, carrying the flags as data attributes", () => {
    renderStrip();
    expect(document.querySelectorAll("[data-week]")).toHaveLength(4);
    expect(cell("2027-02-01").style.left).toBe("196px");
    expect(cell("2027-02-01").style.width).toBe("196px");
    expect(cell("2027-02-01")).toHaveAttribute("data-overloaded", "false");
    expect(cell("2027-02-01")).toHaveAttribute("data-wip-exceeded", "false");
    expect(cell("2027-02-08")).toHaveAttribute("data-overloaded", "true");
    expect(cell("2027-02-08")).toHaveAttribute("data-wip-exceeded", "true");
    expect(cell("2027-02-15")).toHaveAttribute("data-overloaded", "false");
    expect(cell("2027-02-15")).toHaveAttribute("data-wip-exceeded", "true");
  });

  test("follows the scale: the same weeks at month and quarter zoom", () => {
    const { unmount } = renderStrip("month");
    expect([cell("2027-02-01").style.left, cell("2027-02-01").style.width]).toEqual(["56px", "56px"]);
    unmount();
    renderStrip("quarter");
    expect([cell("2027-02-01").style.left, cell("2027-02-01").style.width]).toEqual(["21px", "21px"]);
  });

  test("a week with a capacity has its capacity line, its column and its figure", () => {
    renderStrip();
    expect(part("2027-02-01", "capacity-line")).not.toBeNull();
    expect(part("2027-02-01", "fill")?.style.height).toBe("15px");
    expect(part("2027-02-01", "figure")).toHaveTextContent("8.5 / 14");
    expect(part("2027-02-01", "wip")).toBeNull();
  });

  test("an overloaded week's column rises past the capacity line (125 % of 24 px)", () => {
    renderStrip();
    expect(part("2027-02-08", "fill")?.style.height).toBe("30px");
    expect(part("2027-02-08", "figure")).toHaveTextContent("20 / 14");
  });

  test("a week with no capacity shows its figure only: no column, no line, never flagged", () => {
    renderStrip();
    expect(part("2027-01-25", "fill")).toBeNull();
    expect(part("2027-01-25", "capacity-line")).toBeNull();
    expect(part("2027-01-25", "figure")).toHaveTextContent(/^3$/);
    expect(cell("2027-01-25")).toHaveAttribute("data-overloaded", "false");
  });

  test("the WIP mark is a chip carrying the peak at week and month zoom, an empty dot at quarter zoom, and only while flagged", () => {
    const { unmount } = renderStrip("week");
    expect(part("2027-02-08", "wip")).toHaveTextContent(/^3$/);
    expect(part("2027-02-15", "wip")).toHaveTextContent(/^4$/);
    expect(part("2027-02-01", "wip")).toBeNull();
    unmount();
    const month = renderStrip("month");
    expect(part("2027-02-08", "wip")).toHaveTextContent(/^3$/);
    month.unmount();
    renderStrip("quarter");
    expect(part("2027-02-08", "wip")).toBeInTheDocument();
    expect(part("2027-02-08", "wip")).toBeEmptyDOMElement();
    // no figure at quarter zoom
    expect(part("2027-02-08", "figure")).toBeNull();
  });

  test("the title is the full sentence: figures, the peak in progress, the WIP verdict", () => {
    renderStrip();
    expect(cell("2027-02-01")).toHaveAttribute("title", "Week of 2027-02-01: 8.5 of 14 man-days; up to 2 milestones in progress");
    expect(cell("2027-02-08")).toHaveAttribute("title", "Week of 2027-02-08: 20 of 14 man-days; up to 3 milestones in progress, over the WIP limit");
    expect(cell("2027-01-25")).toHaveAttribute("title", "Week of 2027-01-25: 3 man-days, no capacity set; up to 1 milestone in progress");
  });

  test("a week with nothing in progress leaves the peak out of the title", () => {
    const empty: LoadWeek = { weekStart: "2027-02-01", load: 0, capacity: 10, overloaded: false, overloadMd: null, maxWip: 0, wipExceeded: false };
    renderWithProviders(<TimelineLoadStrip weeks={[empty]} scale={scaleOf("week")} />);
    expect(cell("2027-02-01")).toHaveAttribute("title", "Week of 2027-02-01: 0 of 10 man-days");
    expect(part("2027-02-01", "fill")).toBeNull();
  });

  test("is decorative: no role, no name, nothing focusable", () => {
    renderStrip();
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
    expect(document.querySelectorAll("[tabindex]")).toHaveLength(0);
  });
});
