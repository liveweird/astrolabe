import { afterEach, describe, expect, test } from "vitest";
import userEvent from "@testing-library/user-event";
import { Menu } from "@mantine/core";
import DestructiveMenuItem from "./DestructiveMenuItem";
import RowActionsMenu from "./RowActionsMenu";
import { takeMenuTrigger } from "../utils/menuOpener";
import { renderWithProviders, screen, waitFor } from "../test/render";

describe("RowActionsMenu", () => {
  afterEach(() => {
    takeMenuTrigger();
  });

  test("the kebab trigger carries the full accessible name and the menu wiring the e2e helper reads", async () => {
    const user = userEvent.setup();
    renderWithProviders(
      <RowActionsMenu label="Operations for acquirer">
        <Menu.Item>Edit</Menu.Item>
        <DestructiveMenuItem>Delete</DestructiveMenuItem>
      </RowActionsMenu>,
    );
    const trigger = screen.getByRole("button", { name: "Operations for acquirer" });
    expect(trigger).toHaveAttribute("aria-expanded", "false");
    await user.click(trigger);
    expect(trigger).toHaveAttribute("aria-expanded", "true");
    expect(trigger).toHaveAttribute("aria-controls");
    expect(await screen.findByRole("menuitem", { name: "Edit" })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: "Delete" })).toBeInTheDocument();
  });

  test("opening puts the focus on the first item, the menu holds only items (no focus placeholder) and the arrow keys move from there", async () => {
    const user = userEvent.setup();
    renderWithProviders(
      <RowActionsMenu label="Operations for acquirer">
        <Menu.Item>Edit</Menu.Item>
        <Menu.Divider />
        <DestructiveMenuItem>Delete</DestructiveMenuItem>
      </RowActionsMenu>,
    );
    await user.click(screen.getByRole("button", { name: "Operations for acquirer" }));
    const menu = await screen.findByRole("menu");
    // axe aria-required-children: Mantine's invisible `role="presentation" tabindex="-1"` placeholder would be a child of the menu that is no item.
    expect(menu.querySelector('[role="presentation"], [data-autofocus]')).toBeNull();
    await waitFor(() => expect(screen.getByRole("menuitem", { name: "Edit" })).toHaveFocus());
    await user.keyboard("{ArrowDown}");
    expect(screen.getByRole("menuitem", { name: "Delete" })).toHaveFocus();
    await user.keyboard("{ArrowUp}");
    expect(screen.getByRole("menuitem", { name: "Edit" })).toHaveFocus();
  });

  test("a menu whose first item is disabled still takes the focus, on the first enabled item (Mantine's trap would leave it on the kebab)", async () => {
    const user = userEvent.setup();
    renderWithProviders(
      <RowActionsMenu label="Operations for acquirer">
        <Menu.Item disabled>Move up</Menu.Item>
        <Menu.Item>Move down</Menu.Item>
        <Menu.Item>Unrank</Menu.Item>
      </RowActionsMenu>,
    );
    await user.click(screen.getByRole("button", { name: "Operations for acquirer" }));
    await waitFor(() => expect(screen.getByRole("menuitem", { name: "Move down" })).toHaveFocus());
    await user.keyboard("{ArrowDown}");
    expect(screen.getByRole("menuitem", { name: "Unrank" })).toHaveFocus();
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
  });

  test("Escape returns the focus to the kebab that opened the menu and leaves it there once the menu is gone", async () => {
    const user = userEvent.setup();
    renderWithProviders(
      <RowActionsMenu label="Operations for acquirer">
        <Menu.Item disabled>Move up</Menu.Item>
        <Menu.Item>Move down</Menu.Item>
      </RowActionsMenu>,
    );
    const kebab = screen.getByRole("button", { name: "Operations for acquirer" });
    kebab.focus();
    await user.keyboard("{Enter}");
    await waitFor(() => expect(screen.getByRole("menuitem", { name: "Move down" })).toHaveFocus());
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
    // The dropdown's focus-placing ref must not pull the focus back into the closing menu (the e2e sweep proves the real exit transition).
    expect(kebab).toHaveFocus();
  });

  test("a destructive item takes the theme's ink class and no inline colour (Mantine's color=red would be 3.3:1)", async () => {
    const user = userEvent.setup();
    renderWithProviders(
      <RowActionsMenu label="Operations for acquirer">
        <DestructiveMenuItem className="extra">Delete</DestructiveMenuItem>
      </RowActionsMenu>,
    );
    await user.click(screen.getByRole("button", { name: "Operations for acquirer" }));
    const item = await screen.findByRole("menuitem", { name: "Delete" });
    expect(item.className).toMatch(/menuItemDestructive/);
    expect(item).toHaveClass("extra");
    expect(item.getAttribute("style") ?? "").not.toContain("--menu-item-color");
  });

  test("a loading trigger is disabled", () => {
    renderWithProviders(
      <RowActionsMenu label="Operations for x" loading>
        <Menu.Item>Edit</Menu.Item>
      </RowActionsMenu>,
    );
    expect(screen.getByRole("button", { name: "Operations for x" })).toHaveAttribute("data-loading");
  });

  test("an item's click remembers the kebab for the dialog it opens (by mouse, and by Enter on the item); a click elsewhere does not", async () => {
    const user = userEvent.setup();
    const taken: Array<HTMLElement | null> = [];
    renderWithProviders(
      <>
        <button>Elsewhere</button>
        <RowActionsMenu label="Operations for acquirer">
          <Menu.Item onClick={() => taken.push(takeMenuTrigger())}>Edit</Menu.Item>
        </RowActionsMenu>
      </>,
    );
    const kebab = screen.getByRole("button", { name: "Operations for acquirer" });
    await user.click(kebab);
    await user.click(await screen.findByRole("menuitem", { name: "Edit" }));
    expect(taken).toEqual([kebab]);

    await user.click(kebab);
    await waitFor(() => expect(screen.getByRole("menuitem", { name: "Edit" })).toHaveFocus());
    await user.keyboard("{Enter}");
    expect(taken).toEqual([kebab, kebab]);

    await user.click(screen.getByRole("button", { name: "Elsewhere" }));
    expect(takeMenuTrigger()).toBeNull();
  });

  test("an item that takes nothing leaves no stale trigger for a later dialog", async () => {
    const user = userEvent.setup();
    renderWithProviders(
      <RowActionsMenu label="Operations for acquirer">
        <Menu.Item>Move up</Menu.Item>
      </RowActionsMenu>,
    );
    await user.click(screen.getByRole("button", { name: "Operations for acquirer" }));
    await user.click(await screen.findByRole("menuitem", { name: "Move up" }));
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(takeMenuTrigger()).toBeNull();
  });
  describe("Tab leaves an open menu", () => {
    const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

    function renderBetweenButtons() {
      return renderWithProviders(
        <>
          <button>Before</button>
          <RowActionsMenu label="Operations for acquirer">
            <Menu.Item>Edit</Menu.Item>
            <DestructiveMenuItem>Delete</DestructiveMenuItem>
          </RowActionsMenu>
          <button>After</button>
        </>,
      );
    }

    /** What a `document` keydown listener (Mantine's focus trap is one) sees of the keys pressed. */
    function watchDocumentKeys() {
      const seen: Array<{ key: string; defaultPrevented: boolean }> = [];
      const listener = (event: KeyboardEvent) => seen.push({ key: event.key, defaultPrevented: event.defaultPrevented });
      document.addEventListener("keydown", listener);
      return { seen, stop: () => document.removeEventListener("keydown", listener) };
    }

    async function openWithKeyboard(user: ReturnType<typeof userEvent.setup>) {
      const kebab = screen.getByRole("button", { name: "Operations for acquirer" });
      kebab.focus();
      await user.keyboard("{Enter}");
      await waitFor(() => expect(screen.getByRole("menuitem", { name: "Edit" })).toHaveFocus());
      return kebab;
    }

    test("Tab closes the menu and the focus moves on from the kebab: the event never reaches the document, so nothing prevents its default", async () => {
      const user = userEvent.setup();
      renderBetweenButtons();
      const kebab = await openWithKeyboard(user);
      const document_ = watchDocumentKeys();
      try {
        await user.keyboard("{Tab}");
      } finally {
        document_.stop();
      }
      expect(document_.seen.filter((key) => key.key === "Tab")).toEqual([]);
      await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
      expect(kebab).toHaveAttribute("aria-expanded", "false");
      // user-event's own Tab default runs from the focused kebab: the next stop is "After". Past Mantine's focus return (10 ms) it stays there.
      expect(screen.getByRole("button", { name: "After" })).toHaveFocus();
      await pause(40);
      expect(screen.getByRole("button", { name: "After" })).toHaveFocus();
    });

    test("Shift+Tab closes the menu likewise and the focus moves back from the kebab", async () => {
      const user = userEvent.setup();
      renderBetweenButtons();
      await openWithKeyboard(user);
      const document_ = watchDocumentKeys();
      try {
        await user.keyboard("{Shift>}{Tab}{/Shift}");
      } finally {
        document_.stop();
      }
      expect(document_.seen.filter((key) => key.key === "Tab")).toEqual([]);
      await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
      expect(screen.getByRole("button", { name: "Before" })).toHaveFocus();
      await pause(40);
      expect(screen.getByRole("button", { name: "Before" })).toHaveFocus();
    });

    test("other keys do nothing to the menu: ArrowDown moves, a letter does not close it", async () => {
      const user = userEvent.setup();
      renderBetweenButtons();
      await openWithKeyboard(user);
      await user.keyboard("{ArrowDown}");
      expect(screen.getByRole("menuitem", { name: "Delete" })).toHaveFocus();
      // The watcher does see a key the hook leaves alone, so its silence for Tab above is the hook's doing.
      const document_ = watchDocumentKeys();
      try {
        await user.keyboard("x");
      } finally {
        document_.stop();
      }
      expect(document_.seen.map((key) => key.key)).toEqual(["x"]);
      expect(screen.getByRole("menu")).toBeInTheDocument();
    });

    test("a Tab with Ctrl (the browser's own tab switch) is left alone", async () => {
      const user = userEvent.setup();
      renderBetweenButtons();
      await openWithKeyboard(user);
      await user.keyboard("{Control>}{Tab}{/Control}");
      expect(screen.getByRole("menu")).toBeInTheDocument();
    });

    test("the menu opens again after a Tab exit, with the focus on its first item", async () => {
      const user = userEvent.setup();
      renderBetweenButtons();
      const kebab = await openWithKeyboard(user);
      await user.keyboard("{Tab}");
      await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
      kebab.focus();
      await user.keyboard("{Enter}");
      await waitFor(() => expect(screen.getByRole("menuitem", { name: "Edit" })).toHaveFocus());
    });
  });
});
