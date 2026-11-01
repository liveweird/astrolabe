import { describe, expect, test } from "vitest";
import type { RoadmapProject, RoadmapView } from "../api/roadmap";
import { appendId, applyRanking, moveAmongVisible, moveBy, moveToEdge, moveToSlot, rankingAfterDrop, removeId, sameIds } from "./roadmapOrder";

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

describe("moveAmongVisible", () => {
  const full = [1, 2, 3, 4, 5];

  test("with everything visible it is moveToSlot", () => {
    for (const id of full) {
      for (let slot = 0; slot <= full.length; slot++) expect(moveAmongVisible(full, full, id, slot)).toEqual(moveToSlot(full, id, slot));
    }
  });

  test("a slot between visible rows lands just before the visible row that follows it; hidden rows keep their order", () => {
    // 2 and 4 are hidden: the user sees [1, 3, 5].
    const visible = [1, 3, 5];
    expect(moveAmongVisible(full, visible, 5, 1)).toEqual([1, 2, 5, 3, 4]);
    expect(moveAmongVisible(full, visible, 5, 0)).toEqual([5, 1, 2, 3, 4]);
    expect(moveAmongVisible(full, visible, 1, 2)).toEqual([2, 3, 4, 1, 5]);
  });

  test("the final gap goes after the last visible row", () => {
    expect(moveAmongVisible(full, [1, 3], 1, 2)).toEqual([2, 3, 1, 4, 5]);
    expect(moveAmongVisible([1, 2, 3, 4], [1, 2], 1, 2)).toEqual([2, 1, 3, 4]);
  });

  test("a gap beside the row itself is the identity, hidden neighbours included", () => {
    const visible = [1, 3, 5];
    expect(moveAmongVisible(full, visible, 1, 0)).toEqual(full);
    expect(moveAmongVisible(full, visible, 1, 1)).toEqual(full);
    expect(moveAmongVisible(full, visible, 3, 2)).toEqual(full);
  });

  test("an id that is not ranked yet is inserted at the gap; with no other visible row it is appended", () => {
    expect(moveAmongVisible([1, 2, 3], [1, 2, 3], 9, 1)).toEqual([1, 9, 2, 3]);
    expect(moveAmongVisible([1, 2, 3], [1, 2, 3], 9, 3)).toEqual([1, 2, 3, 9]);
    expect(moveAmongVisible([1, 2, 3], [], 9, 0)).toEqual([1, 2, 3, 9]);
    expect(moveAmongVisible([], [], 9, 0)).toEqual([9]);
  });

  test("the only visible row stays where it is", () => {
    expect(moveAmongVisible(full, [3], 3, 0)).toEqual(full);
    expect(moveAmongVisible(full, [3], 3, 1)).toEqual(full);
  });

  test("a slot outside the visible rows is clamped and the input is left alone", () => {
    const visible = [1, 3, 5];
    expect(moveAmongVisible(full, visible, 1, 99)).toEqual([2, 3, 4, 5, 1]);
    expect(moveAmongVisible(full, visible, 5, -4)).toEqual([5, 1, 2, 3, 4]);
    expect(full).toEqual([1, 2, 3, 4, 5]);
  });
});

describe("rankingAfterDrop", () => {
  // The displayed rows: ranked [1, 2, 3], the divider (index 3), then unranked rows.
  const ranked = [1, 2, 3];

  test("a slot up to the divider is a place in the ranking: a ranked row moves there", () => {
    expect(rankingAfterDrop(ranked, ranked, 3, 0)).toEqual([3, 1, 2]);
    expect(rankingAfterDrop(ranked, ranked, 1, 3)).toEqual([2, 3, 1]);
  });

  test("an unranked row dropped above the divider is ranked at that slot", () => {
    expect(rankingAfterDrop(ranked, ranked, 9, 1)).toEqual([1, 9, 2, 3]);
    expect(rankingAfterDrop(ranked, ranked, 9, 3)).toEqual([1, 2, 3, 9]);
    expect(rankingAfterDrop(ranked, ranked, 9, 0)).toEqual([9, 1, 2, 3]);
  });

  test("a ranked row dropped beyond the divider is unranked; an unranked one changes nothing", () => {
    expect(rankingAfterDrop(ranked, ranked, 2, 4)).toEqual([1, 3]);
    expect(rankingAfterDrop(ranked, ranked, 2, 7)).toEqual([1, 3]);
    expect(rankingAfterDrop(ranked, ranked, 9, 4)).toEqual(ranked);
    expect(rankingAfterDrop(ranked, ranked, 9, 6)).toEqual(ranked);
  });

  test("with nothing ranked the divider is first: slot 0 ranks, anything later is a no-op", () => {
    expect(rankingAfterDrop([], [], 9, 0)).toEqual([9]);
    expect(rankingAfterDrop([], [], 9, 1)).toEqual([]);
  });

  test("under a filter the slots count the visible ranked rows, the hidden ones keep their place", () => {
    expect(rankingAfterDrop([1, 2, 3, 4], [1, 3], 9, 1)).toEqual([1, 2, 9, 3, 4]);
    expect(rankingAfterDrop([1, 2, 3, 4], [1, 3], 3, 3)).toEqual([1, 2, 4]);
  });
});

describe("sameIds", () => {
  test("is true only for the same ids in the same order", () => {
    expect(sameIds([1, 2], [1, 2])).toBe(true);
    expect(sameIds([1, 2], [2, 1])).toBe(false);
    expect(sameIds([1], [1, 2])).toBe(false);
    expect(sameIds([], [])).toBe(true);
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
  ownerPersonId: 5,
  ownerName: "Ola",
  targetStart: null,
  targetEnd: null,
  rankPosition: null,
  teamIds: [],
  span: null,
  drift: null,
  flags: [],
  can: { editTargetWindow: false },
});

describe("applyRanking", () => {
  const view: RoadmapView = {
    revision: 3,
    can: { editRank: true },
    teams: [],
    links: [],
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

  test("each project's rankPosition follows the new list; the unranked ones lose it", () => {
    const ranked = project(1, "Alpha");
    const next = applyRanking({ ...view, ranked: [{ position: 1, project: { ...ranked, rankPosition: 1 } }], unranked: [{ ...project(3, "Gamma"), rankPosition: null }] }, [3, 1]);
    expect(next.ranked.map((e) => [e.position, e.project.rankPosition])).toEqual([[1, 1], [2, 2]]);
    expect(applyRanking(next, [3]).unranked.map((p) => [p.id, p.rankPosition])).toEqual([[1, null]]);
  });

  test("names that differ only in case order by id, and an unknown id is skipped", () => {
    const tied: RoadmapView = { ...view, ranked: [], unranked: [project(6, "same"), project(5, "Same")] };
    expect(applyRanking(tied, [99]).ranked).toEqual([]);
    expect(applyRanking(tied, []).unranked.map((p) => p.id)).toEqual([5, 6]);
  });
});
