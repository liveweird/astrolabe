import { describe, expect, test } from "vitest";
import i18n from "../i18n";
import type { Movement, MovementTotals } from "../api/baselines";
import { movementSentence, movementStatus, movementTotalsParts, movementTotalsSentence, signedDays } from "./baselineOverlay";

const t = i18n.getFixedT("en");
const pl = i18n.getFixedT("pl");

const moved = (startDays: number, endDays: number, estimateDelta: number | null = null): Movement => ({ kind: "MOVED", startDays, endDays, estimateDelta });
const plain = (kind: Movement["kind"], estimateDelta: number | null = null): Movement => ({ kind, startDays: null, endDays: null, estimateDelta });
const totals = (over: Partial<MovementTotals>): MovementTotals => ({ unchanged: 0, moved: 0, later: 0, earlier: 0, scheduled: 0, unscheduled: 0, added: 0, removed: 0, ...over });

describe("movementSentence", () => {
  test("both ends by the same amount are said once", () => {
    expect(movementSentence(moved(5, 5), t)).toBe("5 working days later (start and end)");
    expect(movementSentence(moved(-1, -1), t)).toBe("1 working day earlier (start and end)");
  });

  test("different ends say both, an unmoved end says unchanged", () => {
    expect(movementSentence(moved(5, 3), t)).toBe("start 5 working days later, end 3 working days later");
    expect(movementSentence(moved(-2, 0), t)).toBe("start 2 working days earlier, end unchanged");
    expect(movementSentence(moved(0, 1), t)).toBe("start unchanged, end 1 working day later");
    expect(movementSentence(moved(2, -4), t)).toBe("start 2 working days later, end 4 working days earlier");
  });

  test("the kinds without a delta read as the plan words", () => {
    expect(movementSentence(plain("ADDED"), t)).toBe("new since the baseline");
    expect(movementSentence(plain("REMOVED"), t)).toBe("removed since the baseline");
    expect(movementSentence(plain("SCHEDULED"), t)).toBe("scheduled since the baseline");
    expect(movementSentence(plain("UNSCHEDULED"), t)).toBe("unscheduled since the baseline");
  });

  test("an unchanged row is unchanged, unless only its estimate changed", () => {
    expect(movementSentence(moved(0, 0, 0), t)).toBe("start unchanged, end unchanged");
    expect(movementSentence(plain("UNCHANGED", 0), t)).toBe("unchanged");
    expect(movementSentence(plain("UNCHANGED"), t)).toBe("unchanged");
    expect(movementSentence(plain("UNCHANGED", 2.5), t)).toBe("estimate changed");
  });

  test("Polish picks the plural form of the working days", () => {
    expect(movementSentence(moved(1, 1), pl)).toBe("o 1 dzień roboczy później (początek i koniec)");
    expect(movementSentence(moved(2, 2), pl)).toBe("o 2 dni robocze później (początek i koniec)");
    expect(movementSentence(moved(5, 0), pl)).toBe("początek o 5 dni roboczych później, koniec bez zmian");
    expect(movementSentence(moved(-3, -5), pl)).toBe("początek o 3 dni robocze wcześniej, koniec o 5 dni roboczych wcześniej");
  });
});

describe("movementStatus", () => {
  test("a moved row is the ORANGE Later exactly when its end is later", () => {
    expect(movementStatus(moved(0, 3))).toEqual({ key: "later", late: true });
    expect(movementStatus(moved(-2, 3))).toEqual({ key: "later", late: true });
    expect(movementStatus(moved(5, -1))).toEqual({ key: "earlier", late: false });
    expect(movementStatus(moved(4, 0))).toEqual({ key: "moved", late: false });
  });

  test("every other kind is a gray word; an estimate-only change is its own", () => {
    expect(movementStatus(plain("ADDED"))).toEqual({ key: "added", late: false });
    expect(movementStatus(plain("REMOVED"))).toEqual({ key: "removed", late: false });
    expect(movementStatus(plain("SCHEDULED"))).toEqual({ key: "scheduled", late: false });
    expect(movementStatus(plain("UNSCHEDULED"))).toEqual({ key: "unscheduled", late: false });
    expect(movementStatus(plain("UNCHANGED", -1))).toEqual({ key: "estimate", late: false });
    expect(movementStatus(plain("UNCHANGED", 0))).toEqual({ key: "unchanged", late: false });
    expect(movementStatus(plain("UNCHANGED"))).toEqual({ key: "unchanged", late: false });
  });
});

describe("movementTotals", () => {
  test("lists the non-zero figures in reading order, the later ones flagged; the rest of 'moved' is the end-unchanged ones", () => {
    const sample = totals({ moved: 20, later: 14, earlier: 3, added: 2, removed: 1, unchanged: 900 });
    expect(movementTotalsParts(sample, t).map((p) => [p.key, p.late])).toEqual([
      ["later", true],
      ["earlier", false],
      ["movedOther", false],
      ["added", false],
      ["removed", false],
    ]);
    expect(movementTotalsSentence(sample, t)).toBe("14 end later, 3 end earlier, 3 moved, end unchanged, 2 new, 1 removed");
  });

  test("scheduled and unscheduled flips are listed; nothing changed says so", () => {
    expect(movementTotalsSentence(totals({ scheduled: 4, unscheduled: 1 }), t)).toBe("4 newly scheduled, 1 unscheduled");
    expect(movementTotalsSentence(totals({ unchanged: 12 }), t)).toBe("No schedule changes");
    expect(movementTotalsSentence(totals({ unchanged: 12 }), pl)).toBe("Brak zmian w harmonogramie");
  });
});

describe("signedDays", () => {
  test("signs the figure, or a dash for a row not dated on both sides", () => {
    expect(signedDays(5)).toBe("+5");
    expect(signedDays(-2)).toBe("−2");
    expect(signedDays(0)).toBe("0");
    expect(signedDays(null)).toBe("—");
  });
});
