import { describe, expect, test } from "vitest";
import type { Modifier } from "@dnd-kit/core";
import { dropOutcome, horizontalOnly, keyboardCoordinates, sameSpan, snapToDays } from "./timelineDrag";
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

  test("sameSpan compares both ends", () => {
    expect(sameSpan(bar, { ...bar })).toBe(true);
    expect(sameSpan(bar, { ...bar, end: "2026-09-19" })).toBe(false);
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

  test("snapToDays rounds x to whole days", () => {
    const snap = snapToDays(28);
    expect(run(snap, 13, 5)).toMatchObject({ x: 0, y: 5 });
    expect(run(snap, 15, 5)).toMatchObject({ x: 28 });
    expect(run(snap, -43, 0)).toMatchObject({ x: -56 });
  });
});
