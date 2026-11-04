import { afterEach, describe, expect, test, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { rememberMenuTrigger, takeMenuTrigger } from "../utils/menuOpener";
import { useDialogFocus } from "./useDialogFocus";

function scaffold() {
  document.body.innerHTML = `<main id="main-content" tabindex="-1"><button id="kebab">Operations</button><button id="other">Other</button></main><div role="menu" aria-labelledby="kebab"><button id="item" role="menuitem">Edit</button></div><section role="dialog"><button id="inside">Save</button></section>`;
  return {
    main: document.getElementById("main-content")!,
    kebab: document.getElementById("kebab")!,
    other: document.getElementById("other")!,
    item: document.getElementById("item")!,
    inside: document.getElementById("inside")!,
  };
}

function mount() {
  return renderHook(({ opened }: { opened: boolean }) => useDialogFocus(opened), { initialProps: { opened: false } });
}

/** What a page does: the click on the menu item (capture) remembers, the item's handler opens the dialog; the effect runs in that act. */
function openFromMenu(hook: ReturnType<typeof mount>, item: HTMLElement) {
  act(() => {
    rememberMenuTrigger(item);
    hook.rerender({ opened: true });
  });
}

describe("useDialogFocus", () => {
  afterEach(() => {
    document.body.innerHTML = "";
    takeMenuTrigger();
  });

  test("closing returns the focus to the kebab that opened the dialog", () => {
    const { kebab, item, inside } = scaffold();
    const hook = mount();
    openFromMenu(hook, item);
    inside.focus();
    act(() => hook.rerender({ opened: false }));
    expect(kebab).toHaveFocus();
  });

  test("the trigger is taken when the dialog opens: the memory is consumed", () => {
    const { item } = scaffold();
    const hook = mount();
    openFromMenu(hook, item);
    expect(takeMenuTrigger()).toBeNull();
  });

  test("a dialog opened from a plain button: the focus returns to that button", () => {
    const { other, kebab, inside } = scaffold();
    const hook = mount();
    other.focus();
    act(() => hook.rerender({ opened: true }));
    inside.focus();
    inside.remove();
    act(() => hook.rerender({ opened: false }));
    expect(kebab).not.toHaveFocus();
    expect(other).toHaveFocus();
  });

  test("the focus already inside the dialog when it opens (nothing recorded): the close leaves it to the browser", () => {
    const { other, inside } = scaffold();
    const hook = mount();
    other.focus();
    inside.focus();
    act(() => hook.rerender({ opened: true }));
    inside.remove();
    act(() => hook.rerender({ opened: false }));
    expect(other).not.toHaveFocus();
    expect(document.activeElement).toBe(document.body);
  });

  test("the memory expired before the dialog opened: nothing to return to", async () => {
    const { item, inside } = scaffold();
    const hook = mount();
    rememberMenuTrigger(item);
    await new Promise((resolve) => setTimeout(resolve, 5));
    act(() => hook.rerender({ opened: true }));
    inside.focus();
    act(() => hook.rerender({ opened: false }));
    expect(document.activeElement).not.toBe(document.getElementById("kebab"));
  });

  test("the kebab is already gone when the dialog closes: main takes a focus left on body", () => {
    const { main, kebab, item, inside } = scaffold();
    const hook = mount();
    openFromMenu(hook, item);
    inside.focus();
    kebab.remove();
    inside.remove();
    act(() => hook.rerender({ opened: false }));
    expect(main).toHaveFocus();
  });

  test("the kebab goes away after the close (the save's refetch): main takes the focus, once", () => {
    const { main, kebab, other, item, inside } = scaffold();
    const hook = mount();
    openFromMenu(hook, item);
    inside.focus();
    act(() => hook.rerender({ opened: false }));
    expect(kebab).toHaveFocus();
    kebab.remove();
    act(() => hook.rerender({ opened: false }));
    expect(main).toHaveFocus();
    // ... and it was forgotten: a later body focus is not taken again.
    other.focus();
    other.blur();
    act(() => hook.rerender({ opened: false }));
    expect(main).not.toHaveFocus();
  });

  test("a focus somewhere real is left alone when the kebab is gone", () => {
    const { main, kebab, other, item, inside } = scaffold();
    const hook = mount();
    openFromMenu(hook, item);
    inside.focus();
    act(() => hook.rerender({ opened: false }));
    other.focus();
    kebab.remove();
    act(() => hook.rerender({ opened: false }));
    expect(other).toHaveFocus();
    expect(main).not.toHaveFocus();
  });

  test("a save's refetch blurs the moved row: the kebab takes the focus back from body", () => {
    const { kebab, item, inside } = scaffold();
    const hook = mount();
    openFromMenu(hook, item);
    inside.focus();
    act(() => hook.rerender({ opened: false }));
    expect(kebab).toHaveFocus();
    kebab.blur(); // what a browser does when React moves the focused row in the DOM
    act(() => hook.rerender({ opened: false }));
    expect(kebab).toHaveFocus();
  });

  test("the watch ends a few seconds after the close: a later focus on body stays there", () => {
    const { kebab, item, inside } = scaffold();
    const hook = mount();
    openFromMenu(hook, item);
    inside.focus();
    act(() => hook.rerender({ opened: false }));
    expect(kebab).toHaveFocus();
    const later = Date.now() + 6_000;
    const now = vi.spyOn(Date, "now").mockReturnValue(later);
    try {
      kebab.blur();
      act(() => hook.rerender({ opened: false }));
      expect(document.activeElement).toBe(document.body);
    } finally {
      now.mockRestore();
    }
  });

  test("a focus the user put elsewhere ends the watch: the kebab does not take a later body focus", () => {
    const { kebab, other, item, inside } = scaffold();
    const hook = mount();
    openFromMenu(hook, item);
    inside.focus();
    act(() => hook.rerender({ opened: false }));
    other.focus();
    act(() => hook.rerender({ opened: false }));
    other.blur();
    act(() => hook.rerender({ opened: false }));
    expect(kebab).not.toHaveFocus();
  });

  test("a plain button clicked while a claimed fetch is pending: its dialog returns to the button, not the claimed kebab", () => {
    const { other, kebab, item, inside } = scaffold();
    const hook = mount();
    act(() => {
      rememberMenuTrigger(item);
      void hook.result.current.claim(new Promise(() => undefined));
    });
    other.focus();
    act(() => hook.rerender({ opened: true }));
    inside.focus();
    act(() => hook.rerender({ opened: false }));
    expect(other).toHaveFocus();
    expect(kebab).not.toHaveFocus();
  });

  test("a connected kebab is never re-focused after the first time", () => {
    const { kebab, other, item, inside } = scaffold();
    const hook = mount();
    openFromMenu(hook, item);
    inside.focus();
    act(() => hook.rerender({ opened: false }));
    expect(kebab).toHaveFocus();
    other.focus();
    act(() => hook.rerender({ opened: false }));
    act(() => hook.rerender({ opened: false }));
    expect(other).toHaveFocus();
  });

  test("a new opening replaces the memory", () => {
    const { kebab, other, item, inside } = scaffold();
    const hook = mount();
    openFromMenu(hook, item);
    act(() => hook.rerender({ opened: false }));
    expect(kebab).toHaveFocus();
    // The second dialog comes from a plain button: the old kebab is not its opener.
    other.focus();
    act(() => hook.rerender({ opened: true }));
    inside.focus();
    inside.remove();
    act(() => hook.rerender({ opened: false }));
    expect(kebab).not.toHaveFocus();
  });

  test("claim takes the trigger in the click for a dialog that opens after an await, and drops it when the await fails", async () => {
    const { kebab, item, inside } = scaffold();
    const hook = mount();
    let release!: () => void;
    const pending = new Promise<void>((resolve) => (release = resolve));
    act(() => {
      rememberMenuTrigger(item);
      void hook.result.current.claim(pending);
    });
    await new Promise((resolve) => setTimeout(resolve, 5));
    release();
    await pending;
    act(() => hook.rerender({ opened: true }));
    inside.focus();
    act(() => hook.rerender({ opened: false }));
    expect(kebab).toHaveFocus();

    kebab.blur();
    const failing = Promise.reject(new Error("boom"));
    act(() => {
      rememberMenuTrigger(item);
      void hook.result.current.claim(failing).catch(() => undefined);
    });
    await new Promise((resolve) => setTimeout(resolve, 5));
    act(() => hook.rerender({ opened: true }));
    inside.focus();
    inside.remove();
    act(() => hook.rerender({ opened: false }));
    expect(kebab).not.toHaveFocus();
  });
});
