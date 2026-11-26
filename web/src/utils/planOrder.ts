import type { PlanView, PlanWorkStream } from "../api/plan";
import { moveAmongVisible } from "./roadmapOrder";
import { isSearching, type PlanFilter, type PlanTreeRow } from "./planTree";

// The Plan page's order arithmetic, pure: which rows can be moved among which (a work stream among the work streams of its own state, a program among
// the programs of its stream - never a project, never to another parent), the new COMPLETE list for a move or a drop, the view as it will read once the
// list is saved, and where a drop lands from the blocks' positions. The write path is `hooks/usePlanOrder.ts`; every list here is the document's own.

/** A node that can be put in another place: a work stream or a program. */
export type OrderNode = { kind: "workStream" | "program"; id: number };

/** The two kinds of list the server keeps: the work streams (one list), and the programs of one work stream. */
export type OrderList = { kind: "workStream" } | { kind: "program"; streamId: number };

/** The node a row stands for; `null` for a project, which is never re-arranged. */
export function nodeOf(row: PlanTreeRow): OrderNode | null {
  if (row.kind === "workStream") return { kind: "workStream", id: row.stream.id };
  return row.kind === "program" ? { kind: "program", id: row.program.id } : null;
}

/** The list a node belongs to in the document now; `null` when the document does not hold it. */
export function listOf(view: PlanView, node: OrderNode): OrderList | null {
  if (node.kind === "workStream") return view.workStreams.some((stream) => stream.id === node.id) ? { kind: "workStream" } : null;
  const stream = view.workStreams.find((candidate) => candidate.programs.some((program) => program.id === node.id));
  return stream === undefined ? null : { kind: "program", streamId: stream.id };
}

/** The effective order of a whole list, as the document has it: what a PUT sends, with the one change applied. */
export function fullIds(view: PlanView, list: OrderList): number[] {
  if (list.kind === "workStream") return view.workStreams.map((stream) => stream.id);
  return view.workStreams.find((stream) => stream.id === list.streamId)?.programs.map((program) => program.id) ?? [];
}

/** The revision a list's PUT compares: the view's own for the work streams, the stream's for its programs. */
export function orderRevision(view: PlanView, list: OrderList): number {
  return list.kind === "workStream" ? view.workStreamOrderRevision : (view.workStreams.find((stream) => stream.id === list.streamId)?.programOrderRevision ?? 0);
}

/**
 * The ids a node can be moved among, in order: the work streams in the same state (the server shows closed streams after every open one whatever
 * their position, so an open stream is never moved among the closed ones) or the programs of its stream. Empty when the document does not hold the node.
 */
export function siblingIds(view: PlanView, node: OrderNode): number[] {
  const list = listOf(view, node);
  if (list === null) return [];
  if (list.kind === "program") return fullIds(view, list);
  const closed = view.workStreams.find((stream) => stream.id === node.id)?.endDate !== null;
  return view.workStreams.filter((stream) => (stream.endDate !== null) === closed).map((stream) => stream.id);
}

/** Whether the caller may re-arrange the list the node is in, by the document's own flags (the guards' arithmetic), never by role. */
export function canOrder(view: PlanView, node: OrderNode): boolean {
  if (node.kind === "workStream") return view.can.orderWorkStreams;
  const list = listOf(view, node);
  return list?.kind === "program" && (view.workStreams.find((stream) => stream.id === list.streamId)?.can.orderPrograms ?? false);
}

/** The node's place among the ones it can be moved among, or `null` when it cannot be moved at all (no right, or nothing to move it among). */
export function placeIn(view: PlanView, node: OrderNode): { index: number; count: number } | null {
  if (!canOrder(view, node)) return null;
  const siblings = siblingIds(view, node);
  return siblings.length < 2 ? null : { index: siblings.indexOf(node.id), count: siblings.length };
}

/** Whether any list the caller may re-arrange has something to move: where the page says why reordering is off. */
export function canOrderAnything(view: PlanView): boolean {
  const streams = (closed: boolean) => view.workStreams.filter((stream) => (stream.endDate !== null) === closed).length;
  if (view.can.orderWorkStreams && (streams(false) > 1 || streams(true) > 1)) return true;
  return view.workStreams.some((stream) => stream.can.orderPrograms && stream.programs.length > 1);
}

/**
 * Whether the table shows only PART of the plan, so a move would be made among rows the user cannot see: a search, an owner or a focus. A drop or a
 * move never goes out then (hide closed alone is not partial: it drops whole closed streams, which never mix with the open ones).
 */
export const orderBlocked = (filter: PlanFilter): boolean => isSearching(filter) || filter.focus !== null;

/**
 * The complete list after `node` is put into the gap `slot` among its siblings (0 = before the first, `count` = after the last; the Roadmap's
 * `moveAmongVisible` numbering): the rest of the list keeps its order and its places, so the other state's work streams are untouched.
 */
export function droppedIds(view: PlanView, node: OrderNode, slot: number): number[] {
  const list = listOf(view, node);
  return list === null ? [] : moveAmongVisible(fullIds(view, list), siblingIds(view, node), node.id, slot);
}

/** The complete list after `node` moved one place up (-1) or down (+1) among its siblings; unchanged at either end. */
export function steppedIds(view: PlanView, node: OrderNode, delta: -1 | 1): number[] {
  const at = siblingIds(view, node).indexOf(node.id);
  return at < 0 ? [] : droppedIds(view, node, delta < 0 ? at - 1 : at + 2);
}

/** The ids' items first, in that order, then the rest as they were. */
function reordered<T extends { id: number }>(items: readonly T[], ids: readonly number[]): T[] {
  const byId = new Map(items.map((item) => [item.id, item]));
  const listed = ids.flatMap((id) => byId.get(id) ?? []);
  const taken = new Set(listed.map((item) => item.id));
  return [...listed, ...items.filter((item) => !taken.has(item.id))];
}

/**
 * The view as it will read once `ids` is saved: the list in that order (an id the view does not know is skipped, a row not listed keeps its place after
 * the listed ones), the closed work streams last whatever the list says - the server's rule. Revisions stay: the answer brings the new one.
 */
export function applyOrder(view: PlanView, list: OrderList, ids: readonly number[]): PlanView {
  if (list.kind === "program") {
    return { ...view, workStreams: view.workStreams.map((stream) => (stream.id === list.streamId ? { ...stream, programs: reordered(stream.programs, ids) } : stream)) };
  }
  const sorted = reordered(view.workStreams, ids);
  const open = (stream: PlanWorkStream) => stream.endDate === null;
  return { ...view, workStreams: [...sorted.filter(open), ...sorted.filter((stream) => !open(stream))] };
}

/** The view with the list's revision the PUT answered stored (and the plan revision, which the write bumped, no lower than it). */
export function withOrderRevision(view: PlanView, list: OrderList, revision: number): PlanView {
  const next = { ...view, revision: Math.max(view.revision, revision) };
  if (list.kind === "workStream") return { ...next, workStreamOrderRevision: revision };
  return { ...next, workStreams: view.workStreams.map((stream) => (stream.id === list.streamId ? { ...stream, programOrderRevision: revision } : stream)) };
}

/** A sibling's block of rows: the row and every visible row under it, named by the keys of its first and last row. */
export type OrderBlock = { id: number; first: string; last: string };

/**
 * The blocks a node can be dropped among, in table order: for each sibling, its row and the visible rows under it (a program: its projects; a work
 * stream: its programs and their projects), so a drop is measured against what the user sees, whatever the folds show.
 */
export function siblingBlocks(rows: readonly PlanTreeRow[], view: PlanView, node: OrderNode): OrderBlock[] {
  const siblings = new Set(siblingIds(view, node));
  const blocks: OrderBlock[] = [];
  rows.forEach((row, index) => {
    const own = nodeOf(row);
    if (own === null || own.kind !== node.kind || !siblings.has(own.id)) return;
    let end = index;
    while (end + 1 < rows.length && rows[end + 1].depth > row.depth) end++;
    blocks.push({ id: own.id, first: row.key, last: rows[end].key });
  });
  return blocks;
}

/** A block's place on the screen, in client coordinates. */
export type BlockRect = { top: number; bottom: number };

/**
 * The gap a drop at client `y` lands in, by the blocks' MIDPOINTS (the number of blocks whose middle lies above the pointer): 0 is before the first, `n` after
 * the last. `null` outside the list's extent - from `extentTop` (the parent's own row, so the first gap can be reached) to the last block's bottom - where a drop
 * does nothing.
 */
export function slotAt(blocks: readonly BlockRect[], y: number, extentTop: number = blocks[0]?.top ?? 0): number | null {
  if (blocks.length === 0 || y < extentTop || y > blocks[blocks.length - 1].bottom) return null;
  return blocks.filter((block) => (block.top + block.bottom) / 2 < y).length;
}

/** Where the drop line sits for `slot`: the top edge of the block that follows the gap, the bottom edge of the last block for the final gap. */
export function slotEdge(blocks: readonly BlockRect[], slot: number): number | null {
  if (blocks.length === 0) return null;
  return slot < blocks.length ? blocks[slot].top : blocks[blocks.length - 1].bottom;
}
