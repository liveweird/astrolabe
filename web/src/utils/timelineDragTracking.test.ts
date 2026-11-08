import type { DragMoveEvent } from "@dnd-kit/core";
import { describe, expect, it } from "vitest";
import { TIMELINE_DROP_ID, TIMELINE_ROW_DROP_ID, type DragData } from "../hooks/useTimelinePreview";
import { collisionFor, drawSpanOf, outcomeOf, pointerStart, resolveDrag, rowFacts, rowSlotOf, spanOf } from "./timelineDragTracking";
import { makeScale, toEpochDay } from "./timelineScale";

const scale = makeScale("week", { from: toEpochDay("2026-03-02"), to: toEpochDay("2026-03-31") });
const over = (id: string, data: object): DragMoveEvent["over"] => ({ id, data: { current: data } }) as DragMoveEvent["over"];
const trackZone = (zone: object) => over(TIMELINE_DROP_ID, zone);
const bounds = { left: 0, right: 500, top: 50, bottom: 400 };

describe("pointerStart", () => {
  it("reads the coordinates of a pointer activator and none from a keyboard one", () => {
    expect(pointerStart(null)).toBeNull();
    expect(pointerStart(new KeyboardEvent("keydown"))).toBeNull();
    expect(pointerStart(new MouseEvent("pointerdown", { clientX: 12, clientY: 34 }))).toEqual({ x: 12, y: 34 });
  });
});

describe("resolveDrag", () => {
  const held: DragData = { kind: "move", barId: 1, label: "held" };

  it("prefers the active draggable's own data and falls back to what was held at pick-up", () => {
    const own: DragData = { kind: "tray", barId: 2, label: "own" };
    expect(resolveDrag({ data: { current: own } }, { current: held })).toBe(own);
    expect(resolveDrag({ data: { current: undefined } }, { current: held })).toBe(held);
    expect(resolveDrag(null, { current: null })).toBeNull();
  });
});

describe("spanOf and rowFacts", () => {
  it("spanOf needs both dates", () => {
    expect(spanOf({ kind: "move", barId: 1, label: "a", start: "2026-03-02", end: "2026-03-04" })).toEqual({ start: "2026-03-02", end: "2026-03-04" });
    expect(spanOf({ kind: "move", barId: 1, label: "a", start: "2026-03-02" })).toBeNull();
  });

  it("rowFacts states the place the row would take with a slot, its own without one", () => {
    const row: DragData = { kind: "row", barId: 1, label: "Row", position: 3, count: 5 };
    expect(rowFacts(row, null)).toEqual({ name: "Row", count: 5, position: 3 });
    expect(rowFacts(row, 0)).toEqual({ name: "Row", count: 5, position: 1 });
    expect(rowFacts(row, 5)).toEqual({ name: "Row", count: 5, position: 5 });
  });
});

describe("outcomeOf", () => {
  const tray: DragData = { kind: "tray", barId: 1, label: "t" };
  const zone = { zoneLeft: () => 100, visibleBounds: () => bounds };
  const none = { delta: { x: 0, y: 0 }, over: null };

  it("a bar gesture is its whole-day displacement", () => {
    const bar: DragData = { kind: "move", barId: 1, label: "b", start: "2026-03-10", end: "2026-03-12" };
    expect(outcomeOf(bar, { delta: { x: 2.2 * scale.dayWidth, y: 0 }, over: null }, scale, null)).toEqual({ start: "2026-03-12", end: "2026-03-14" });
  });

  it("a tray item takes the day under the live pointer while it is inside the zone's visible part", () => {
    const x = 100 + 5 * scale.dayWidth;
    expect(outcomeOf(tray, { ...none, over: trackZone(zone) }, scale, { x, y: 100 })).toEqual({ start: "2026-03-07", end: "2026-03-13" });
  });

  it("a tray item proposes nothing without a pointer, a zone, its readers or inside the visible bounds", () => {
    const event = { ...none, over: trackZone(zone) };
    expect(outcomeOf(tray, event, scale, null)).toBeNull();
    expect(outcomeOf(tray, none, scale, { x: 200, y: 100 })).toBeNull();
    expect(outcomeOf(tray, { ...none, over: trackZone({ zoneLeft: () => null, visibleBounds: () => bounds }) }, scale, { x: 200, y: 100 })).toBeNull();
    expect(outcomeOf(tray, { ...none, over: trackZone({ zoneLeft: () => 100, visibleBounds: () => null }) }, scale, { x: 200, y: 100 })).toBeNull();
    for (const pointer of [{ x: -1, y: 100 }, { x: 500, y: 100 }, { x: 200, y: 49 }, { x: 200, y: 400 }]) {
      expect(outcomeOf(tray, event, scale, pointer)).toBeNull();
    }
  });
});

describe("drawSpanOf", () => {
  const anchor = toEpochDay("2026-03-10");
  const last = { start: "2026-03-10", end: "2026-03-11" };
  const zone = trackZone({ zoneLeft: () => 100 });

  it("spans from the anchor day to the day under the pointer, in either direction", () => {
    expect(drawSpanOf(zone, scale, { x: 100 + 5 * scale.dayWidth, y: 0 }, anchor, last)).toEqual({ start: "2026-03-07", end: "2026-03-10" });
    expect(drawSpanOf(zone, scale, { x: 100 + 12 * scale.dayWidth, y: 0 }, anchor, last)).toEqual({ start: "2026-03-10", end: "2026-03-14" });
  });

  it("clamps the pointer's day to the scale's range", () => {
    expect(drawSpanOf(zone, scale, { x: 100 - 50 * scale.dayWidth, y: 0 }, anchor, last)).toEqual({ start: "2026-03-02", end: "2026-03-10" });
    expect(drawSpanOf(zone, scale, { x: 100 + 500 * scale.dayWidth, y: 0 }, anchor, last)).toEqual({ start: "2026-03-10", end: "2026-03-31" });
  });

  it("keeps the last span without an anchor, a pointer or the zone's left edge", () => {
    expect(drawSpanOf(zone, scale, { x: 200, y: 0 }, null, last)).toBe(last);
    expect(drawSpanOf(zone, scale, null, anchor, last)).toBe(last);
    expect(drawSpanOf(null, scale, { x: 200, y: 0 }, anchor, last)).toBe(last);
    expect(drawSpanOf(trackZone({ zoneLeft: () => null }), scale, { x: 200, y: 0 }, anchor, last)).toBe(last);
  });
});

describe("rowSlotOf", () => {
  const rowZone = (zoneTop: number | null) => over(TIMELINE_ROW_DROP_ID, { zoneTop: () => zoneTop, rowBounds: () => ({ ...bounds, scrollerTop: 20 }), rowCount: 4 });

  it("answers the slot under the live pointer and nothing without the row zone, a pointer or its readers", () => {
    expect(rowSlotOf(rowZone(50), { x: 10, y: 50 + 36 * 2 })).toBe(2);
    expect(rowSlotOf(rowZone(50), null)).toBeNull();
    expect(rowSlotOf(rowZone(null), { x: 10, y: 100 })).toBeNull();
    expect(rowSlotOf(trackZone({}), { x: 10, y: 100 })).toBeNull();
    expect(rowSlotOf(null, { x: 10, y: 100 })).toBeNull();
  });
});

describe("collisionFor", () => {
  const container = (id: string) => ({ id }) as never;
  const args = (ids: string[]) => ({ droppableContainers: ids.map(container), pointerCoordinates: null }) as never;

  it("a row drag collides only with the row zone, and always", () => {
    expect(collisionFor(true)(args(["a", TIMELINE_ROW_DROP_ID]))).toEqual([{ id: TIMELINE_ROW_DROP_ID, data: { droppableContainer: container(TIMELINE_ROW_DROP_ID), value: 0 } }]);
    expect(collisionFor(true)(args(["a"]))).toEqual([]);
  });

  it("any other drag never sees the row zone", () => {
    expect(collisionFor(false)(args([TIMELINE_ROW_DROP_ID]))).toEqual([]);
  });
});
