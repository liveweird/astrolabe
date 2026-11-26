import { describe, expect, test } from "vitest";
import { planOf } from "../test/planView";
import {
  applyOrder,
  canOrder,
  canOrderAnything,
  droppedIds,
  fullIds,
  listOf,
  nodeOf,
  orderBlocked,
  orderRevision,
  placeIn,
  siblingBlocks,
  siblingIds,
  slotAt,
  slotEdge,
  steppedIds,
  withOrderRevision,
} from "./planOrder";
import { NO_FILTER, planRows } from "./planTree";

// Platform (Billing > two projects, Identity, Ledger), Finance (Tax, Audit) open; Legacy and Old closed.
const PLAN = planOf(
  [
    { id: 1, name: "Platform", programOrderRevision: 3, programs: [{ id: 10, name: "Billing", projects: [{ id: 100, name: "Invoices" }, { id: 101, name: "Taxes" }] }, { id: 11, name: "Identity" }, { id: 13, name: "Ledger" }] },
    { id: 3, name: "Finance", can: { orderPrograms: false }, programs: [{ id: 14, name: "Tax" }, { id: 15, name: "Audit" }] },
    { id: 2, name: "Legacy", endDate: "2025-12-31", programs: [{ id: 12, name: "Archive" }] },
    { id: 4, name: "Old", endDate: "2024-12-31" },
  ],
  { revision: 8, workStreamOrderRevision: 2 },
);
const ws = (id: number) => ({ kind: "workStream", id }) as const;
const pg = (id: number) => ({ kind: "program", id }) as const;

describe("planOrder: lists and siblings", () => {
  test("a node's list is the work streams, or the programs of its own stream; a node the plan does not hold has none", () => {
    expect(listOf(PLAN, ws(3))).toEqual({ kind: "workStream" });
    expect(listOf(PLAN, pg(14))).toEqual({ kind: "program", streamId: 3 });
    expect(listOf(PLAN, pg(99))).toBeNull();
    expect(listOf(PLAN, ws(99))).toBeNull();
    expect(fullIds(PLAN, { kind: "workStream" })).toEqual([1, 3, 2, 4]);
    expect(fullIds(PLAN, { kind: "program", streamId: 1 })).toEqual([10, 11, 13]);
    expect(fullIds(PLAN, { kind: "program", streamId: 99 })).toEqual([]);
  });

  test("a work stream moves among the streams in its own state only; a program among its stream's", () => {
    expect(siblingIds(PLAN, ws(1))).toEqual([1, 3]);
    expect(siblingIds(PLAN, ws(4))).toEqual([2, 4]);
    expect(siblingIds(PLAN, pg(11))).toEqual([10, 11, 13]);
    expect(siblingIds(PLAN, pg(99))).toEqual([]);
  });

  test("a row stands for a node only when it is a work stream or a program", () => {
    const rows = planRows(PLAN, new Set(), NO_FILTER);
    expect(rows.map((row) => nodeOf(row))).toContainEqual(ws(1));
    expect(rows.find((row) => row.kind === "project")).toBeDefined();
    expect(nodeOf(rows.find((row) => row.kind === "project")!)).toBeNull();
  });

  test("the right is the document's flag: the view's for the streams, the stream's for its programs", () => {
    expect(canOrder(PLAN, ws(1))).toBe(true);
    expect(canOrder(PLAN, pg(10))).toBe(true);
    expect(canOrder(PLAN, pg(14))).toBe(false);
    expect(canOrder({ ...PLAN, can: { ...PLAN.can, orderWorkStreams: false } }, ws(1))).toBe(false);
    expect(canOrder(PLAN, pg(99))).toBe(false);
  });

  test("a place needs the right and at least one sibling; it is the row's index among its siblings", () => {
    expect(placeIn(PLAN, ws(3))).toEqual({ index: 1, count: 2 });
    expect(placeIn(PLAN, ws(4))).toEqual({ index: 1, count: 2 });
    expect(placeIn(PLAN, pg(13))).toEqual({ index: 2, count: 3 });
    expect(placeIn(PLAN, pg(14))).toBeNull();
    expect(placeIn(PLAN, pg(12))).toBeNull();
    const alone = planOf([{ id: 1, name: "Solo" }]);
    expect(placeIn(alone, ws(1))).toBeNull();
  });

  test("anything to re-arrange: two streams of a state with the right, or a stream's programs with its right", () => {
    expect(canOrderAnything(PLAN)).toBe(true);
    expect(canOrderAnything(planOf([{ id: 1, name: "Solo" }]))).toBe(false);
    expect(canOrderAnything({ ...PLAN, can: { ...PLAN.can, orderWorkStreams: false } })).toBe(true);
    const none = planOf([{ id: 1, name: "A", can: { orderPrograms: false }, programs: [{ id: 10, name: "x" }, { id: 11, name: "y" }] }, { id: 2, name: "B" }], { can: { createWorkStream: false, orderWorkStreams: false } });
    expect(canOrderAnything(none)).toBe(false);
  });

  test("a search, an owner or a focus blocks reordering; hide closed alone does not", () => {
    expect(orderBlocked(NO_FILTER)).toBe(false);
    expect(orderBlocked({ ...NO_FILTER, hideClosed: true })).toBe(false);
    expect(orderBlocked({ ...NO_FILTER, q: "bil" })).toBe(true);
    expect(orderBlocked({ ...NO_FILTER, q: "  " })).toBe(false);
    expect(orderBlocked({ ...NO_FILTER, ownerPersonId: 4 })).toBe(true);
    expect(orderBlocked({ ...NO_FILTER, focus: { kind: "program", id: 10 } })).toBe(true);
  });
});

describe("planOrder: the new complete list", () => {
  test("a drop keeps the rest of the list in place: the closed streams stay after the open ones", () => {
    expect(droppedIds(PLAN, ws(3), 0)).toEqual([3, 1, 2, 4]);
    expect(droppedIds(PLAN, ws(1), 2)).toEqual([3, 1, 2, 4]);
    expect(droppedIds(PLAN, ws(2), 2)).toEqual([1, 3, 4, 2]);
    expect(droppedIds(PLAN, pg(10), 3)).toEqual([11, 13, 10]);
    expect(droppedIds(PLAN, pg(13), 0)).toEqual([13, 10, 11]);
  });

  test("a drop beside the row itself is the list as it is; a node the plan does not hold gives nothing", () => {
    expect(droppedIds(PLAN, pg(10), 0)).toEqual([10, 11, 13]);
    expect(droppedIds(PLAN, pg(10), 1)).toEqual([10, 11, 13]);
    expect(droppedIds(PLAN, pg(99), 1)).toEqual([]);
  });

  test("one step up or down, and unchanged at either end", () => {
    expect(steppedIds(PLAN, pg(11), -1)).toEqual([11, 10, 13]);
    expect(steppedIds(PLAN, pg(11), 1)).toEqual([10, 13, 11]);
    expect(steppedIds(PLAN, pg(10), -1)).toEqual([10, 11, 13]);
    expect(steppedIds(PLAN, pg(13), 1)).toEqual([10, 11, 13]);
    expect(steppedIds(PLAN, ws(3), 1)).toEqual([1, 3, 2, 4]);
    expect(steppedIds(PLAN, ws(3), -1)).toEqual([3, 1, 2, 4]);
    expect(steppedIds(PLAN, pg(99), 1)).toEqual([]);
  });
});

describe("planOrder: the view after a write", () => {
  test("applyOrder puts the listed rows first in order, keeps the rest, and never lifts a closed stream over an open one", () => {
    const programs = applyOrder(PLAN, { kind: "program", streamId: 1 }, [13, 10]);
    expect(programs.workStreams[0].programs.map((program) => program.id)).toEqual([13, 10, 11]);
    expect(programs.workStreams[1]).toBe(PLAN.workStreams[1]);
    const streams = applyOrder(PLAN, { kind: "workStream" }, [4, 2, 3, 1, 99]);
    expect(streams.workStreams.map((stream) => stream.id)).toEqual([3, 1, 4, 2]);
    expect(PLAN.workStreams.map((stream) => stream.id)).toEqual([1, 3, 2, 4]);
  });

  test("the answered revision is stored in the list's own place, and the plan revision never goes down", () => {
    const programs = withOrderRevision(PLAN, { kind: "program", streamId: 1 }, 9);
    expect(programs.revision).toBe(9);
    expect(programs.workStreams[0].programOrderRevision).toBe(9);
    expect(programs.workStreamOrderRevision).toBe(2);
    expect(orderRevision(programs, { kind: "program", streamId: 1 })).toBe(9);
    const streams = withOrderRevision(PLAN, { kind: "workStream" }, 5);
    expect(streams.revision).toBe(8);
    expect(streams.workStreamOrderRevision).toBe(5);
    expect(orderRevision(PLAN, { kind: "workStream" })).toBe(2);
    expect(orderRevision(PLAN, { kind: "program", streamId: 99 })).toBe(0);
  });
});

describe("planOrder: where a drop lands", () => {
  test("a sibling's block is its row and the visible rows under it, so folds show in the blocks", () => {
    const open = planRows(PLAN, new Set(), NO_FILTER);
    expect(siblingBlocks(open, PLAN, pg(10))).toEqual([
      { id: 10, first: "pg:10", last: "pj:101" },
      { id: 11, first: "pg:11", last: "pg:11" },
      { id: 13, first: "pg:13", last: "pg:13" },
    ]);
    expect(siblingBlocks(open, PLAN, ws(1))).toEqual([
      { id: 1, first: "ws:1", last: "pg:13" },
      { id: 3, first: "ws:3", last: "pg:15" },
    ]);
    const folded = planRows(PLAN, new Set(["ws:1", "pg:10"]), NO_FILTER);
    expect(siblingBlocks(folded, PLAN, ws(1))[0]).toEqual({ id: 1, first: "ws:1", last: "ws:1" });
    expect(siblingBlocks(planRows(PLAN, new Set(["pg:10"]), NO_FILTER), PLAN, pg(10))[0]).toEqual({ id: 10, first: "pg:10", last: "pg:10" });
  });

  test("the closed streams' blocks are the closed ones only", () => {
    expect(siblingBlocks(planRows(PLAN, new Set(), NO_FILTER), PLAN, ws(2)).map((block) => block.id)).toEqual([2, 4]);
  });

  const blocks = [
    { top: 100, bottom: 140 },
    { top: 140, bottom: 250 },
    { top: 250, bottom: 280 },
  ];

  test("the slot is the number of blocks whose middle is above the pointer, within the list's extent", () => {
    expect(slotAt(blocks, 101)).toBe(0);
    expect(slotAt(blocks, 120)).toBe(0);
    expect(slotAt(blocks, 121)).toBe(1);
    expect(slotAt(blocks, 195)).toBe(1);
    expect(slotAt(blocks, 196)).toBe(2);
    expect(slotAt(blocks, 279)).toBe(3);
    expect(slotAt(blocks, 280)).toBe(3);
  });

  test("outside the extent nothing lands: above its top (the parent's row can lengthen it) or below the last block", () => {
    expect(slotAt(blocks, 99)).toBeNull();
    expect(slotAt(blocks, 281)).toBeNull();
    expect(slotAt(blocks, 80, 64)).toBe(0);
    expect(slotAt(blocks, 63, 64)).toBeNull();
    expect(slotAt([], 120)).toBeNull();
  });

  test("the drop line sits at the top of the block that follows the gap, and at the bottom of the last one for the final gap", () => {
    expect(slotEdge(blocks, 0)).toBe(100);
    expect(slotEdge(blocks, 2)).toBe(250);
    expect(slotEdge(blocks, 3)).toBe(280);
    expect(slotEdge([], 0)).toBeNull();
  });
});
