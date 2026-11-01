import { describe, expect, test } from "vitest";
import {
  DAY_WIDTH,
  defaultRange,
  headerRows,
  isoWeekOf,
  isWeekend,
  makeScale,
  MILESTONE_ZOOMS,
  PLAN_ZOOMS,
  scrollLeftToCenter,
  toEpochDay,
  toIsoDate,
  weekdayOf,
  weekendBackground,
  ZOOMS,
  type Zoom,
} from "./timelineScale";

const day = toEpochDay;
const rangeOf = (from: string, to: string) => ({ from: day(from), to: day(to) });

describe("epoch days and weekdays", () => {
  test("ISO dates round-trip through epoch days", () => {
    expect(toEpochDay("1970-01-01")).toBe(0);
    expect(toIsoDate(toEpochDay("2026-09-14"))).toBe("2026-09-14");
    expect(toIsoDate(toEpochDay("2024-02-29"))).toBe("2024-02-29");
  });

  test("Monday is 0 and Saturday/Sunday are the weekend", () => {
    expect(weekdayOf(day("2026-09-14"))).toBe(0);
    expect(weekdayOf(day("2026-09-20"))).toBe(6);
    expect(weekdayOf(day("1969-12-29"))).toBe(0);
    expect([day("2026-09-18"), day("2026-09-19"), day("2026-09-20"), day("2026-09-21")].map(isWeekend)).toEqual([false, true, true, false]);
  });

  test("ISO week labels use the Thursday's year", () => {
    expect(isoWeekOf(day("2026-09-14"))).toEqual({ year: 2026, week: 38 });
    expect(isoWeekOf(day("2026-01-01"))).toEqual({ year: 2026, week: 1 });
    expect(isoWeekOf(day("2027-01-01"))).toEqual({ year: 2026, week: 53 });
    expect(isoWeekOf(day("2024-12-30"))).toEqual({ year: 2025, week: 1 });
  });
});

describe("the zoom lists", () => {
  test("the milestone pages keep week / month / quarter, the plan pages get month / quarter / year, ZOOMS holds all four", () => {
    expect(MILESTONE_ZOOMS).toEqual(["week", "month", "quarter"]);
    expect(PLAN_ZOOMS).toEqual(["month", "quarter", "year"]);
    expect(ZOOMS).toEqual(["week", "month", "quarter", "year"]);
    expect(new Set([...MILESTONE_ZOOMS, ...PLAN_ZOOMS])).toEqual(new Set(ZOOMS));
  });

  test("a day is 28 / 8 / 3 / 1 px", () => {
    expect(ZOOMS.map((zoom) => DAY_WIDTH[zoom])).toEqual([28, 8, 3, 1]);
  });
});

describe("makeScale", () => {
  const scale = makeScale("week", rangeOf("2026-09-14", "2026-09-27"));

  test("converts between days and pixels at 28 px per day", () => {
    expect(scale.dayWidth).toBe(DAY_WIDTH.week);
    expect(scale.totalWidth).toBe(14 * 28);
    expect(scale.xOf(day("2026-09-14"))).toBe(0);
    expect(scale.xOf(day("2026-09-16"))).toBe(56);
    expect(scale.widthOf(day("2026-09-16"), day("2026-09-16"))).toBe(28);
    expect(scale.widthOf(day("2026-09-14"), day("2026-09-20"))).toBe(7 * 28);
  });

  test("dayAt is the inverse of xOf over a whole day", () => {
    for (const offset of [0, 1, 5, 13]) {
      const d = scale.from + offset;
      expect(scale.dayAt(scale.xOf(d))).toBe(d);
      expect(scale.dayAt(scale.xOf(d) + 27)).toBe(d);
    }
  });

  test("year zoom is one pixel per day: xOf, widthOf and dayAt are the day count", () => {
    const year = makeScale("year", rangeOf("2026-01-01", "2027-12-31"));
    expect(year.dayWidth).toBe(1);
    expect(year.totalWidth).toBe(365 + 365);
    expect(year.xOf(day("2026-03-01"))).toBe(59);
    expect(year.widthOf(day("2026-03-01"), day("2026-03-31"))).toBe(31);
    expect(year.dayAt(59)).toBe(day("2026-03-01"));
    expect(year.dayAt(365)).toBe(day("2027-01-01"));
  });

  test("a reversed range collapses to one day", () => {
    expect(makeScale("month", { from: 10, to: 3 }).totalWidth).toBe(DAY_WIDTH.month);
  });
});

describe("headerRows", () => {
  test("week zoom: ISO-week groups over day cells, clipped to the range", () => {
    const { groups, cells } = headerRows(makeScale("week", rangeOf("2026-09-16", "2026-09-22")));
    expect(groups.map((g) => [g.label, g.to - g.from + 1])).toEqual([
      ["W38 2026", 5],
      ["W39 2026", 2],
    ]);
    expect(cells.map((c) => c.label)).toEqual(["16", "17", "18", "19", "20", "21", "22"]);
    expect(cells.map((c) => c.weekend)).toEqual([false, false, false, true, true, false, false]);
    expect(groups.every((g) => !g.weekend)).toBe(true);
  });

  test("month zoom: month groups over ISO-week cells (a week may straddle two groups)", () => {
    const { groups, cells } = headerRows(makeScale("month", rangeOf("2026-09-21", "2026-10-11")));
    expect(groups.map((g) => g.label)).toEqual(["2026-09", "2026-10"]);
    expect(cells.map((c) => [c.label, c.to - c.from + 1])).toEqual([
      ["W39", 7],
      ["W40", 7],
      ["W41", 7],
    ]);
    expect(groups.map((g) => g.to - g.from + 1)).toEqual([10, 11]);
    expect(new Set(cells.map((c) => c.key)).size).toBe(cells.length);
  });

  test("quarter zoom: quarter groups over month cells", () => {
    const { groups, cells } = headerRows(makeScale("quarter", rangeOf("2026-08-15", "2027-01-10")));
    expect(groups.map((g) => g.label)).toEqual(["2026-Q3", "2026-Q4", "2027-Q1"]);
    expect(cells.map((c) => c.label)).toEqual(["2026-08", "2026-09", "2026-10", "2026-11", "2026-12", "2027-01"]);
    expect(cells[0].from).toBe(day("2026-08-15"));
    expect(cells[5].to).toBe(day("2027-01-10"));
  });

  test("year zoom: year groups over quarter cells (a leap year is 366 days), clipped to the range", () => {
    const { groups, cells } = headerRows(makeScale("year", rangeOf("2027-08-15", "2029-02-10")));
    expect(groups.map((g) => [g.label, g.to - g.from + 1])).toEqual([
      ["2027", 139],
      ["2028", 366],
      ["2029", 41],
    ]);
    expect(cells.map((c) => c.label)).toEqual(["2027-Q3", "2027-Q4", "2028-Q1", "2028-Q2", "2028-Q3", "2028-Q4", "2029-Q1"]);
    expect(cells[0].from).toBe(day("2027-08-15"));
    expect(cells[6].to).toBe(day("2029-02-10"));
    expect(new Set(groups.map((g) => g.key)).size).toBe(groups.length);
    expect(groups.every((g) => !g.weekend) && cells.every((c) => !c.weekend)).toBe(true);
  });

  test("the cells of every zoom partition the range exactly", () => {
    for (const zoom of ZOOMS as Zoom[]) {
      const scale = makeScale(zoom, rangeOf("2026-02-17", "2026-12-03"));
      const { groups, cells } = headerRows(scale);
      for (const row of [groups, cells]) {
        expect(row[0].from).toBe(scale.from);
        expect(row[row.length - 1].to).toBe(scale.to);
        row.slice(1).forEach((cell, i) => expect(cell.from).toBe(row[i].to + 1));
      }
    }
  });
});

describe("weekendBackground", () => {
  test("is drawn at week and month zoom, not at quarter or year zoom", () => {
    expect(weekendBackground(makeScale("year", rangeOf("2026-09-14", "2027-09-27")))).toBeNull();
    expect(weekendBackground(makeScale("week", rangeOf("2026-09-14", "2026-09-27")))).not.toBeNull();
    expect(weekendBackground(makeScale("month", rangeOf("2026-09-14", "2026-09-27")))).not.toBeNull();
    expect(weekendBackground(makeScale("quarter", rangeOf("2026-09-14", "2026-09-27")))).toBeNull();
  });

  test("a range starting on a Monday puts the weekend at days 5-6 of each period", () => {
    const css = weekendBackground(makeScale("week", rangeOf("2026-09-14", "2026-09-27")), "INK");
    // period 196 px; Monday phase 0 folds to -196; the weekend sits 140..196 px after it
    expect(css).toBe("repeating-linear-gradient(90deg, transparent -196px -56px, INK -56px 0px)");
  });

  test("a range starting mid-week phases the pattern to the Monday before", () => {
    // Wednesday: its Monday is 2 days (56 px) to the left of x = 0, so Saturday starts 3 days (84 px) in
    const css = weekendBackground(makeScale("week", rangeOf("2026-09-16", "2026-09-27")), "INK");
    expect(css).toBe("repeating-linear-gradient(90deg, transparent -56px 84px, INK 84px 140px)");
  });
});

describe("defaultRange", () => {
  test("pads the data and today by two weeks and snaps to Monday-Sunday", () => {
    const range = defaultRange(["2026-09-16", "2026-10-02"], "2026-09-20", "week");
    expect(toIsoDate(range.from)).toBe("2026-08-31");
    expect(toIsoDate(range.to)).toBe("2026-10-18");
    expect(weekdayOf(range.from)).toBe(0);
    expect(weekdayOf(range.to)).toBe(6);
  });

  test("today outside the data widens the range to include it", () => {
    const range = defaultRange(["2026-09-16"], "2026-12-01", "week");
    expect(range.to).toBeGreaterThanOrEqual(day("2026-12-01") + 14);
  });

  test("month zoom: one month either side, whole months", () => {
    const range = defaultRange(["2026-09-16", "2026-10-02"], "2026-09-20", "month");
    expect([toIsoDate(range.from), toIsoDate(range.to)]).toEqual(["2026-08-01", "2026-11-30"]);
  });

  test("quarter zoom: one quarter either side, whole quarters", () => {
    const range = defaultRange(["2026-09-16", "2026-10-02"], "2026-09-20", "quarter");
    expect([toIsoDate(range.from), toIsoDate(range.to)]).toEqual(["2026-04-01", "2027-03-31"]);
  });

  test("year zoom: one year either side, whole years", () => {
    const range = defaultRange(["2026-09-16", "2026-10-02"], "2026-09-20", "year");
    expect([toIsoDate(range.from), toIsoDate(range.to)]).toEqual(["2025-01-01", "2027-12-31"]);
    const wide = defaultRange(["2026-12-31", "2028-01-01"], "2027-06-01", "year");
    expect([toIsoDate(wide.from), toIsoDate(wide.to)]).toEqual(["2025-01-01", "2029-12-31"]);
  });

  test("nothing scheduled: today +/- 6 weeks, 3 months, 2 quarters, 1 year", () => {
    const week = defaultRange([], "2026-09-16", "week");
    expect([toIsoDate(week.from), toIsoDate(week.to)]).toEqual(["2026-08-03", "2026-11-01"]);
    const month = defaultRange([], "2026-09-16", "month");
    expect([toIsoDate(month.from), toIsoDate(month.to)]).toEqual(["2026-06-01", "2026-12-31"]);
    const quarter = defaultRange([], "2026-09-16", "quarter");
    expect([toIsoDate(quarter.from), toIsoDate(quarter.to)]).toEqual(["2026-01-01", "2027-03-31"]);
    const year = defaultRange([], "2026-09-16", "year");
    expect([toIsoDate(year.from), toIsoDate(year.to)]).toEqual(["2025-01-01", "2027-12-31"]);
  });

  test("a year boundary does not break the month arithmetic", () => {
    const range = defaultRange(["2026-12-20"], "2026-12-20", "month");
    expect([toIsoDate(range.from), toIsoDate(range.to)]).toEqual(["2026-11-01", "2027-01-31"]);
  });
});

describe("scrollLeftToCenter", () => {
  const scale = makeScale("week", rangeOf("2026-01-05", "2026-12-27"));
  test("centres the day in the track part of the viewport and never goes negative", () => {
    const target = day("2026-06-15");
    expect(scrollLeftToCenter(scale, target, 1000, 400)).toBe(scale.xOf(target) + 14 - 300);
    expect(scrollLeftToCenter(scale, scale.from, 1000, 400)).toBe(0);
  });
});
