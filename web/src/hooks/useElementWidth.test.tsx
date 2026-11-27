import { afterEach, describe, expect, test, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { useElementWidth } from "./useElementWidth";

/** An element with a size we can change (happy-dom lays nothing out), and a ResizeObserver that lets the test fire. */
function setup(width: number) {
  const element = document.createElement("div");
  let current = width;
  Object.defineProperty(element, "clientWidth", { configurable: true, get: () => current });
  let notify: () => void = () => undefined;
  const observe = vi.fn();
  const disconnect = vi.fn();
  vi.stubGlobal(
    "ResizeObserver",
    class {
      constructor(callback: () => void) {
        notify = callback;
      }
      observe = observe;
      disconnect = disconnect;
    },
  );
  return {
    element,
    observe,
    disconnect,
    resize: (next: number) => {
      current = next;
      act(() => notify());
    },
  };
}

afterEach(() => vi.unstubAllGlobals());

describe("useElementWidth", () => {
  test("measures before paint and follows the observer, up to the ceiling", () => {
    const box = setup(358);
    let renders = 0;
    const { result, unmount } = renderHook(() => {
      renders += 1;
      return useElementWidth({ current: box.element }, 600);
    });
    expect(result.current).toBe(358);
    expect(box.observe).toHaveBeenCalledWith(box.element);
    box.resize(420);
    expect(result.current).toBe(420);
    // Past the ceiling the stored width stops changing, so a wide resize is no re-render.
    box.resize(900);
    expect(result.current).toBe(600);
    const settled = renders;
    box.resize(1100);
    box.resize(1300);
    expect(renders).toBe(settled);
    unmount();
    expect(box.disconnect).toHaveBeenCalled();
  });

  test("a width of 0 (not laid out) is null, and an unmounted ref is null", () => {
    const box = setup(0);
    expect(renderHook(() => useElementWidth({ current: box.element }, 600)).result.current).toBeNull();
    box.resize(300);
    expect(renderHook(() => useElementWidth({ current: null }, 600)).result.current).toBeNull();
  });

  test("without a ResizeObserver the window's resize event follows the width", () => {
    const box = setup(300);
    vi.stubGlobal("ResizeObserver", undefined);
    const { result } = renderHook(() => useElementWidth({ current: box.element }, 600));
    expect(result.current).toBe(300);
    Object.defineProperty(box.element, "clientWidth", { configurable: true, get: () => 500 });
    act(() => window.dispatchEvent(new Event("resize")));
    expect(result.current).toBe(500);
  });
});
