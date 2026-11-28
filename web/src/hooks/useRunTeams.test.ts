import { describe, expect, test } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { useRunTeams } from "./useRunTeams";

describe("useRunTeams", () => {
  test("follows the page's own set until one is chosen, and is that very array while untouched", () => {
    const first = [1, 2, 3];
    const { result, rerender } = renderHook(({ ids }) => useRunTeams(ids), { initialProps: { ids: first } });
    expect(result.current.ids).toBe(first);
    expect(result.current.chosen).toBe(false);
    const second = [1, 2];
    rerender({ ids: second });
    expect(result.current.ids).toBe(second);
  });

  test("a chosen set is kept sorted and without repeats, and stays when the page's set changes", () => {
    const { result, rerender } = renderHook(({ ids }) => useRunTeams(ids), { initialProps: { ids: [1, 2, 3] } });
    act(() => result.current.set([4, 2, 4, 1]));
    expect(result.current).toMatchObject({ ids: [1, 2, 4], chosen: true });
    rerender({ ids: [3] });
    expect(result.current.ids).toEqual([1, 2, 4]);
  });

  test("choosing the page's set again (the reset) stores no choice: the picker follows the page's later changes", () => {
    const { result, rerender } = renderHook(({ ids }) => useRunTeams(ids), { initialProps: { ids: [1, 2, 3] } });
    act(() => result.current.set([1]));
    act(() => result.current.set([1, 2, 3]));
    const next = [2, 3];
    rerender({ ids: next });
    expect(result.current.ids).toBe(next);
    expect(result.current.chosen).toBe(false);
    act(() => result.current.set([2, 3, 1]));
    act(() => result.current.set([3, 2]));
    const last = [3];
    rerender({ ids: last });
    expect(result.current.ids).toBe(last);
  });

  test("choosing the page's set again is no choice (the page's array comes back); an empty choice is one", () => {
    const own = [1, 2, 3];
    const { result } = renderHook(() => useRunTeams(own));
    act(() => result.current.set([3, 1]));
    expect(result.current.chosen).toBe(true);
    act(() => result.current.set([3, 2, 1]));
    expect(result.current.chosen).toBe(false);
    expect(result.current.ids).toBe(own);
    act(() => result.current.set([]));
    expect(result.current).toMatchObject({ ids: [], chosen: true });
  });
});
