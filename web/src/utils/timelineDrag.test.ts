import { describe, expect, test } from "vitest";
import type { Modifier } from "@dnd-kit/core";
import {
  drawOutcome,
  dropOutcome,
  horizontalOnly,
  isRowNoop,
  keyboardCoordinates,
  rowPositionAfter,
  rowSlotAt,
  rowSlotWithin,
  sameSpan,
  snapToDays,
  verticalOnly,
} from "./timelineDrag";
import { toEpochDay } from "./timelineScale";

const bar = { start: "2026-09-16", end: "2026-09-18" };

describe("dropOutcome", () => {
  test("move shifts both ends", () => {
    expect(dropOutcome("move", bar, 2, null)).toEqual({ start: "2026-09-18", end: "2026-09-20" });
    expect(dropOutcome("move", bar, -3, null)).toEqual({ start: "2026-09-13", end: "2026-09-15" });
  });

  test("resize-start moves only the start and stops at the end (a one-day bar is the minimum)", () => {
    expect(dropOutcome("resize-start", bar, -2, null)).toEqual({ start: "2026-09-14", end: "2026-09-18" });
    expect(dropOutcome("resize-start", bar, 1, null)).toEqual({ start: "2026-09-17", end: "2026-09-18" });
    expect(dropOutcome("resize-start", bar, 9, null)).toEqual({ start: "2026-09-18", end: "2026-09-18" });
  });

  test("resize-end moves only the end and stops at the start", () => {
    expect(dropOutcome("resize-end", bar, 4, null)).toEqual({ start: "2026-09-16", end: "2026-09-22" });
    expect(dropOutcome("resize-end", bar, -1, null)).toEqual({ start: "2026-09-16", end: "2026-09-17" });
    expect(dropOutcome("resize-end", bar, -9, null)).toEqual({ start: "2026-09-16", end: "2026-09-16" });
  });

  test("month and year boundaries are calendar arithmetic", () => {
    expect(dropOutcome("move", { start: "2026-12-30", end: "2026-12-31" }, 3, null)).toEqual({ start: "2027-01-02", end: "2027-01-03" });
  });

  test("the tray gives one calendar week from the day under the pointer, or nothing without one", () => {
    expect(dropOutcome("tray", null, 0, toEpochDay("2026-09-21"))).toEqual({ start: "2026-09-21", end: "2026-09-27" });
    expect(dropOutcome("tray", null, 0, null)).toBeNull();
  });

  test("a bar kind without a bar answers nothing", () => {
    expect(dropOutcome("move", null, 1, null)).toBeNull();
  });

  test("a row drag proposes no dates, whatever it is given", () => {
    expect(dropOutcome("row", bar, 3, toEpochDay("2026-09-21"))).toBeNull();
  });

  test("a draw proposes no dates through dropOutcome either: its span is drawOutcome's", () => {
    expect(dropOutcome("draw", bar, 3, toEpochDay("2026-09-21"))).toBeNull();
  });

  test("sameSpan compares both ends", () => {
    expect(sameSpan(bar, { ...bar })).toBe(true);
    expect(sameSpan(bar, { ...bar, end: "2026-09-19" })).toBe(false);
  });
});

describe("drawOutcome", () => {
  const anchor = toEpochDay("2026-09-16");

  test("drawing rightwards: the anchor day starts the span, the pointer's day ends it", () => {
    expect(drawOutcome(anchor, toEpochDay("2026-09-21"))).toEqual({ start: "2026-09-16", end: "2026-09-21" });
  });

  test("drawing leftwards: the earlier day is the start, whichever way the pointer went", () => {
    expect(drawOutcome(anchor, toEpochDay("2026-09-11"))).toEqual({ start: "2026-09-11", end: "2026-09-16" });
  });

  test("the same day is a one-day span, the minimum", () => {
    expect(drawOutcome(anchor, anchor)).toEqual({ start: "2026-09-16", end: "2026-09-16" });
  });

  test("month and year boundaries are calendar arithmetic", () => {
    expect(drawOutcome(toEpochDay("2027-01-02"), toEpochDay("2026-12-30"))).toEqual({ start: "2026-12-30", end: "2027-01-02" });
  });
});

describe("keyboardCoordinates", () => {
  const getter = keyboardCoordinates(28);
  const press = (code: string, shiftKey = false) => {
    const event = new KeyboardEvent("keydown", { code, shiftKey, cancelable: true });
    const result = getter(event, { currentCoordinates: { x: 100, y: 40 } } as never);
    return { result, prevented: event.defaultPrevented };
  };

  test("arrows move one day, Shift a week", () => {
    expect(press("ArrowRight").result).toEqual({ x: 128, y: 40 });
    expect(press("ArrowLeft").result).toEqual({ x: 72, y: 40 });
    expect(press("ArrowRight", true).result).toEqual({ x: 100 + 7 * 28, y: 40 });
    expect(press("ArrowLeft", true).result).toEqual({ x: 100 - 7 * 28, y: 40 });
    expect(press("ArrowRight").prevented).toBe(true);
  });

  test("up and down do nothing but are swallowed; other keys are left alone", () => {
    expect(press("ArrowUp")).toEqual({ result: undefined, prevented: true });
    expect(press("ArrowDown")).toEqual({ result: undefined, prevented: true });
    expect(press("KeyA")).toEqual({ result: undefined, prevented: false });
  });
});

describe("keyboardCoordinates clamps a resize at the opposite edge", () => {
  const getter = keyboardCoordinates(28);
  const ORIGIN = 100;
  // a 3-day bar: the start may move at most 2 days right, the end at most 2 days left
  const press = (kind: string, displacedDays: number, code: string, shiftKey = false) => {
    const context = { draggingNodeRect: { left: ORIGIN }, active: { data: { current: { kind, start: "2026-09-16", end: "2026-09-18" } } } };
    const event = new KeyboardEvent("keydown", { code, shiftKey, cancelable: true });
    return getter(event, { currentCoordinates: { x: ORIGIN + displacedDays * 28, y: 4 }, context } as never);
  };

  test("stops at the minimum of one day and does not accumulate past it", () => {
    expect(press("resize-start", 1, "ArrowRight")).toEqual({ x: ORIGIN + 2 * 28, y: 4 });
    expect(press("resize-start", 2, "ArrowRight")).toEqual({ x: ORIGIN + 2 * 28, y: 4 });
    expect(press("resize-start", 1, "ArrowRight", true)).toEqual({ x: ORIGIN + 2 * 28, y: 4 });
    expect(press("resize-end", -2, "ArrowLeft")).toEqual({ x: ORIGIN - 2 * 28, y: 4 });
  });

  test("a displacement already past the clamp (scroll, a stale rect) steps back from the clamped value", () => {
    expect(press("resize-start", 5, "ArrowLeft")).toEqual({ x: ORIGIN + 1 * 28, y: 4 });
    expect(press("resize-end", -6, "ArrowRight")).toEqual({ x: ORIGIN - 1 * 28, y: 4 });
  });

  test("the far side and a move are never clamped", () => {
    expect(press("resize-start", -3, "ArrowLeft")).toEqual({ x: ORIGIN - 4 * 28, y: 4 });
    expect(press("resize-end", 3, "ArrowRight", true)).toEqual({ x: ORIGIN + 10 * 28, y: 4 });
    expect(press("move", 9, "ArrowRight")).toEqual({ x: ORIGIN + 10 * 28, y: 4 });
  });
});

describe("modifiers", () => {
  const run = (modifier: Modifier, x: number, y: number) =>
    modifier({ transform: { x, y, scaleX: 1, scaleY: 1 } } as Parameters<Modifier>[0]);

  test("horizontalOnly zeroes y", () => {
    expect(run(horizontalOnly, 9, 30)).toMatchObject({ x: 9, y: 0 });
  });

  test("verticalOnly zeroes x (the row card only goes up and down)", () => {
    expect(run(verticalOnly, 9, 30)).toMatchObject({ x: 0, y: 30 });
  });

  test("snapToDays rounds x to whole days", () => {
    const snap = snapToDays(28);
    expect(run(snap, 13, 5)).toMatchObject({ x: 0, y: 5 });
    expect(run(snap, 15, 5)).toMatchObject({ x: 28 });
    expect(run(snap, -43, 0)).toMatchObject({ x: -56 });
  });
});

describe("rowSlotAt", () => {
  // the body's top at client y = 200, rows 36 px tall, 5 rows: slot n is the line at 200 + 36 n
  test("the upper half of a row is the slot before it, the lower half the slot after it", () => {
    expect(rowSlotAt(200, 200, 5)).toBe(0);
    expect(rowSlotAt(200 + 17, 200, 5)).toBe(0); // upper half of row 0
    expect(rowSlotAt(200 + 18, 200, 5)).toBe(1); // lower half of row 0 = the slot after it
    expect(rowSlotAt(200 + 36 + 17, 200, 5)).toBe(1);
    expect(rowSlotAt(200 + 36 + 18, 200, 5)).toBe(2);
    expect(rowSlotAt(200 + 4 * 36 + 20, 200, 5)).toBe(5);
  });

  test("is clamped at the first slot and at the row count", () => {
    expect(rowSlotAt(-500, 200, 5)).toBe(0);
    expect(rowSlotAt(9999, 200, 5)).toBe(5);
    expect(rowSlotAt(100, 200, 0)).toBe(0);
  });

  test("follows a scrolled grid: a negative zone top still reaches rows that are not mounted", () => {
    // scrolled 3,600 px: the body starts at -3400, so y = 300 is 3,700 px in = row 102.78 -> slot 103
    expect(rowSlotAt(300, -3400, 1000)).toBe(103);
    expect(rowSlotAt(300, -3400, 50)).toBe(50);
  });
});

describe("rowSlotWithin", () => {
  // the scroller spans y 44..500; its sticky header takes the first 56 px, so rows start at y = 100
  const bounds = { left: 10, right: 900, top: 100, bottom: 500, scrollerTop: 44 };

  test("answers the slot while the pointer is over the rows", () => {
    expect(rowSlotWithin({ x: 400, y: 154 }, 100, bounds, 10)).toBe(2);
    expect(rowSlotWithin({ x: 10, y: 100 }, 100, bounds, 10)).toBe(0);
  });

  test("over the sticky header it answers the first slot below the header, so scrolling up with a held row keeps a line", () => {
    // not scrolled: the body starts at the header's bottom edge
    expect(rowSlotWithin({ x: 400, y: 44 }, 100, bounds, 10)).toBe(0);
    expect(rowSlotWithin({ x: 400, y: 99 }, 100, bounds, 10)).toBe(0);
    // scrolled 10 px: the body starts at y = 90, 10 px of row 0 hide under the header, the first slot fully below it is slot 1
    expect(rowSlotWithin({ x: 400, y: 60 }, 90, bounds, 10)).toBe(1);
    // scrolled 3,600 px (body top at -3500): the header's bottom edge is 3,600 px in = exactly slot 100
    expect(rowSlotWithin({ x: 400, y: 60 }, -3500, bounds, 1000)).toBe(100);
    // never past the row count
    expect(rowSlotWithin({ x: 400, y: 60 }, -3500, bounds, 20)).toBe(20);
  });

  test("answers nothing outside the scroller, or without a live pointer, zone, bounds or count", () => {
    expect(rowSlotWithin({ x: 400, y: 43 }, 100, bounds, 10)).toBeNull(); // above the scroller
    expect(rowSlotWithin({ x: 400, y: 500 }, 100, bounds, 10)).toBeNull(); // the tray below
    expect(rowSlotWithin({ x: 9, y: 200 }, 100, bounds, 10)).toBeNull();
    expect(rowSlotWithin({ x: 900, y: 200 }, 100, bounds, 10)).toBeNull();
    expect(rowSlotWithin({ x: 9, y: 60 }, 100, bounds, 10)).toBeNull(); // beside the header too
    expect(rowSlotWithin(null, 100, bounds, 10)).toBeNull();
    expect(rowSlotWithin({ x: 400, y: 200 }, null, bounds, 10)).toBeNull();
    expect(rowSlotWithin({ x: 400, y: 200 }, 100, null, 10)).toBeNull();
    expect(rowSlotWithin({ x: 400, y: 200 }, 100, bounds, undefined)).toBeNull();
  });
});

describe("rowPositionAfter / isRowNoop", () => {
  test("the announced position is the 1-based place the row takes", () => {
    // the row at index 2 (position 3) of five
    expect(rowPositionAfter(2, 0)).toBe(1);
    expect(rowPositionAfter(2, 1)).toBe(2);
    expect(rowPositionAfter(2, 2)).toBe(3); // the slot before itself
    expect(rowPositionAfter(2, 3)).toBe(3); // the slot after itself
    expect(rowPositionAfter(2, 4)).toBe(4);
    expect(rowPositionAfter(2, 5)).toBe(5);
  });

  test("only the two slots beside the row change nothing", () => {
    expect([0, 1, 2, 3, 4, 5].filter((slot) => isRowNoop(2, slot))).toEqual([2, 3]);
  });
});
