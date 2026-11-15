import { renderHook } from "@testing-library/react";
import { afterEach, describe, expect, test } from "vitest";
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
});
