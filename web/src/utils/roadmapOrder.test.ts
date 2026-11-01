import { describe, expect, test } from "vitest";
import type { RoadmapProject, RoadmapView } from "../api/roadmap";
import { appendId, applyRanking, moveBy, moveOver, moveToEdge, moveToSlot, removeId } from "./roadmapOrder";

describe("moveBy", () => {
  test("moves one place up or down and leaves the input alone", () => {
    const ids = [1, 2, 3, 4];
    expect(moveBy(ids, 3, -1)).toEqual([1, 3, 2, 4]);
    expect(moveBy(ids, 2, 1)).toEqual([1, 3, 2, 4]);
    expect(ids).toEqual([1, 2, 3, 4]);
  });

  test("clamps at both ends and ignores an unknown id", () => {
    expect(moveBy([1, 2, 3], 1, -1)).toEqual([1, 2, 3]);
    expect(moveBy([1, 2, 3], 3, 1)).toEqual([1, 2, 3]);
    expect(moveBy([1, 2, 3], 1, 5)).toEqual([2, 3, 1]);
    expect(moveBy([1, 2, 3], 9, -1)).toEqual([1, 2, 3]);
  });
});

describe("moveToEdge", () => {
  test("sends the id to the top or the bottom and leaves the input alone", () => {
    const ids = [1, 2, 3, 4];
    expect(moveToEdge(ids, 3, "top")).toEqual([3, 1, 2, 4]);
    expect(moveToEdge(ids, 2, "bottom")).toEqual([1, 3, 4, 2]);
    expect(ids).toEqual([1, 2, 3, 4]);
  });

  test("is the identity at the edge itself and for an unknown id", () => {
    expect(moveToEdge([1, 2, 3], 1, "top")).toEqual([1, 2, 3]);
    expect(moveToEdge([1, 2, 3], 3, "bottom")).toEqual([1, 2, 3]);
    expect(moveToEdge([1, 2, 3], 9, "top")).toEqual([1, 2, 3]);
  });
});

describe("moveToSlot", () => {
  const ids = [1, 2, 3, 4];

  test("a slot below the row inserts one earlier, a slot above inserts at the slot itself", () => {
    expect(moveToSlot(ids, 1, 3)).toEqual([2, 3, 1, 4]);
    expect(moveToSlot(ids, 1, 4)).toEqual([2, 3, 4, 1]);
    expect(moveToSlot(ids, 4, 1)).toEqual([1, 4, 2, 3]);
    expect(moveToSlot(ids, 4, 0)).toEqual([4, 1, 2, 3]);
    expect(moveToSlot(ids, 3, 0)).toEqual([3, 1, 2, 4]);
    expect(ids).toEqual([1, 2, 3, 4]);
  });

  test("a slot of from or from + 1 is the identity", () => {
    for (const id of ids) {
      const from = ids.indexOf(id);
      expect(moveToSlot(ids, id, from)).toEqual(ids);
      expect(moveToSlot(ids, id, from + 1)).toEqual(ids);
    }
  });

  test("a slot outside the list is clamped; an unknown id changes nothing", () => {
    expect(moveToSlot(ids, 2, 99)).toEqual([1, 3, 4, 2]);
    expect(moveToSlot(ids, 2, -5)).toEqual([2, 1, 3, 4]);
    expect(moveToSlot(ids, 9, 2)).toEqual(ids);
  });
});

describe("moveOver", () => {
  test("puts the dragged id where the target is, shifting the rows between", () => {
    expect(moveOver([1, 2, 3, 4], 1, 3)).toEqual([2, 3, 1, 4]);
    expect(moveOver([1, 2, 3, 4], 4, 2)).toEqual([1, 4, 2, 3]);
    expect(moveOver([1, 2, 3, 4], 2, 2)).toEqual([1, 2, 3, 4]);
  });

  test("an unknown id on either side changes nothing", () => {
    expect(moveOver([1, 2], 9, 1)).toEqual([1, 2]);
    expect(moveOver([1, 2], 1, 9)).toEqual([1, 2]);
  });
});

describe("appendId / removeId", () => {
  test("appending ranks at the end, once", () => {
    expect(appendId([1, 2], 3)).toEqual([1, 2, 3]);
    expect(appendId([1, 2], 1)).toEqual([1, 2]);
    expect(appendId([], 7)).toEqual([7]);
  });

  test("removing closes the gap and tolerates an absent id", () => {
    expect(removeId([1, 2, 3], 2)).toEqual([1, 3]);
    expect(removeId([1, 2, 3], 9)).toEqual([1, 2, 3]);
  });
});

const project = (id: number, name: string): RoadmapProject => ({
  id,
  name,
  programId: 10,
  programName: "Billing",
  workStreamId: 1,
  workStreamName: "Platform",
  ownerName: "Ola",
  targetStart: null,
  targetEnd: null,
});

describe("applyRanking", () => {
  const view: RoadmapView = {
    revision: 3,
    can: { editRank: true },
    ranked: [
      { position: 1, project: project(1, "Alpha") },
      { position: 2, project: project(2, "beta") },
    ],
    unranked: [project(3, "Gamma"), project(4, "Delta")],
  };

  test("renumbers the ranked list 1..n in the given order and keeps the revision", () => {
    const next = applyRanking(view, [2, 1, 3]);
    expect(next.ranked.map((e) => [e.position, e.project.id])).toEqual([[1, 2], [2, 1], [3, 3]]);
    expect(next.revision).toBe(3);
    expect(next.can).toEqual({ editRank: true });
  });

  test("every project left out becomes unranked, by name case-insensitively", () => {
    const next = applyRanking(view, [3]);
    expect(next.ranked.map((e) => e.project.id)).toEqual([3]);
    expect(next.unranked.map((p) => p.name)).toEqual(["Alpha", "beta", "Delta"]);
  });

  test("names that differ only in case order by id, and an unknown id is skipped", () => {
    const tied: RoadmapView = { ...view, ranked: [], unranked: [project(6, "same"), project(5, "Same")] };
    expect(applyRanking(tied, [99]).ranked).toEqual([]);
    expect(applyRanking(tied, []).unranked.map((p) => p.id)).toEqual([5, 6]);
  });
});
