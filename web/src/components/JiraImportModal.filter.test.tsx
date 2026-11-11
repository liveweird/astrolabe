import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import userEvent from "@testing-library/user-event";
import { QueryClient } from "@tanstack/react-query";
import { screen, within } from "@testing-library/react";
import JiraImportModal from "./JiraImportModal";
import { jsonResponse } from "../test/http";
import { ONE_CONNECTION_SOURCE } from "../test/jira";
import { fillScope, installImportApi, previewScope } from "../test/jiraImportHarness";
import { PREVIEW_ITEMS, previewOf } from "../test/jiraImport";
import { renderWithProviders } from "../test/render";

// The import filter (1.13.2): the two controls of the scope step, the request they build for BOTH calls, and what the preview says about it.

let api: ReturnType<typeof installImportApi>;
let previewResponse: () => Response;

beforeEach(() => {
  previewResponse = () => jsonResponse(200, previewOf(PREVIEW_ITEMS));
  api = installImportApi({
    preview: () => previewResponse(),
    apply: () => jsonResponse(200, { revision: 13, created: [], bound: [], skipped: [] }),
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  localStorage.clear();
});

type User = ReturnType<typeof userEvent.setup>;

const open = () =>
  renderWithProviders(<JiraImportModal source={ONE_CONNECTION_SOURCE} onClose={vi.fn()} />, { queryClient: new QueryClient({ defaultOptions: { queries: { retry: false } } }) });
const doneSwitch = () => screen.getByRole("switch", { name: /^Leave out done items/ });
const daysField = () => screen.getByRole("textbox", { name: "Updated within (days)" });
const previewButton = () => screen.getByRole("button", { name: "Preview" });
const INVALID = "Enter a whole number of days from 1 to 3,650, or leave it empty.";

/** Opens the dialog, lets the test set the filter controls, then previews. */
async function previewUnder(setup: (user: User) => Promise<void> = async () => {}) {
  const user = userEvent.setup();
  open();
  await setup(user);
  await previewScope(user);
}

describe("JiraImportModal: the import filter controls", () => {
  test("open with done items left out and 365 days, and say which parents are read as well", () => {
    open();
    expect(doneSwitch()).toBeChecked();
    expect(daysField()).toHaveValue("365");
    expect(screen.getByText("Items whose Jira status is in the Done category are left out, unless an item that is read sits under them.")).toBeInTheDocument();
    expect(screen.getByText("A done or older parent of an item that is read is read as well, when it is in the selected Jira projects.")).toBeInTheDocument();
    expect(screen.queryByText(INVALID)).not.toBeInTheDocument();
  });

  test("a changed number goes into the preview, and the apply sends the SAME filter", async () => {
    await previewUnder(async (user) => {
      await user.clear(daysField());
      await user.type(daysField(), "30");
    });
    const filter = { excludeDone: true, updatedWithinDays: 30 };
    expect(api.previews()).toEqual([{ workStreamId: 3, ownerPersonId: 8, copyDates: true, filter }]);
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: /^Import \(\d+\)$/ }));
    await screen.findByRole("heading", { level: 3, name: "Import finished" });
    expect(api.applies()).toEqual([expect.objectContaining({ filter })]);
  });

  test("the apply and Preview again carry the filter of the LATEST preview, not the one the form held before or holds now", async () => {
    const user = userEvent.setup();
    // The apply reports a CHANGED row, which is what offers "Preview again" on the outcome.
    api = installImportApi({
      preview: () => previewResponse(),
      apply: () => jsonResponse(200, { revision: 13, created: [], bound: [], skipped: [{ jiraId: "7", issueKey: "IMP-26", reason: "CHANGED" }] }),
    });
    open();
    await previewScope(user);
    await user.click(screen.getByRole("button", { name: "Back" }));
    await user.click(doneSwitch());
    await user.clear(daysField());
    await user.type(daysField(), "30");
    await user.click(previewButton());
    await screen.findByRole("heading", { level: 3, name: "What the import would do" });
    const filter = { excludeDone: false, updatedWithinDays: 30 };
    expect(api.previews()[1]).toEqual(expect.objectContaining({ filter }));
    await user.click(screen.getByRole("button", { name: /^Import \(\d+\)$/ }));
    await screen.findByRole("heading", { level: 3, name: "Import finished" });
    expect(api.applies()).toEqual([expect.objectContaining({ filter })]);
    await user.click(screen.getByRole("button", { name: "Preview again" }));
    await screen.findByRole("heading", { level: 3, name: "What the import would do" });
    expect(api.previews()).toHaveLength(3);
    expect(api.previews()[2]).toEqual(api.previews()[1]);
  });

  test("going Back and editing the filter without previewing again sends nothing", async () => {
    const user = userEvent.setup();
    open();
    await previewScope(user);
    await user.click(screen.getByRole("button", { name: "Back" }));
    await user.click(doneSwitch());
    await user.clear(daysField());
    await user.type(daysField(), "30");
    expect(api.previews()).toHaveLength(1);
    expect(api.applies()).toEqual([]);
    expect(api.previews()[0]).toEqual(expect.objectContaining({ filter: { excludeDone: true, updatedWithinDays: 365 } }));
  });

  test("an empty days field sends no updatedWithinDays", async () => {
    await previewUnder((user) => user.clear(daysField()));
    expect(api.previews()).toEqual([{ workStreamId: 3, ownerPersonId: 8, copyDates: true, filter: { excludeDone: true } }]);
  });

  test("both off and an empty field send no filter member at all (the request of before 1.13.2), and the preview has no left-out line", async () => {
    await previewUnder(async (user) => {
      await user.click(doneSwitch());
      await user.clear(daysField());
    });
    expect(api.previews()).toEqual([{ workStreamId: 3, ownerPersonId: 8, copyDates: true }]);
    expect(screen.queryByText(/^Left out:/)).not.toBeInTheDocument();
  });

  test.each(["0", "3651"])("%s is refused with the sentence under the field and Preview waits", async (value) => {
    const user = userEvent.setup();
    open();
    await fillScope(user);
    expect(previewButton()).toBeEnabled();
    await user.clear(daysField());
    await user.type(daysField(), value);
    expect(screen.getByText(INVALID)).toBeInTheDocument();
    expect(previewButton()).toBeDisabled();
    await user.clear(daysField());
    expect(screen.queryByText(INVALID)).not.toBeInTheDocument();
    expect(previewButton()).toBeEnabled();
    expect(api.previews()).toEqual([]);
  });
});

describe("JiraImportModal: what the preview says about the filter", () => {
  test("both controls on: the line names done items and the window", async () => {
    await previewUnder();
    expect(screen.getByText("Left out: done items, and items not updated for more than 365 days. Their parents in the selected projects are still read.")).toBeInTheDocument();
  });

  test("done items only", async () => {
    await previewUnder((user) => user.clear(daysField()));
    expect(screen.getByText("Left out: done items. Their parents in the selected projects are still read.")).toBeInTheDocument();
  });

  test("the window only, in the singular for one day", async () => {
    await previewUnder(async (user) => {
      await user.click(doneSwitch());
      await user.clear(daysField());
      await user.type(daysField(), "1");
    });
    expect(screen.getByText("Left out: items not updated for more than 1 day. Their parents in the selected projects are still read.")).toBeInTheDocument();
  });

  test("a filtered scope that finds nothing says the filter is why", async () => {
    previewResponse = () => jsonResponse(200, previewOf([]));
    await previewUnder();
    expect(screen.getByText("Nothing to import: no issue at the mapped levels passes the filter, or the projects have none. Go back and widen it.")).toBeInTheDocument();
  });

  test("an unfiltered scope that finds nothing keeps the old sentence", async () => {
    previewResponse = () => jsonResponse(200, previewOf([]));
    await previewUnder(async (user) => {
      await user.click(doneSwitch());
      await user.clear(daysField());
    });
    expect(screen.getByText(/^Nothing in scope:/)).toBeInTheDocument();
  });

  test("the too-large alert names the filter as a lever", async () => {
    previewResponse = () => jsonResponse(200, previewOf(PREVIEW_ITEMS, { totals: { items: 2000, create: 6, bind: 1, skip: 2, truncated: true } }));
    await previewUnder();
    expect(screen.getByText(/more than 200 parents that would have to be read one by one/)).toBeInTheDocument();
    expect(screen.getByText(/change what is left out/)).toBeInTheDocument();
  });

  test("a kept parent and a child whose parent could not be read show their notes", async () => {
    const [program, ...rest] = PREVIEW_ITEMS;
    const items = [
      { ...program, infos: ["KEPT_AS_PARENT" as const] },
      ...rest.map((item) => (item.issueKey === "IMP-8" ? { ...item, infos: ["PARENT_UNREADABLE" as const] } : item)),
    ];
    previewResponse = () => jsonResponse(200, previewOf(items));
    await previewUnder();
    const table = screen.getByRole("table", { name: "Import preview" });
    const kept = within(table).getByRole("checkbox", { name: "Import IMP-1" }).closest("tr")!;
    expect(within(kept).getByText(/Kept as a parent of an item shown here/)).toBeInTheDocument();
    const skipped = screen.getByRole("link", { name: /IMP-8/ }).closest("tr")!;
    expect(within(skipped).getByText(/Its parent in Jira could not be read with the connection's account \(Jira answered that it does not exist or is not visible\)/)).toBeInTheDocument();
    expect(within(skipped).queryByRole("checkbox")).not.toBeInTheDocument();
  });
});
