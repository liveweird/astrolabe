import { renderHook } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { TimelineHandle } from "../components/Timeline";
import { useRowMenuFocus } from "./useRowMenuFocus";

function menuButton(id: number): HTMLButtonElement {
  const button = document.createElement("button");
  button.dataset.operationsFor = String(id);
  document.body.append(button);
  return button;
}

describe("useRowMenuFocus", () => {
  afterEach(() => {
    document.body.replaceChildren();
  });

  test("a keep from another row's menu refocuses the target when THAT menu closes, and nothing stays armed", () => {
    const neighbour = menuButton(2);
    const other = menuButton(3);
    const { result } = renderHook(() => useRowMenuFocus({ current: null }));
    result.current.keep(2, true, 1);
    other.focus();
    result.current.menuClosed(2);
    expect(document.activeElement).toBe(other);
    result.current.menuClosed(1);
    expect(document.activeElement).toBe(neighbour);
    other.focus();
    result.current.menuClosed(2);
    result.current.menuClosed(1);
    expect(document.activeElement).toBe(other);
  });

  test("a plain keep refocuses its own row when its own menu closes, once", () => {
    const own = menuButton(5);
    const other = menuButton(6);
    const { result } = renderHook(() => useRowMenuFocus({ current: null }));
    result.current.keep(5);
    other.focus();
    result.current.menuClosed(5);
    expect(document.activeElement).toBe(own);
    other.focus();
    result.current.menuClosed(5);
    expect(document.activeElement).toBe(other);
  });

  test("a change not taken arms nothing", () => {
    menuButton(7);
    const other = menuButton(8);
    const { result } = renderHook(() => useRowMenuFocus({ current: null }));
    result.current.keep(7, false);
    other.focus();
    result.current.menuClosed(7);
    expect(document.activeElement).toBe(other);
  });

  test("an armed second put is dropped once the used row has left the DOM: a row of the same id coming back is not a close it waited for", () => {
    const used = menuButton(1);
    const neighbour = menuButton(2);
    const other = menuButton(3);
    const { result, rerender } = renderHook(() => useRowMenuFocus({ current: null }));
    result.current.keep(2, true, 1);
    used.remove(); // Rank under "Unranked projects only": the row, its menu and the menu's close are gone
    rerender();
    expect(document.activeElement).toBe(neighbour);
    // The filter is turned off: the row is back with a menu of its own, which is used and closed. Nothing waits for that close.
    menuButton(1);
    other.focus();
    result.current.menuClosed(1);
    expect(document.activeElement).toBe(other);
  });

  test("a used row that is still in the DOM keeps its second put armed", () => {
    menuButton(1);
    const neighbour = menuButton(2);
    const other = menuButton(3);
    const { result, rerender } = renderHook(() => useRowMenuFocus({ current: null }));
    result.current.keep(2, true, 1);
    rerender();
    other.focus();
    result.current.menuClosed(1);
    expect(document.activeElement).toBe(neighbour);
  });

  describe("where the focus goes", () => {
    const timelineOf = (found: boolean) => {
      const focusRow = vi.fn((_id: number | string) => found);
      return { handle: { current: { focusRow } satisfies TimelineHandle }, focusRow };
    };
    const fallbackButton = () => {
      const button = document.createElement("button");
      document.body.append(button);
      return button;
    };

    test("the row's menu button wins over the timeline and the fallback", () => {
      const button = menuButton(1);
      const { handle, focusRow } = timelineOf(true);
      const fallback = fallbackButton();
      const { result, rerender } = renderHook(() => useRowMenuFocus(handle, { current: fallback }));
      result.current.restore(1);
      rerender();
      expect(document.activeElement).toBe(button);
      expect(focusRow).not.toHaveBeenCalled();
    });

    test("an unmounted row is asked of the timeline, and the fallback is left alone when the timeline holds it", () => {
      const { handle, focusRow } = timelineOf(true);
      const fallback = fallbackButton();
      const { result, rerender } = renderHook(() => useRowMenuFocus(handle, { current: fallback }));
      result.current.restore(4);
      rerender();
      expect(focusRow).toHaveBeenCalledWith(4);
      expect(document.activeElement).not.toBe(fallback);
    });

    test("a row the timeline does not hold goes to the fallback", () => {
      const { handle, focusRow } = timelineOf(false);
      const fallback = fallbackButton();
      const { result, rerender } = renderHook(() => useRowMenuFocus(handle, { current: fallback }));
      result.current.restore(4);
      rerender();
      expect(focusRow).toHaveBeenCalledWith(4);
      expect(document.activeElement).toBe(fallback);
    });

    test("no timeline at all goes to the fallback", () => {
      const fallback = fallbackButton();
      const { result, rerender } = renderHook(() => useRowMenuFocus({ current: null }, { current: fallback }));
      result.current.restore(4);
      rerender();
      expect(document.activeElement).toBe(fallback);
    });

    test("without a fallback nothing is focused (today's behaviour)", () => {
      const { handle } = timelineOf(false);
      const { result, rerender } = renderHook(() => useRowMenuFocus(handle));
      result.current.restore(4);
      rerender();
      expect(document.activeElement).toBe(document.body);
    });
  });

  describe("returnToOrigin", () => {
    test("from the neighbour the hook focused, the focus goes back to the row the change came from, once", () => {
      const origin = menuButton(1);
      const neighbour = menuButton(2);
      const { result, rerender } = renderHook(() => useRowMenuFocus({ current: null }));
      result.current.keep(2, true, 1);
      result.current.watchRollback(1);
      rerender();
      expect(document.activeElement).toBe(neighbour);
      result.current.returnToOrigin();
      expect(document.activeElement).toBe(origin);
      neighbour.focus();
      result.current.returnToOrigin();
      expect(document.activeElement).toBe(neighbour);
    });

    test("from body (the browser blurred a row that moved) it goes back to the row", () => {
      const origin = menuButton(1);
      const { result, rerender } = renderHook(() => useRowMenuFocus({ current: null }));
      result.current.keep(1);
      result.current.watchRollback(1);
      rerender();
      (document.activeElement as HTMLElement).blur();
      expect(document.activeElement).toBe(document.body);
      result.current.returnToOrigin();
      expect(document.activeElement).toBe(origin);
    });

    test("from the fallback the hook focused, it goes back to the row that has come back", () => {
      const fallback = document.createElement("button");
      document.body.append(fallback);
      const used = menuButton(1);
      const { result, rerender } = renderHook(() => useRowMenuFocus({ current: null }, { current: fallback }));
      result.current.keep(1, true, 1);
      result.current.watchRollback(1);
      used.remove();
      rerender();
      expect(document.activeElement).toBe(fallback);
      const back = menuButton(1);
      result.current.returnToOrigin();
      expect(document.activeElement).toBe(back);
    });

    test("a focus the user has moved meanwhile is left alone", () => {
      menuButton(1);
      menuButton(2);
      const elsewhere = document.createElement("input");
      document.body.append(elsewhere);
      const { result, rerender } = renderHook(() => useRowMenuFocus({ current: null }));
      result.current.keep(2, true, 1);
      result.current.watchRollback(1);
      rerender();
      elsewhere.focus();
      result.current.returnToOrigin();
      expect(document.activeElement).toBe(elsewhere);
    });

    test("a kept change nobody watched (no write went out) has no origin", () => {
      menuButton(1);
      const neighbour = menuButton(2);
      const { result, rerender } = renderHook(() => useRowMenuFocus({ current: null }));
      result.current.keep(2, true, 1);
      rerender();
      expect(document.activeElement).toBe(neighbour);
      neighbour.blur();
      result.current.returnToOrigin();
      expect(document.activeElement).toBe(document.body);
    });

    test("a write that settled without a rollback is forgotten: a later failure returns nowhere", () => {
      menuButton(1);
      menuButton(2);
      const { result, rerender } = renderHook(() => useRowMenuFocus({ current: null }));
      result.current.keep(2, true, 1);
      result.current.watchRollback(1);
      rerender();
      result.current.forgetOrigin();
      (document.activeElement as HTMLElement).blur();
      result.current.returnToOrigin();
      expect(document.activeElement).toBe(document.body);
    });
  });
});
