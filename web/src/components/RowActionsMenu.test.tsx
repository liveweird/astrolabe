import { describe, expect, test } from "vitest";
import userEvent from "@testing-library/user-event";
import { Menu } from "@mantine/core";
import DestructiveMenuItem from "./DestructiveMenuItem";
import RowActionsMenu from "./RowActionsMenu";
import { renderWithProviders, screen, waitFor } from "../test/render";

describe("RowActionsMenu", () => {
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
});
