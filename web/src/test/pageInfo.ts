import { screen, waitFor } from "@testing-library/react";
import type { UserEvent } from "@testing-library/user-event";

/** The info button's name: "About this page: {title}". */
const ABOUT_PAGE = /^About this page/;

/**
 * Opens the page header's "About this page" popover (the description lives behind it) and returns the dialog it opens, so a test
 * asserts the description's words and links INSIDE it. The button is the page's one, found by name.
 */
export async function openPageInfo(user: UserEvent): Promise<HTMLElement> {
  await user.click(await screen.findByRole("button", { name: ABOUT_PAGE }));
  const dialog = await screen.findByRole("dialog", { name: ABOUT_PAGE });
  await waitFor(() => expect(dialog).toBeVisible());
  return dialog;
}
