import { afterEach, describe, expect, test, vi } from "vitest";
import type { ReactNode } from "react";
import { act, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { rememberMenuTrigger, takeMenuTrigger } from "../utils/menuOpener";
import { useDeleteConfirm } from "./useDeleteConfirm";

vi.mock("../utils/toast", () => ({ showSuccessToast: vi.fn() }));

type Row = { id: number };

function mount(target: "heading" | null, mutationFn: () => Promise<unknown>) {
  const client = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  return renderHook(
    () =>
      useDeleteConfirm<Row>({
        mutationFn,
        onSuccess: vi.fn(),
        // Resolved at call time: the heading is a plain element outside React, so the ref reads it on use.
        focusAfterDelete: target === null ? null : { get current() { return document.getElementById("heading"); } },
      }),
    { wrapper },
  ).result;
}

/** A heading that can take the focus, and a dialog with a button in it, both outside React. */
function scaffold() {
  document.body.innerHTML = `<h2 id="heading" tabindex="-1">Title</h2><section role="dialog"><button id="inside">Delete</button></section><button id="elsewhere">Other</button><button id="kebab">Operations</button><div role="menu" aria-labelledby="kebab"><button id="item" role="menuitem">Delete</button></div>`;
  return {
    heading: document.getElementById("heading")!,
    inside: document.getElementById("inside")!,
    elsewhere: document.getElementById("elsewhere")!,
    kebab: document.getElementById("kebab")!,
    item: document.getElementById("item")!,
  };
}

type Hook = ReturnType<typeof mount>;

async function succeed(hook: Hook) {
  act(() => hook.current.requestDelete({ id: 1 }));
  act(() => hook.current.confirmDelete());
  await waitFor(() => expect(hook.current.opened).toBe(false));
}

describe("useDeleteConfirm focus after a successful delete", () => {
  afterEach(() => {
    document.body.innerHTML = "";
    takeMenuTrigger();
    vi.clearAllMocks();
  });

  test("the focus is on body: the heading takes it", async () => {
    const { heading } = scaffold();
    const hook = mount("heading", () => Promise.resolve());
    await succeed(hook);
    await waitFor(() => expect(heading).toHaveFocus());
  });

  test("the heading takes the focus without scrolling: a delete far down a long list keeps the viewer's place", async () => {
    const { heading } = scaffold();
    const focus = vi.spyOn(heading, "focus");
    const hook = mount("heading", () => Promise.resolve());
    await succeed(hook);
    await waitFor(() => expect(focus).toHaveBeenCalledWith({ preventScroll: true }));
  });

  test("the focus is still inside the dialog (the modal is fading): wait, then take it when the modal has exited", async () => {
    const { heading, inside } = scaffold();
    const hook = mount("heading", () => Promise.resolve());
    inside.focus();
    await succeed(hook);
    expect(heading).not.toHaveFocus();
    expect(inside).toHaveFocus();
    // The dialog leaves the DOM and the focus falls to body; Mantine then reports the end of the exit transition.
    inside.remove();
    act(() => hook.current.onExited());
    await waitFor(() => expect(heading).toHaveFocus());
  });

  test("the focus is somewhere real (the user, or Mantine's return focus, put it there): it stays", async () => {
    const { heading, elsewhere } = scaffold();
    const hook = mount("heading", () => Promise.resolve());
    elsewhere.focus();
    await succeed(hook);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(heading).not.toHaveFocus();
    expect(elsewhere).toHaveFocus();
    // ... and the request was dropped, not parked: a later body focus is not stolen.
    elsewhere.blur();
    act(() => hook.current.onExited());
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(heading).not.toHaveFocus();
  });

  test("a null target (the page navigates away) never moves the focus", async () => {
    const { heading } = scaffold();
    const hook = mount(null, () => Promise.resolve());
    await succeed(hook);
    act(() => hook.current.onExited());
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(heading).not.toHaveFocus();
  });

  test("a failed delete never arms the focus move", async () => {
    const { heading } = scaffold();
    const hook = mount("heading", () => Promise.reject(new Error("boom")));
    act(() => hook.current.requestDelete({ id: 1 }));
    act(() => hook.current.confirmDelete());
    await waitFor(() => expect(hook.current.mutation.isError).toBe(true));
    act(() => hook.current.onExited());
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(heading).not.toHaveFocus();
    expect(hook.current.opened).toBe(true);
  });

  describe("after a cancel", () => {
    /** Opens the delete from the menu item (RowActionsMenu remembers the trigger in the click), then the menu is gone and the focus is in the dialog; Escape cancels. */
    function cancelFromMenu(hook: Hook, els: ReturnType<typeof scaffold>) {
      els.item.focus();
      rememberMenuTrigger(els.item);
      act(() => hook.current.requestDelete({ id: 1 }));
      els.item.closest('[role="menu"]')!.remove();
      els.inside.focus();
      act(() => hook.current.cancelDelete());
    }

    test("the focus falls to body: the kebab that opened the menu takes it", async () => {
      const els = scaffold();
      const hook = mount("heading", () => Promise.resolve());
      cancelFromMenu(hook, els);
      expect(els.kebab).not.toHaveFocus();
      els.inside.remove();
      act(() => hook.current.onExited());
      await waitFor(() => expect(els.kebab).toHaveFocus());
      expect(els.heading).not.toHaveFocus();
    });

    test("the kebab is gone (its row left): the heading takes it", async () => {
      const els = scaffold();
      const hook = mount("heading", () => Promise.resolve());
      cancelFromMenu(hook, els);
      els.kebab.remove();
      els.inside.remove();
      act(() => hook.current.onExited());
      await waitFor(() => expect(els.heading).toHaveFocus());
    });

    test("a null target (the page navigates on success) still returns to the kebab, and to nowhere without one", async () => {
      const els = scaffold();
      const hook = mount(null, () => Promise.resolve());
      cancelFromMenu(hook, els);
      els.inside.remove();
      act(() => hook.current.onExited());
      await waitFor(() => expect(els.kebab).toHaveFocus());

      const second = scaffold();
      const again = mount(null, () => Promise.resolve());
      cancelFromMenu(again, second);
      second.kebab.remove();
      second.inside.remove();
      act(() => again.current.onExited());
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(document.activeElement).toBe(document.body);
    });

    test("the focus is somewhere real (a click elsewhere, or Mantine's own return): it stays", async () => {
      const els = scaffold();
      const hook = mount("heading", () => Promise.resolve());
      cancelFromMenu(hook, els);
      els.elsewhere.focus();
      els.inside.remove();
      act(() => hook.current.onExited());
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(els.elsewhere).toHaveFocus();
      expect(els.kebab).not.toHaveFocus();
      expect(els.heading).not.toHaveFocus();
    });

    test("opened by something that is not a menu item: no kebab is guessed, a focus left on body goes to the heading", async () => {
      const els = scaffold();
      const hook = mount("heading", () => Promise.resolve());
      els.elsewhere.focus();
      act(() => hook.current.requestDelete({ id: 1 }));
      els.inside.focus();
      act(() => hook.current.cancelDelete());
      els.inside.remove();
      els.elsewhere.remove();
      act(() => hook.current.onExited());
      await waitFor(() => expect(els.heading).toHaveFocus());
    });

    test("a later success after a cancel goes to the heading, not the old kebab", async () => {
      const els = scaffold();
      const hook = mount("heading", () => Promise.resolve());
      cancelFromMenu(hook, els);
      els.inside.remove();
      act(() => hook.current.onExited());
      await waitFor(() => expect(els.kebab).toHaveFocus());
      els.kebab.blur();
      await succeed(hook);
      await waitFor(() => expect(els.heading).toHaveFocus());
    });
  });
});
