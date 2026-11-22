import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { useLocalToday } from "./useLocalToday";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("useLocalToday", () => {
  test("uses one timer to cross local midnight", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2027, 0, 9, 23, 59, 59, 900));
    const { result } = renderHook(() => useLocalToday());
    expect(result.current).toBe("2027-01-09");
    expect(vi.getTimerCount()).toBe(1);
    act(() => vi.advanceTimersByTime(200));
    expect(result.current).toBe("2027-01-10");
    expect(vi.getTimerCount()).toBe(1);
  });

  test("catches up after a suspended tab resumes", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2027, 0, 9, 18, 0));
    const { result } = renderHook(() => useLocalToday());
    vi.setSystemTime(new Date(2027, 0, 11, 9, 0));
    act(() => window.dispatchEvent(new Event("focus")));
    expect(result.current).toBe("2027-01-11");
    expect(vi.getTimerCount()).toBe(1);
  });

  test("catches up when a background tab becomes visible", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2027, 0, 9, 18, 0));
    const visibility = vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
    const { result } = renderHook(() => useLocalToday());
    vi.setSystemTime(new Date(2027, 0, 11, 9, 0));
    act(() => document.dispatchEvent(new Event("visibilitychange")));
    expect(result.current).toBe("2027-01-09");
    visibility.mockReturnValue("visible");
    act(() => document.dispatchEvent(new Event("visibilitychange")));
    expect(result.current).toBe("2027-01-11");
    expect(vi.getTimerCount()).toBe(1);
  });
});
