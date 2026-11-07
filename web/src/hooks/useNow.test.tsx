import { afterEach, describe, expect, test, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { useNow } from "./useNow";

describe("useNow", () => {
  afterEach(() => vi.useRealTimers());

  test("starts at the current time and re-reads it every period, and stops with the component", () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    const { result, unmount } = renderHook(() => useNow(60_000));
    expect(result.current).toBe(1_000_000);
    act(() => {
      vi.advanceTimersByTime(60_000);
    });
    expect(result.current).toBe(1_060_000);
    act(() => {
      vi.advanceTimersByTime(30_000);
    });
    expect(result.current).toBe(1_060_000);
    unmount();
    expect(vi.getTimerCount()).toBe(0);
  });

  test("`readAt` is a floor: the moment figures were read is never older than the tick (and a later tick wins)", () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    const { result } = renderHook(() => useNow(60_000, 1_030_000));
    expect(result.current).toBe(1_030_000);
    act(() => {
      vi.advanceTimersByTime(60_000);
    });
    expect(result.current).toBe(1_060_000);
  });
});
