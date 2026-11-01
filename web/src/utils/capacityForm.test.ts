import { describe, expect, test } from "vitest";
import i18n from "../i18n";
import { ApiError } from "../api/http";
import type { CapacityPeriod } from "../api/teams";
import { capacityFormValidation, capacitySaveErrorMessage, EMPTY_CAPACITY_FORM, fromCapacityPeriod, toCapacityBody } from "./capacityForm";

const t = i18n.t.bind(i18n);
const rules = capacityFormValidation(t);

describe("capacity form rules", () => {
  test("ANY real calendar day is accepted - a Wednesday, a Saturday, a date in the past - and nothing about weekdays is asked", () => {
    for (const date of ["2027-02-03", "2027-02-06", "2020-01-06", "2027-02-07"]) expect(rules.effectiveFrom(date)).toBeNull();
  });

  test("a missing, malformed, impossible or out-of-range date is refused", () => {
    for (const date of [null, "", "2027-2-3", "2027-02-30", "1899-12-31", "3000-01-01"]) {
      expect(rules.effectiveFrom(date)).toBe("Enter a valid date (YYYY-MM-DD)");
    }
  });

  test("man-days: 0 up to below a million, at most two decimals", () => {
    for (const value of [0, 8, 14.5, "10.25", 999999.99]) expect(rules.mdPerWeek(value)).toBeNull();
    for (const value of ["", -1, 1_000_000, 1.005, "abc"]) expect(rules.mdPerWeek(value)).toBe("Enter man-days from 0, with at most two decimals");
  });

  test("the WIP limit is optional; set, it is a whole number from 1 to 99", () => {
    for (const value of ["", 1, 7, 99, "12"]) expect(rules.wipLimit(value)).toBeNull();
    for (const value of [0, 100, 2.5, -3, "x"]) expect(rules.wipLimit(value)).toBe("Enter a whole number from 1 to 99, or leave empty for no limit");
  });
});

describe("capacity form mappers", () => {
  test("an empty WIP limit travels as null, a limit as the number; the date and man-days as typed", () => {
    expect(toCapacityBody({ effectiveFrom: "2027-02-03", mdPerWeek: "8", wipLimit: "" })).toEqual({ effectiveFrom: "2027-02-03", mdPerWeek: 8, wipLimit: null });
    expect(toCapacityBody({ effectiveFrom: "2027-02-03", mdPerWeek: 8.5, wipLimit: 7 })).toEqual({ effectiveFrom: "2027-02-03", mdPerWeek: 8.5, wipLimit: 7 });
  });

  test("a stored period fills the form, a missing limit as empty", () => {
    const period = { id: 1, teamId: 3, effectiveFrom: "2027-02-01", mdPerWeek: 10, wipLimit: null, createdAt: 1, updatedAt: 2 } as CapacityPeriod;
    expect(fromCapacityPeriod(period)).toEqual({ effectiveFrom: "2027-02-01", mdPerWeek: 10, wipLimit: "" });
    expect(fromCapacityPeriod({ ...period, wipLimit: 4 }).wipLimit).toBe(4);
    expect(EMPTY_CAPACITY_FORM).toEqual({ effectiveFrom: null, mdPerWeek: "", wipLimit: "" });
  });

  test("save errors read in the page's words", () => {
    expect(capacitySaveErrorMessage(new ApiError(403, "x"), t)).toBe("Only the team's manager or an administrator can change the capacity");
    expect(capacitySaveErrorMessage(new ApiError(404, "x"), t)).toBe("This no longer exists — reload the page");
    expect(capacitySaveErrorMessage(new ApiError(400, "x"), t)).toBe("One or more fields are invalid — check the date, the man-days and the WIP limit");
    expect(capacitySaveErrorMessage(new TypeError("Failed to fetch"), t)).not.toContain("Failed to fetch");
  });
});
