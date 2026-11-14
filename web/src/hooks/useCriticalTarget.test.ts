import { renderHook } from "@testing-library/react";
import { describe, expect, test } from "vitest";
import { ApiError } from "../api/http";
import { isRejectedTarget, useCriticalAnnouncement } from "./useCriticalTarget";

describe("isRejectedTarget", () => {
  test("a plain 400 is the target's rejection", () => {
    expect(isRejectedTarget(new ApiError(400, { type: "about:blank", status: 400 }))).toBe(true);
    expect(isRejectedTarget(new ApiError(400, null))).toBe(true);
  });

  test("the typed unknown-baseline 400 is the baseline pick's, not the target's", () => {
    expect(isRejectedTarget(new ApiError(400, { type: "urn:astrolabe:problem:unknown-baseline", status: 400 }))).toBe(false);
  });

  test("any other status, and anything that is not an ApiError, is not a rejection", () => {
    expect(isRejectedTarget(new ApiError(403, { type: "about:blank" }))).toBe(false);
    expect(isRejectedTarget(new ApiError(500, { type: "about:blank" }))).toBe(false);
    expect(isRejectedTarget(new Error("boom"))).toBe(false);
    expect(isRejectedTarget(null)).toBe(false);
    expect(isRejectedTarget(undefined)).toBe(false);
  });
});

type Chain = { id: number; name: string; span: { start: string; end: string } | null } | undefined;
const SPAN = { start: "2026-03-02", end: "2026-04-10" };
const A: Chain = { id: 1, name: "Alpha", span: SPAN };
const B: Chain = { id: 2, name: "Beta", span: SPAN };
const NOTHING_B: Chain = { id: 2, name: "Beta", span: null };
const SAID_A = "Showing the critical path to Alpha";
const SAID_B = "Showing the critical path to Beta";

/** Each step is one render of the page: (the page's target, the view's chain project) -> what that render says. */
function render(steps: Array<[number | null, Chain, string[]]>) {
  const said: string[] = [];
  const { rerender } = renderHook(({ target, chain }: { target: number | null; chain: Chain }) => useCriticalAnnouncement(target, chain, (text) => said.push(text)), {
    initialProps: { target: steps[0][0], chain: steps[0][1] },
  });
  expect(said).toEqual(steps[0][2]);
  for (const [target, chain, expected] of steps.slice(1)) {
    said.length = 0;
    rerender({ target, chain });
    expect(said).toEqual(expected);
  }
}

describe("useCriticalAnnouncement: the sentence is said once per pick", () => {
  test("pick A, its chain arrives: said once, not again on a refetch", () => {
    render([
      [1, undefined, []],
      [1, A, [SAID_A]],
      [1, A, []],
      [1, { ...A! }, []],
    ]);
  });

  test("another baseline picked under A (the kept copy shows no chain, the new document brings it back): silent", () => {
    render([
      [1, A, [SAID_A]],
      [1, undefined, []],
      [1, A, []],
    ]);
  });

  test("A, then B: nothing while B loads over A's kept chain, B said on arrival", () => {
    render([
      [1, A, [SAID_A]],
      [2, A, []],
      [2, undefined, []],
      [2, B, [SAID_B]],
    ]);
  });

  test("A, None, A: a new pick, said again", () => {
    render([
      [1, A, [SAID_A]],
      [null, undefined, []],
      [1, undefined, []],
      [1, A, [SAID_A]],
    ]);
  });

  test("A, then B, then A again before B arrived: A is a new pick", () => {
    render([
      [1, A, [SAID_A]],
      [2, undefined, []],
      [1, A, [SAID_A]],
    ]);
  });

  test("a target the server rejects (cleared, no chain ever arrives): nothing is said", () => {
    render([
      [1, undefined, []],
      [null, undefined, []],
    ]);
  });

  test("a chain that is not the page's target is never said", () => {
    render([[2, A, []]]);
  });

  test("a target with nothing scheduled says so once, by the same rule", () => {
    render([
      [2, NOTHING_B, ["Nothing is scheduled in Beta, so no chain drives its end."]],
      [2, undefined, []],
      [2, NOTHING_B, []],
    ]);
  });
});
