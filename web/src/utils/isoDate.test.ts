import { afterEach, describe, expect, test, vi } from "vitest";
import { addDays, DAY_MS, epochMillisToIsoDate, epochMillisToIsoDateInZone, isoDateToEpochMillis, isValidIsoDate, localIsoDate, todayIsoDate } from "./isoDate";

describe("isValidIsoDate", () => {
  test("rejects a malformed shape", () => {
    expect(isValidIsoDate("2024-1-1")).toBe(false);
    expect(isValidIsoDate("not-a-date")).toBe(false);
    expect(isValidIsoDate("")).toBe(false);
  });

  test("rejects an impossible calendar date (overflow normalizes to a different date)", () => {
    expect(isValidIsoDate("2024-02-30")).toBe(false);
    expect(isValidIsoDate("2024-13-01")).toBe(false);
  });

  test("accepts a real date, including a leap day", () => {
    expect(isValidIsoDate("2024-02-29")).toBe(true);
    expect(isValidIsoDate("2024-01-01")).toBe(true);
  });
});

describe("DAY_MS / addDays", () => {
  test("DAY_MS is one fixed 24-hour day", () => {
    expect(DAY_MS).toBe(24 * 60 * 60 * 1000);
  });

  test("addDays moves across month, year and leap-day boundaries in both directions", () => {
    expect(addDays("2024-02-28", 1)).toBe("2024-02-29");
    expect(addDays("2024-02-29", 1)).toBe("2024-03-01");
    expect(addDays("2025-12-31", 1)).toBe("2026-01-01");
    expect(addDays("2026-01-01", -1)).toBe("2025-12-31");
    expect(addDays("2026-09-30", 0)).toBe("2026-09-30");
  });
});

describe("isoDateToEpochMillis / epochMillisToIsoDate", () => {
  test("round-trips through UTC midnight", () => {
    const ms = isoDateToEpochMillis("2024-01-15");
    expect(ms).toBe(Date.UTC(2024, 0, 15));
    expect(epochMillisToIsoDate(ms)).toBe("2024-01-15");
  });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("todayIsoDate", () => {
  test("is the UTC date under a fixed clock", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2024-06-15T13:45:00Z"));
    expect(todayIsoDate()).toBe("2024-06-15");
  });
});

describe("zone-aware dates", () => {
  test("todayIsoDate follows the zone, not UTC: 23:30Z on Oct 31 is 00:30 on Nov 1 in Warsaw", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-31T23:30:00Z"));
    expect(todayIsoDate()).toBe("2026-10-31");
    expect(todayIsoDate("Europe/Warsaw")).toBe("2026-11-01");
    // A zone behind UTC keeps the previous day.
    expect(todayIsoDate("America/New_York")).toBe("2026-10-31");
  });

  test("epochMillisToIsoDateInZone handles the DST change day", () => {
    // Warsaw leaves DST on 2026-10-25: 00:30 local (22:30Z the day before) is still the 25th.
    expect(epochMillisToIsoDateInZone(Date.UTC(2026, 9, 24, 22, 30), "Europe/Warsaw")).toBe("2026-10-25");
  });
});

describe("localIsoDate", () => {
  test("is the calendar day on the viewer's own wall clock, zero-padded", () => {
    expect(localIsoDate(new Date(2027, 0, 9, 23, 59))).toBe("2027-01-09");
    expect(localIsoDate(new Date(2027, 11, 1, 0, 0))).toBe("2027-12-01");
    expect(localIsoDate(new Date(2028, 1, 29, 12, 0))).toBe("2028-02-29");
  });

  test("defaults to now", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(2027, 5, 7, 8, 0));
    expect(localIsoDate()).toBe("2027-06-07");
    vi.useRealTimers();
  });
});
