import { describe, expect, test } from "vitest";
import { applyPin } from "./pinUpdate";

const view = { revision: 4, scheduled: [{ id: 1, pinned: false }, { id: 2, pinned: true }], unscheduled: [{ id: 3, pinned: false }] };

describe("applyPin", () => {
  test("flips one scheduled row's flag and nothing else", () => {
    expect(applyPin(view, 1, true)).toEqual({ ...view, scheduled: [{ id: 1, pinned: true }, { id: 2, pinned: true }] });
    expect(applyPin(view, 2, false).scheduled).toEqual([{ id: 1, pinned: false }, { id: 2, pinned: false }]);
  });

  test("returns the view itself when the row already reads so or is not a scheduled row", () => {
    expect(applyPin(view, 2, true)).toBe(view);
    expect(applyPin(view, 3, true)).toBe(view);
    expect(applyPin(view, 99, true)).toBe(view);
  });
});
