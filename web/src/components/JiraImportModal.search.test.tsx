import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import userEvent from "@testing-library/user-event";
import { QueryClient } from "@tanstack/react-query";
import { screen, within } from "@testing-library/react";
import JiraImportModal from "./JiraImportModal";
import type { JiraImportItem } from "../api/jira";
import { jsonResponse } from "../test/http";
import { ONE_CONNECTION_SOURCE } from "../test/jira";
import { installImportApi, previewScope } from "../test/jiraImportHarness";
import { PREVIEW_ITEMS, previewOf } from "../test/jiraImport";
import { renderWithProviders } from "../test/render";

// The preview search (1.13.4): it hides rows, never changes a tick, and Select all / none act on what is shown.

let items: JiraImportItem[];
let api: ReturnType<typeof installImportApi>;

beforeEach(() => {
  // IMP-10 gets an accented name and IMP-11 is the redaction a non-admin sees under an active filter (no key, a blank name, a placeholder id).
  items = PREVIEW_ITEMS.map((item) => {
    if (item.issueKey === "IMP-10") return { ...item, name: "Żółw Epic Six", summary: "Żółw Epic Six" };
    if (item.issueKey === "IMP-11") return { ...item, jiraId: "hidden-11", issueKey: null, name: "", summary: "", parentJiraId: null, parentIssueKey: null };
    return item;
  });
  api = installImportApi({ preview: () => jsonResponse(200, previewOf(items)), apply: () => jsonResponse(200, { revision: 13, created: [], bound: [], skipped: [] }) });
});

afterEach(() => {
  vi.unstubAllGlobals();
  localStorage.clear();
});

const open = () =>
  renderWithProviders(<JiraImportModal source={ONE_CONNECTION_SOURCE} onClose={vi.fn()} />, { queryClient: new QueryClient({ defaultOptions: { queries: { retry: false } } }) });
const table = () => screen.getByRole("table", { name: "Import preview" });
const search = () => screen.getByRole("textbox", { name: "Search the preview" });
const box = (key: string) => within(table()).getByRole("checkbox", { name: `Import ${key}` });
const shownKeys = () =>
  within(table())
    .queryAllByRole("checkbox", { name: /^Import / })
    .map((checkbox) => checkbox.getAttribute("aria-label")!.replace("Import ", ""));
const live = () => screen.getAllByRole("status").map((region) => region.textContent).join(" | ");

async function previewed() {
  const user = userEvent.setup();
  open();
  await previewScope(user);
  return user;
}

describe("JiraImportModal: searching the preview", () => {
  test("a Jira key, case-insensitive, leaves that row and says how many are shown", async () => {
    const user = await previewed();
    expect(screen.getByRole("textbox", { name: "Search the preview" })).toHaveAttribute("placeholder", "Key, id or summary");
    await user.type(search(), "  imp-4 ");
    expect(shownKeys()).toEqual(["IMP-4"]);
    expect(screen.getByText("Showing 1 of 9")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Tick shown" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Untick shown" })).toBeInTheDocument();
  });

  test("a Jira id matches", async () => {
    const user = await previewed();
    await user.type(search(), "95010");
    expect(shownKeys()).toEqual(["IMP-10"]);
  });

  test("a summary matches without regard to case or accents, whichever way the difference goes", async () => {
    const user = await previewed();
    await user.type(search(), "ZOLW");
    expect(shownKeys()).toEqual(["IMP-10"]);
    await user.clear(search());
    await user.type(search(), "żółw epic");
    expect(shownKeys()).toEqual(["IMP-10"]);
    await user.clear(search());
    await user.type(search(), "initiative");
    expect(shownKeys()).toEqual(["IMP-2", "IMP-3"]);
  });

  test("a row redacted for a non-admin never matches: not by its placeholder id, not by the word Hidden, and still shown without a search", async () => {
    const user = await previewed();
    expect(within(table()).getByText("Hidden")).toBeInTheDocument();
    for (const query of ["hidden-11", "hidden", "11"]) {
      await user.clear(search());
      await user.type(search(), query);
      expect(screen.queryByText("Hidden")).not.toBeInTheDocument();
      expect(screen.getByText(`No rows match “${query}”.`)).toBeInTheDocument();
    }
    await user.clear(search());
    expect(within(table()).getByText("Hidden")).toBeInTheDocument();
  });

  test("rows left out of view keep their ticks and the counts stay global; clearing the search restores every row", async () => {
    const user = await previewed();
    await user.click(box("IMP-5"));
    expect(screen.getByText("6 of 7 selected")).toBeInTheDocument();
    await user.type(search(), "IMP-4");
    expect(screen.getByText("6 of 7 selected")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Import (6)" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Clear the search" }));
    expect(search()).toHaveValue("");
    expect(within(table()).getAllByRole("row")).toHaveLength(10);
    expect(screen.queryByText(/^Showing /)).not.toBeInTheDocument();
    expect(box("IMP-5")).not.toBeChecked();
    expect(box("IMP-4")).toBeChecked();
    expect(screen.getByRole("button", { name: "Select all" })).toBeInTheDocument();
  });

  test("a team override on a row survives the row leaving and returning to view", async () => {
    const user = await previewed();
    const team = () => within(table()).getByRole("combobox", { name: "Team for IMP-4" });
    await user.selectOptions(team(), "Default Team");
    await user.type(search(), "IMP-5");
    expect(within(table()).queryByRole("combobox", { name: "Team for IMP-4" })).not.toBeInTheDocument();
    await user.clear(search());
    expect(team()).toHaveValue("6");
  });

  test("no match: a note instead of the table, the box stays, the buttons have nothing to act on", async () => {
    const user = await previewed();
    await user.type(search(), " nothing like it ");
    expect(screen.getByText("No rows match “nothing like it”.")).toBeInTheDocument();
    expect(screen.queryByRole("table", { name: "Import preview" })).not.toBeInTheDocument();
    expect(screen.getByText("Showing 0 of 9")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Tick shown" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Untick shown" })).toBeDisabled();
    expect(screen.getByText("7 of 7 selected")).toBeInTheDocument();
    await user.clear(search());
    expect(table()).toBeInTheDocument();
  });

  test("Untick shown and Tick shown act on the shown rows only, and the header checkbox follows them", async () => {
    const user = await previewed();
    await user.type(search(), "Epic");
    expect(shownKeys()).toEqual(["IMP-4", "IMP-5", "IMP-10"]);
    const header = screen.getByRole("checkbox", { name: "Tick all shown rows that can be imported" });
    expect(header).toBeChecked();
    await user.click(screen.getByRole("button", { name: "Untick shown" }));
    expect(screen.getByText("4 of 7 selected")).toBeInTheDocument();
    expect(header).not.toBeChecked();
    expect(screen.getByRole("button", { name: "Untick shown" })).toBeDisabled();
    await user.click(box("IMP-10"));
    expect(header).toHaveProperty("indeterminate", true);
    await user.click(screen.getByRole("button", { name: "Tick shown" }));
    expect(screen.getByText("7 of 7 selected")).toBeInTheDocument();
    await user.clear(search());
    for (const key of ["IMP-1", "IMP-2", "IMP-3", "IMP-9"]) expect(box(key)).toBeChecked();
  });

  test("Tick shown also ticks what a shown row is created under, and Untick shown also unticks what is created under it, shown or not", async () => {
    const user = await previewed();
    await user.click(screen.getByRole("button", { name: "Select none" }));
    expect(screen.getByText("0 of 7 selected")).toBeInTheDocument();
    await user.type(search(), "Epic One");
    await user.click(screen.getByRole("button", { name: "Tick shown" }));
    expect(screen.getByText("3 of 7 selected")).toBeInTheDocument();
    expect(live()).toContain("Also ticked 2 items outside the search that the shown rows are created under.");
    expect(screen.getByRole("button", { name: "Import (3)" })).toBeInTheDocument();

    await user.clear(search());
    expect(box("IMP-1")).toBeChecked();
    expect(box("IMP-2")).toBeChecked();
    expect(box("IMP-5")).not.toBeChecked();
    await user.type(search(), "Initiative Alpha");
    expect(shownKeys()).toEqual(["IMP-2"]);
    await user.click(screen.getByRole("button", { name: "Untick shown" }));
    expect(live()).toContain("Also unticked 1 item outside the search that is created under the shown rows: it would be skipped.");
    expect(screen.getByText("1 of 7 selected")).toBeInTheDocument();
    await user.clear(search());
    expect(live()).not.toContain("outside the search");
    expect(box("IMP-4")).not.toBeChecked();
    expect(box("IMP-1")).toBeChecked();
  });

  test("the apply sends every ticked row, shown or not", async () => {
    const user = await previewed();
    await user.type(search(), "IMP-9");
    await user.click(screen.getByRole("button", { name: "Untick shown" }));
    await user.click(screen.getByRole("button", { name: "Import (6)" }));
    await screen.findByRole("heading", { level: 3, name: "Import finished" });
    const sent = (api.applies()[0] as { items: { jiraId: string }[] }).items.map((item) => item.jiraId);
    expect(sent).toEqual(["95001", "95002", "95003", "95004", "95005", "95010"]);
  });
});
