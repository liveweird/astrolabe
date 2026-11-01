import { describe, expect, test } from "vitest";
import i18n from "../i18n";
import { idleBands } from "./idleGaps";

const t = i18n.getFixedT("en");
const tPl = i18n.getFixedT("pl");

describe("idleBands", () => {
  test("one idle band per gap, in the server's order, over exactly the gap's first and last working day", () => {
    const bands = idleBands(
      [
        { start: "2027-02-01", end: "2027-02-05", workingDays: 5 },
        { start: "2027-02-10", end: "2027-02-16", workingDays: 5 },
      ],
      t,
    );
    expect(bands).toEqual([
      { id: "idle:2027-02-01", start: "2027-02-01", end: "2027-02-05", label: "Idle 2027-02-01 to 2027-02-05, 5 working days", tone: "idle" },
      { id: "idle:2027-02-10", start: "2027-02-10", end: "2027-02-16", label: "Idle 2027-02-10 to 2027-02-16, 5 working days", tone: "idle" },
    ]);
  });

  test("no gaps, no bands", () => {
    expect(idleBands([], t)).toEqual([]);
  });

  test("the Polish title takes the plural of the length", () => {
    const label = (workingDays: number) => idleBands([{ start: "2027-02-01", end: "2027-02-09", workingDays }], tPl)[0].label;
    expect(label(3)).toBe("Przestój od 2027-02-01 do 2027-02-09, 3 dni robocze");
    expect(label(5)).toBe("Przestój od 2027-02-01 do 2027-02-09, 5 dni roboczych");
  });
});
