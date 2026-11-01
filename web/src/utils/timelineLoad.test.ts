import { describe, expect, test } from "vitest";
import { formatMd, stripCells, type LoadWeek } from "./timelineLoad";
import { makeScale, toEpochDay, type Zoom } from "./timelineScale";

// 2027-02-01 is a Monday; the range is the four whole weeks 2027-01-25 .. 2027-02-21.
const scaleOf = (zoom: Zoom, from = "2027-01-25", to = "2027-02-21") => makeScale(zoom, { from: toEpochDay(from), to: toEpochDay(to) });

const week = (over: Partial<LoadWeek> = {}): LoadWeek => ({
  weekStart: "2027-02-01",
  load: 8.5,
  capacity: 14,
  overloaded: false,
  overloadMd: null,
  maxWip: 2,
  wipExceeded: false,
  ...over,
});

const only = (w: LoadWeek, zoom: Zoom = "week") => stripCells([w], scaleOf(zoom))[0];

describe("formatMd", () => {
  test.each([
    [14, "14"],
    [8.5, "8.5"],
    [0.8, "0.8"],
    [0, "0"],
    [12.25, "12.25"],
  ])("%s reads %s", (value, text) => {
    expect(formatMd(value)).toBe(text);
  });
});

describe("a cell sits at xOf(monday) and spans seven days", () => {
  test.each([
    ["week", 196, 196],
    ["month", 56, 56],
    ["quarter", 21, 21],
  ] as const)("at %s zoom", (zoom, x, width) => {
    expect(only(week(), zoom)).toMatchObject({ weekStart: "2027-02-01", x, width });
  });

  test("one cell per week, in the order given", () => {
    const cells = stripCells([week({ weekStart: "2027-02-01" }), week({ weekStart: "2027-02-08" })], scaleOf("week"));
    expect(cells.map((c) => [c.weekStart, c.x])).toEqual([
      ["2027-02-01", 196],
      ["2027-02-08", 392],
    ]);
  });

  test("a week cut by the range start is clipped like the header's cells; one wholly outside is dropped", () => {
    // the range starts on Wednesday 2027-01-27: the week of 01-25 keeps Wed-Sun (5 days)
    const scale = scaleOf("week", "2027-01-27");
    const cells = stripCells([week({ weekStart: "2027-01-18" }), week({ weekStart: "2027-01-25" }), week({ weekStart: "2027-02-01" })], scale);
    expect(cells.map((c) => [c.weekStart, c.x, c.width])).toEqual([
      ["2027-01-25", 0, 5 * 28],
      ["2027-02-01", 5 * 28, 7 * 28],
    ]);
    // ... and by the range end (Wednesday 2027-02-10)
    const tail = stripCells([week({ weekStart: "2027-02-08" }), week({ weekStart: "2027-02-15" })], scaleOf("week", "2027-01-25", "2027-02-10"));
    expect(tail.map((c) => [c.weekStart, c.width])).toEqual([["2027-02-08", 3 * 28]]);
  });
});

describe("a narrow edge cell", () => {
  test("a week cut to one day by the range start is 28 px wide and prints no figure; the column and the flags stay", () => {
    // the range starts on Sunday 2027-01-31: the week of 01-25 keeps one day
    const [cell] = stripCells([week({ weekStart: "2027-01-25", load: 7, capacity: 14, wipExceeded: true, maxWip: 3 })], scaleOf("week", "2027-01-31"));
    expect(cell).toMatchObject({ x: 0, width: 28, text: "", fillHeight: 12, wipExceeded: true, wipText: "3" });
  });

  test("a cell of 40 px or more keeps its figure (cut to two days: 56 px)", () => {
    const [cell] = stripCells([week({ weekStart: "2027-01-25" })], scaleOf("week", "2027-01-30"));
    expect(cell).toMatchObject({ width: 2 * 28, text: "8.5 / 14" });
  });
});

describe("the column's height is load over capacity of 24 px, capped at 125 %", () => {
  test.each([
    [7, 14, 12],
    [14, 14, 24],
    [8.5, 14, 15],
    [17.5, 14, 30],
    [40, 14, 30],
    [0, 14, 0],
  ])("load %s against %s is %s px", (load, capacity, height) => {
    expect(only(week({ load, capacity, overloaded: load > capacity })).fillHeight).toBe(height);
  });

  test("a small non-zero load still shows a 1 px column", () => {
    expect(only(week({ load: 0.1, capacity: 100 })).fillHeight).toBe(1);
    expect(only(week({ load: 0.01, capacity: 14 })).fillHeight).toBe(1);
  });

  test("a load against a zero capacity (on hold) is the cap; no load against it is nothing", () => {
    expect(only(week({ load: 3, capacity: 0, overloaded: true })).fillHeight).toBe(30);
    expect(only(week({ load: 0, capacity: 0 })).fillHeight).toBe(0);
  });

  test("no capacity: no column and no capacity line, whatever the load", () => {
    const cell = only(week({ load: 9, capacity: null, maxWip: 1 }));
    expect(cell).toMatchObject({ fillHeight: 0, hasCapacity: false, capacity: null, overloaded: false });
    expect(only(week()).hasCapacity).toBe(true);
  });

  test("a prorated capacity is just the week's figure", () => {
    // 14.00 (10 MD/week through Wednesday, 20 from Thursday): 7 of 14 is half the line
    expect(only(week({ load: 7, capacity: 14 })).fillHeight).toBe(12);
  });
});

describe("the figure per zoom", () => {
  test("week: load / capacity; month: the load; quarter: none", () => {
    expect(only(week(), "week").text).toBe("8.5 / 14");
    expect(only(week(), "month").text).toBe("8.5");
    expect(only(week(), "quarter").text).toBe("");
    // year zoom is type-complete here (the strip is never shown there): it reads like quarter
    expect(only(week(), "year").text).toBe("");
  });

  test("a prorated, fractional capacity keeps its two decimals", () => {
    expect(only(week({ load: 0.81, capacity: 0.8, overloaded: true, overloadMd: 0.01 })).text).toBe("0.81 / 0.8");
  });

  test("no capacity: the load alone at week and month zoom, dimmed by the component; nothing at quarter or when nothing is loaded", () => {
    const noCapacity = week({ capacity: null });
    expect(only(noCapacity, "week").text).toBe("8.5");
    expect(only(noCapacity, "month").text).toBe("8.5");
    expect(only(noCapacity, "quarter").text).toBe("");
    expect(only(week({ capacity: null, load: 0, maxWip: 0 }), "week").text).toBe("");
  });
});

describe("the WIP mark", () => {
  test("carries the peak at week and month zoom and no text (a dot) at quarter zoom", () => {
    const flagged = week({ maxWip: 3, wipExceeded: true });
    expect(only(flagged, "week")).toMatchObject({ maxWip: 3, wipExceeded: true, wipText: "3" });
    expect(only(flagged, "month")).toMatchObject({ wipExceeded: true, wipText: "3" });
    expect(only(flagged, "quarter")).toMatchObject({ wipExceeded: true, wipText: "" });
    expect(only(flagged, "year")).toMatchObject({ wipExceeded: true, wipText: "" });
  });

  test("is independent of the overload", () => {
    expect(only(week({ wipExceeded: true, maxWip: 3 }))).toMatchObject({ overloaded: false, wipExceeded: true });
    expect(only(week({ load: 20, overloaded: true, overloadMd: 6 }))).toMatchObject({ overloaded: true, wipExceeded: false });
  });
});
