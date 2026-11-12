import { useEffect, useState } from "react";
import { afterEach, describe, expect, test } from "vitest";
import userEvent from "@testing-library/user-event";
import { Button, Menu, Modal } from "@mantine/core";
import RowActionsMenu from "../components/RowActionsMenu";
import { takeMenuTrigger } from "../utils/menuOpener";
import { act, renderWithProviders, screen, waitFor } from "../test/render";
import { useDialogFocus } from "./useDialogFocus";

const ROWS = ["Alpha", "Beta"];
/** Re-renders the harness without touching the focus (a query refetch lands; a click on a "Refetch" button would move the focus itself). */
let refetch = () => undefined as void;

/** What an editor page does (People): a row menu whose Edit item sets the editor, `{editor && <Modal opened />}`, `useDialogFocus(editor !== null)`. */
function Harness() {
  const [editor, setEditor] = useState<string | null>(null);
  const [renders, setRenders] = useState(0);
  const [gone, setGone] = useState<string[]>([]);
  useDialogFocus(editor !== null);
  useEffect(() => {
    refetch = () => setRenders((n) => n + 1);
  }, []);
  return (
    <div>
      <span data-testid="renders">{renders}</span>
      {ROWS.filter((row) => !gone.includes(row)).map((row) => (
        <RowActionsMenu key={row} label={`Operations for ${row}`}>
          <Menu.Item onClick={() => setEditor(row)}>{`Edit ${row}`}</Menu.Item>
          <Menu.Item onClick={() => setRenders((n) => n + 1)}>{`Archive ${row}`}</Menu.Item>
          <Menu.Item onClick={() => setGone((rows) => [...rows, row])}>{`Remove ${row}`}</Menu.Item>
        </RowActionsMenu>
      ))}
      {editor !== null && (
        <Modal opened onClose={() => setEditor(null)} title={`Editing ${editor}`}>
          <Button data-autofocus onClick={() => setEditor(null)}>
            Cancel
          </Button>
        </Modal>
      )}
    </div>
  );
}

async function editAndClose(user: ReturnType<typeof userEvent.setup>, row: string, how: "click" | "escape") {
  await user.click(screen.getByRole("button", { name: `Operations for ${row}` }));
  await user.click(await screen.findByRole("menuitem", { name: `Edit ${row}` }));
  const dialog = await screen.findByRole("dialog");
  if (how === "click") await user.click(screen.getByRole("button", { name: "Cancel" }));
  else await user.keyboard("{Escape}");
  await waitFor(() => expect(dialog).not.toBeInTheDocument());
}

describe("the focus around a closing editor dialog opened from a row menu", () => {
  afterEach(() => {
    takeMenuTrigger();
  });

  // 1.13.1 review, path A: `menuOpener.ts` expires its memory in a `setTimeout(0)`, `useDialogFocus` takes it in a passive effect. A discrete
  // click commits and flushes that effect synchronously, before any timer; these runs (100 in a row when this was settled) pin the order.
  test.each(["click", "escape"] as const)("the dialog closed by %s returns the focus to the kebab that opened it", async (how) => {
    const user = userEvent.setup();
    renderWithProviders(<Harness />);
    await editAndClose(user, "Alpha", how);
    await waitFor(() => expect(screen.getByRole("button", { name: "Operations for Alpha" })).toHaveFocus());
    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(screen.getByRole("button", { name: "Operations for Alpha" })).toHaveFocus();
  });

  test("opened with the keyboard (Enter on the item), closed with Escape: the kebab again", async () => {
    const user = userEvent.setup();
    renderWithProviders(<Harness />);
    const kebab = screen.getByRole("button", { name: "Operations for Beta" });
    kebab.focus();
    await user.keyboard("{Enter}");
    (await screen.findByRole("menuitem", { name: "Edit Beta" })).focus();
    await user.keyboard("{Enter}");
    const dialog = await screen.findByRole("dialog");
    await user.keyboard("{Escape}");
    await waitFor(() => expect(dialog).not.toBeInTheDocument());
    await waitFor(() => expect(kebab).toHaveFocus());
  });

  // Path B: inside the 5 s watch, a second row's menu action must not be answered with the first kebab.
  test("a second row's menu action right after the close does not pull the focus back to the first kebab", async () => {
    const user = userEvent.setup();
    renderWithProviders(<Harness />);
    await editAndClose(user, "Alpha", "click");
    const first = screen.getByRole("button", { name: "Operations for Alpha" });
    await waitFor(() => expect(first).toHaveFocus());

    await user.click(screen.getByRole("button", { name: "Operations for Beta" }));
    await user.click(await screen.findByRole("menuitem", { name: "Archive Beta" }));
    await waitFor(() => expect(screen.queryByRole("menu")).not.toBeInTheDocument());
    // The action's dropdown has gone and, as in a browser, the focus it held fell to body; the next render (the refetch) must not answer with Alpha.
    if (document.activeElement !== document.body) (document.activeElement as HTMLElement).blur();
    act(() => refetch());
    (document.activeElement as HTMLElement | null)?.blur();
    act(() => refetch());
    expect(first).not.toHaveFocus();
  });

  // The action that really drops the focus to body: its row leaves the list (a delete elsewhere, a move that re-sorts), kebab and menu with it.
  test("a second row's action that removes that row does not hand the focus to the first kebab", async () => {
    const user = userEvent.setup();
    renderWithProviders(<Harness />);
    await editAndClose(user, "Alpha", "click");
    const first = screen.getByRole("button", { name: "Operations for Alpha" });
    await waitFor(() => expect(first).toHaveFocus());

    await user.click(screen.getByRole("button", { name: "Operations for Beta" }));
    await user.click(await screen.findByRole("menuitem", { name: "Remove Beta" }));
    await waitFor(() => expect(screen.queryByRole("menu")).not.toBeInTheDocument());
    expect(screen.queryByRole("button", { name: "Operations for Beta" })).not.toBeInTheDocument();
    act(() => refetch());
    (document.activeElement as HTMLElement | null)?.blur();
    act(() => refetch());
    expect(first).not.toHaveFocus();
  });
});
