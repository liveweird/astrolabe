import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import userEvent from "@testing-library/user-event";
import { QueryClient } from "@tanstack/react-query";
import { screen, waitFor, within } from "@testing-library/react";
import JiraImportModal from "./JiraImportModal";
import type { JiraImportResult } from "../api/jira";
import { jsonResponse } from "../test/http";
import { ONE_CONNECTION_SOURCE } from "../test/jira";
import { fillScope, installImportApi, previewScope } from "../test/jiraImportHarness";
import { PREVIEW_ITEMS, previewOf } from "../test/jiraImport";
import { renderWithProviders } from "../test/render";

const RESULT: JiraImportResult = {
  revision: 13,
  created: [
    { jiraId: "95001", issueKey: "IMP-1", kind: "PROGRAM", id: 40, bindingId: 1, name: "IMP Program", scheduled: false },
    { jiraId: "95004", issueKey: "IMP-4", kind: "MILESTONE", id: 41, bindingId: 2, name: "IMP Epic One", scheduled: true },
  ],
  bound: [{ jiraId: "95009", issueKey: "IMP-9", kind: "PROJECT", id: 77, bindingId: 3 }],
  skipped: [
    { jiraId: "1", issueKey: "IMP-20", reason: "ALREADY_BOUND" },
    { jiraId: "2", issueKey: "IMP-21", reason: "NO_PARENT" },
    { jiraId: "3", issueKey: "IMP-22", reason: "NAME_TAKEN" },
    { jiraId: "4", issueKey: "IMP-23", reason: "LEVEL_UNMAPPED" },
    { jiraId: "5", issueKey: "IMP-24", reason: "NO_TEAM" },
    { jiraId: "6", issueKey: "IMP-25", reason: "PARENT_SKIPPED" },
    { jiraId: "7", issueKey: "IMP-26", reason: "CHANGED" },
    { jiraId: "8", issueKey: null, reason: "CHANGED" },
  ],
};

let api: ReturnType<typeof installImportApi>;
let queryClient: QueryClient;
let previewResponse: () => Response;
let applyResponse: () => Response;

beforeEach(() => {
  previewResponse = () => jsonResponse(200, previewOf(PREVIEW_ITEMS));
  applyResponse = () => jsonResponse(200, RESULT);
  api = installImportApi({ preview: () => previewResponse(), apply: () => applyResponse() });
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
});

afterEach(() => {
  vi.unstubAllGlobals();
  localStorage.clear();
});

const open = (onClose = vi.fn()) => renderWithProviders(<JiraImportModal source={ONE_CONNECTION_SOURCE} onClose={onClose} />, { queryClient });
const table = () => screen.getByRole("table", { name: "Import preview" });
const rowOf = (key: string) => within(table()).getByRole("checkbox", { name: `Import ${key}` }).closest("tr")!;
const importButton = () => screen.getByRole("button", { name: /^Import \(\d+\)$/ });

describe("JiraImportModal: the scope and the preview", () => {
  test("the title is the modal's h2, the phases are h3, and Preview waits for a work stream and an owner", async () => {
    const user = userEvent.setup();
    open();
    expect(screen.getByRole("heading", { level: 2, name: "Import from Jira" })).toBeInTheDocument();
    expect(screen.getByText("Step 1 of 3: choose what to import")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Preview" })).toBeDisabled();
    await previewScope(user);
    expect(screen.getByText("Step 2 of 3: review the preview")).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 3, name: "What the import would do" })).toHaveFocus();
    expect(api.previews()).toEqual([{ workStreamId: 3, ownerPersonId: 8, copyDates: true, filter: { excludeDone: true, updatedWithinDays: 365 } }]);
  });

  test("the defaults, a narrowed key list and the dates switch go into the preview scope", async () => {
    const user = userEvent.setup();
    open();
    await user.click(screen.getByRole("combobox", { name: /^Work stream/ }));
    await user.click(await screen.findByRole("option", { name: "Platform" }));
    await user.click(screen.getByRole("combobox", { name: "Owner of the new items" }));
    await user.click(await screen.findByRole("option", { name: "Ola Owner" }));
    await user.click(screen.getByRole("combobox", { name: "Default team" }));
    await user.click(await screen.findByRole("option", { name: "Default Team" }));
    await user.click(screen.getByRole("combobox", { name: "Default project" }));
    await user.click(await screen.findByRole("option", { name: "Invoices · Billing" }));
    await user.click(screen.getByRole("combobox", { name: "Default program" }));
    await user.click(await screen.findByRole("option", { name: "Billing" }));
    await user.click(screen.getAllByLabelText(/^Jira projects/).find((el) => el.tagName === "INPUT")!);
    await user.click(await screen.findByRole("option", { name: "PF" }));
    await user.click(screen.getByRole("switch", { name: /^Copy Jira/ }));
    await user.click(screen.getByRole("button", { name: "Preview" }));
    await screen.findByRole("table", { name: "Import preview" });
    expect(api.previews()).toEqual([
      { workStreamId: 3, ownerPersonId: 8, projectKeys: ["E2E"], defaults: { programId: 4, projectId: 9, teamId: 6 }, copyDates: false, filter: { excludeDone: true, updatedWithinDays: 365 } },
    ]);
  });

  test("shows the totals, a line per row in words, and the notes about rights and unmatched teams", async () => {
    const user = userEvent.setup();
    previewResponse = () => jsonResponse(200, previewOf(PREVIEW_ITEMS, { unmatchedTeams: ["Ghost Team"] }));
    open();
    await previewScope(user);
    const totals = screen.getByRole("group", { name: "Totals" });
    expect(within(totals).getByText("Jira items: 9")).toBeInTheDocument();
    expect(within(totals).getByText("To create: 6")).toBeInTheDocument();
    expect(within(totals).getByText("To link: 1")).toBeInTheDocument();
    expect(within(totals).getByText("Skipped: 2").closest(".mantine-Badge-root")!.getAttribute("style") ?? "").toContain("orange");
    expect(screen.getByText("1 of 2 milestones with dates will be created unscheduled: you do not manage their teams.")).toBeInTheDocument();
    expect(screen.getByText(/Jira teams that match no team here: Ghost Team/)).toBeInTheDocument();
    expect(screen.getByText("7 of 7 selected")).toBeInTheDocument();
    expect(within(rowOf("IMP-4")).getByText("Under new IMP Initiative Alpha")).toBeInTheDocument();
    expect(within(rowOf("IMP-4")).getByText("2045-01-02 to 2045-01-06 · 5 man-days")).toBeInTheDocument();
    expect(within(rowOf("IMP-5")).getByText(/Estimate not converted/)).toBeInTheDocument();
    expect(within(rowOf("IMP-9")).getByText("Links to the existing Existing Project")).toBeInTheDocument();
    expect(within(rowOf("IMP-10")).getByText("Under Old project")).toBeInTheDocument();
    const skipRow = screen.getByRole("link", { name: /IMP-8/ }).closest("tr")!;
    expect(within(skipRow).getByText(/Nowhere to put it/)).toBeInTheDocument();
    expect(within(skipRow).queryByRole("checkbox")).not.toBeInTheDocument();
    expect(table()).toHaveAttribute("aria-rowcount", "10");
  });

  test("a redacted SKIP row (no summary, the key as its name) leaves no blank cell", async () => {
    const user = userEvent.setup();
    open();
    await previewScope(user);
    const row = screen.getByRole("link", { name: /IMP-11/ }).closest("tr")!;
    expect(within(row).getByText("IMP-11", { selector: "p[title]" })).toBeInTheDocument();
    expect(within(row).getByText(/already exists here/)).toBeInTheDocument();
    for (const cell of within(row).getAllByRole("cell")) expect((cell.textContent ?? "").trim()).not.toBe("");
  });

  test("a row redacted under an active filter has no key: a Hidden placeholder, its reason, no link, no checkbox, no blank cell", async () => {
    const user = userEvent.setup();
    const hidden = PREVIEW_ITEMS.map((item) =>
      item.issueKey === "IMP-11" ? { ...item, jiraId: "hidden-11", issueKey: null, name: "", parentJiraId: null, parentIssueKey: null } : item,
    );
    previewResponse = () => jsonResponse(200, previewOf(hidden));
    open();
    await previewScope(user);
    const placeholder = within(table()).getByText("Hidden");
    const row = placeholder.closest("tr")!;
    expect(within(row).queryByRole("link")).not.toBeInTheDocument();
    expect(within(row).queryByRole("checkbox")).not.toBeInTheDocument();
    expect(within(row).getByText(/already exists here/)).toBeInTheDocument();
    for (const cell of within(row).getAllByRole("cell")) expect((cell.textContent ?? "").trim()).not.toBe("");
    expect(table()).toHaveAttribute("aria-rowcount", "10");
    expect(within(table()).queryByText(/IMP-11/)).not.toBeInTheDocument();
  });

  test("a preview with more than 2,000 issues cannot be imported: it names the filter and the keys as the levers", async () => {
    const user = userEvent.setup();
    previewResponse = () => jsonResponse(200, previewOf(PREVIEW_ITEMS, { totals: { items: 2000, create: 6, bind: 1, skip: 2, truncated: true } }));
    open();
    await previewScope(user);
    expect(screen.getByText(/The scope is too large to import: more than 2,000 issues, or more than 200 parents/)).toBeInTheDocument();
    expect(screen.getByText(/narrow the Jira projects or change what is left out/)).toBeInTheDocument();
    expect(importButton()).toBeDisabled();
    expect(screen.getByRole("button", { name: "Select all" })).toBeDisabled();
  });
});

describe("JiraImportModal: honest rows", () => {
  test("a preview whose only skips are already-linked rows shows a gray Skipped badge, not an orange one", async () => {
    const user = userEvent.setup();
    const bound = PREVIEW_ITEMS.filter((i) => i.action === "CREATE").slice(0, 1).concat({ ...PREVIEW_ITEMS[5], reason: "ALREADY_BOUND" });
    previewResponse = () => jsonResponse(200, previewOf(bound));
    open();
    await previewScope(user);
    const badge = within(screen.getByRole("group", { name: "Totals" })).getByText("Skipped: 1").closest(".mantine-Badge-root")!;
    expect(badge.getAttribute("style") ?? "").not.toContain("orange");
  });

  test("with Copy Jira's dates off a milestone says its dates were not copied, not that Jira has none", async () => {
    const user = userEvent.setup();
    previewResponse = () => jsonResponse(200, previewOf(PREVIEW_ITEMS.map((i) => ({ ...i, startDate: null, endDate: null, scheduled: false }))));
    open();
    await fillScope(user);
    await user.click(screen.getByRole("switch", { name: /^Copy Jira/ }));
    await user.click(screen.getByRole("button", { name: "Preview" }));
    await screen.findByRole("table", { name: "Import preview" });
    expect(within(rowOf("IMP-4")).getByText("Dates not copied (switched off) · 5 man-days")).toBeInTheDocument();
    expect(screen.queryByText("No dates")).not.toBeInTheDocument();
  });

  test("a milestone's own team is an option even when it is not in the loaded list, so the select never shows another team", async () => {
    const user = userEvent.setup();
    const remote = PREVIEW_ITEMS.map((i) => (i.jiraId === "95004" ? { ...i, team: { id: 99, name: "Remote Team", rule: "MATCHED" as const } } : i));
    previewResponse = () => jsonResponse(200, previewOf(remote));
    open();
    await previewScope(user);
    const select = within(rowOf("IMP-4")).getByRole("combobox", { name: "Team for IMP-4" });
    expect(select).toHaveValue("99");
    expect(within(select).getByRole("option", { name: "Remote Team" })).toBeInTheDocument();
  });

  test("the type and the plan level share a cell, the new parent reads first, and there is no Level column", async () => {
    const user = userEvent.setup();
    open();
    await previewScope(user);
    expect(within(rowOf("IMP-4")).getByText("Epic → milestone")).toBeInTheDocument();
    expect(within(table()).queryByRole("columnheader", { name: "Level" })).not.toBeInTheDocument();
  });
});

describe("JiraImportModal: ticks", () => {
  test("unticking a parent unticks what is created under it and says so before anything is submitted", async () => {
    const user = userEvent.setup();
    open();
    await previewScope(user);
    await user.click(within(rowOf("IMP-2")).getByRole("checkbox"));
    expect(within(rowOf("IMP-4")).getByRole("checkbox")).not.toBeChecked();
    expect(within(rowOf("IMP-5")).getByRole("checkbox")).not.toBeChecked();
    expect(within(rowOf("IMP-3")).getByRole("checkbox")).toBeChecked();
    expect(within(rowOf("IMP-4")).getByText("Not imported")).toBeInTheDocument();
    expect(within(rowOf("IMP-4")).getByText("Its parent IMP-2 is not ticked, so this is not imported.")).toBeInTheDocument();
    expect(screen.getByText("Unticked IMP-2 and the 2 items created under it: they would be skipped.")).toBeInTheDocument();
    expect(screen.getByText("4 of 7 selected")).toBeInTheDocument();
    expect(importButton()).toHaveTextContent("Import (4)");
    // Ticking a child brings its parent back.
    await user.click(within(rowOf("IMP-4")).getByRole("checkbox"));
    expect(within(rowOf("IMP-2")).getByRole("checkbox")).toBeChecked();
    expect(screen.getByText("Ticked IMP-4 and the item it is created under.")).toBeInTheDocument();
    expect(screen.getByText("6 of 7 selected")).toBeInTheDocument();
  });

  test("select none and select all move the count; nothing ticked disables Import", async () => {
    const user = userEvent.setup();
    open();
    await previewScope(user);
    await user.click(screen.getByRole("button", { name: "Select none" }));
    expect(screen.getByText("0 of 7 selected")).toBeInTheDocument();
    expect(importButton()).toBeDisabled();
    await user.click(screen.getByRole("checkbox", { name: "Select all rows that can be imported" }));
    expect(screen.getByText("7 of 7 selected")).toBeInTheDocument();
    await user.click(screen.getByRole("checkbox", { name: "Select all rows that can be imported" }));
    expect(screen.getByText("0 of 7 selected")).toBeInTheDocument();
  });
});

describe("JiraImportModal: the apply", () => {
  test("sends the preview's scope and, per ticked row, exactly what the preview showed (the landing projected to {kind, nodeId})", async () => {
    const user = userEvent.setup();
    open();
    await previewScope(user);
    await user.click(within(rowOf("IMP-3")).getByRole("checkbox"));
    await user.click(importButton());
    await screen.findByRole("heading", { level: 3, name: "Import finished" });
    expect(api.applies()).toEqual([
      {
        workStreamId: 3,
        ownerPersonId: 8,
        copyDates: true,
        filter: { excludeDone: true, updatedWithinDays: 365 },
        items: [
          { jiraId: "95001", expected: { action: "CREATE", level: "PROGRAM" } },
          { jiraId: "95002", expected: { action: "CREATE", level: "PROJECT", parentJiraId: "95001", parent: { kind: "NEW_ROW" } } },
          {
            jiraId: "95004",
            expected: { action: "CREATE", level: "MILESTONE", parentJiraId: "95002", parent: { kind: "NEW_ROW" }, teamId: 5 },
          },
          {
            jiraId: "95005",
            expected: { action: "CREATE", level: "MILESTONE", parentJiraId: "95002", parent: { kind: "NEW_ROW" }, teamId: 6 },
          },
          { jiraId: "95009", expected: { action: "BIND", level: "PROJECT", parentJiraId: "95001", nodeId: 77 } },
          { jiraId: "95010", expected: { action: "CREATE", level: "MILESTONE", parent: { kind: "EXISTING", nodeId: 40 }, teamId: 5 } },
        ],
      },
    ]);
    // No key beyond the strict schema ever leaves the browser.
    const text = JSON.stringify(api.applies()[0]);
    expect(text).not.toContain("nodeName");
    expect(text).not.toContain("rowJiraId");
  });

  test("a row's team override is sent as overrides.teamId while expected.teamId stays the team the row showed", async () => {
    const user = userEvent.setup();
    open();
    await previewScope(user);
    await user.selectOptions(within(rowOf("IMP-4")).getByRole("combobox", { name: "Team for IMP-4" }), "6");
    await user.click(importButton());
    await screen.findByRole("heading", { level: 3, name: "Import finished" });
    const items = (api.applies()[0] as { items: { jiraId: string; expected: { teamId?: number }; overrides?: unknown }[] }).items;
    const row = items.find((item) => item.jiraId === "95004")!;
    expect(row.overrides).toEqual({ teamId: 6 });
    expect(row.expected.teamId).toBe(5);
    expect(items.filter((item) => item.overrides !== undefined)).toHaveLength(1);
  });

  test("a program or project row has its own owner picker, sent as overrides.ownerPersonId only when it differs; a milestone, a BIND and a skipped row have none", async () => {
    const user = userEvent.setup();
    open();
    await previewScope(user);
    for (const key of ["IMP-1", "IMP-2", "IMP-3"]) expect(within(rowOf(key)).getByRole("combobox", { name: `Owner for ${key}` })).toHaveValue("Ola Owner");
    for (const key of ["IMP-4", "IMP-9", "IMP-10"]) expect(within(rowOf(key)).queryByRole("combobox", { name: `Owner for ${key}` })).not.toBeInTheDocument();
    await user.click(within(rowOf("IMP-2")).getByRole("combobox", { name: "Owner for IMP-2" }));
    await user.click(await screen.findByRole("option", { name: "Pat Planner" }));
    expect(within(rowOf("IMP-2")).getByRole("combobox", { name: "Owner for IMP-2" })).toHaveValue("Pat Planner");
    await user.click(importButton());
    await screen.findByRole("heading", { level: 3, name: "Import finished" });
    const items = (api.applies()[0] as { items: { jiraId: string; overrides?: unknown }[] }).items;
    expect(items.find((item) => item.jiraId === "95002")!.overrides).toEqual({ ownerPersonId: 9 });
    expect(items.filter((item) => item.overrides !== undefined)).toHaveLength(1);
  });

  test("a row with no pick of its own offers no clear button (it would only blank the box); after a pick it does, and clearing restores the dialog's owner", async () => {
    const user = userEvent.setup();
    open();
    await previewScope(user);
    const clear = () => within(rowOf("IMP-2")).queryByRole("button", { name: "Use the owner chosen in the first step" });
    expect(clear()).not.toBeInTheDocument();
    await user.click(within(rowOf("IMP-2")).getByRole("combobox", { name: "Owner for IMP-2" }));
    await user.click(await screen.findByRole("option", { name: "Pat Planner" }));
    await user.click(clear()!);
    expect(within(rowOf("IMP-2")).getByRole("combobox", { name: "Owner for IMP-2" })).toHaveValue("Ola Owner");
    expect(clear()).not.toBeInTheDocument();
    await user.click(importButton());
    await screen.findByRole("heading", { level: 3, name: "Import finished" });
    const items = (api.applies()[0] as { items: { overrides?: unknown }[] }).items;
    expect(items.filter((item) => item.overrides !== undefined)).toHaveLength(0);
  });

  test("a second click while the import runs sends nothing more, and the dialog cannot be closed meanwhile", async () => {
    const user = userEvent.setup();
    const gate: { release?: (response: Response) => void } = {};
    const onClose = vi.fn();
    api = installImportApi({ preview: () => previewResponse(), apply: () => new Promise<Response>((resolve) => (gate.release = resolve)) });
    open(onClose);
    await previewScope(user);
    await user.dblClick(importButton());
    expect(api.applies()).toHaveLength(1);
    expect(screen.getByText("Importing… keep this window open.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Close" })).not.toBeInTheDocument();
    await user.keyboard("{Escape}");
    expect(onClose).not.toHaveBeenCalled();
    gate.release?.(jsonResponse(200, RESULT));
    await screen.findByRole("heading", { level: 3, name: "Import finished" });
  });

  test("the outcome counts what was created, linked, scheduled and skipped, and puts every skip reason in words", async () => {
    const user = userEvent.setup();
    open();
    await previewScope(user);
    await user.click(importButton());
    await screen.findByRole("heading", { level: 3, name: "Import finished" });
    expect(screen.getByRole("heading", { level: 3, name: "Import finished" })).toHaveFocus();
    const counts = screen.getAllByRole("status")[0];
    expect(within(counts).getByText("Created: 2")).toBeInTheDocument();
    expect(within(counts).getByText("Linked: 1")).toBeInTheDocument();
    expect(within(counts).getByText("Scheduled: 1")).toBeInTheDocument();
    expect(within(counts).getByText("Skipped: 8")).toBeInTheDocument();
    const skipped = screen.getByRole("table", { name: "Skipped rows" });
    expect(within(skipped).getByText("Already linked to a plan item.")).toBeInTheDocument();
    expect(within(skipped).getByText(/Nowhere to put it/)).toBeInTheDocument();
    expect(within(skipped).getByText(/already exists here/)).toBeInTheDocument();
    expect(within(skipped).getByText(/not mapped to a plan level/)).toBeInTheDocument();
    expect(within(skipped).getByText(/No team: its Jira team/)).toBeInTheDocument();
    expect(within(skipped).getByText("Its parent is skipped, so it is skipped too.")).toBeInTheDocument();
    expect(within(skipped).getAllByText("Changed since the preview, in Jira or in the plan. Preview again.")).toHaveLength(2);
    expect(within(skipped).getByText("Item 8 (no longer in Jira)")).toBeInTheDocument();
    expect(screen.getByText(/2 rows changed since the preview and were skipped/)).toBeInTheDocument();
  });

  test("Preview again from a CHANGED outcome reads Jira again with the same scope and returns to the preview", async () => {
    const user = userEvent.setup();
    open();
    await previewScope(user);
    await user.click(importButton());
    await screen.findByRole("heading", { level: 3, name: "Import finished" });
    await user.click(screen.getByRole("button", { name: "Preview again" }));
    await screen.findByRole("heading", { level: 3, name: "What the import would do" });
    expect(api.previews()).toHaveLength(2);
    expect(api.previews()[1]).toEqual(api.previews()[0]);
  });

  test("a finished import refreshes the plan views and the Jira queries (the one Jira call that moves the plan)", async () => {
    const user = userEvent.setup();
    const invalidate = vi.spyOn(queryClient, "invalidateQueries");
    open();
    await previewScope(user);
    await user.click(importButton());
    await screen.findByRole("heading", { level: 3, name: "Import finished" });
    await waitFor(() => {
      const keys = invalidate.mock.calls.map(([filters]) => JSON.stringify(filters?.queryKey));
      expect(keys).toEqual(expect.arrayContaining(['["jira"]', '["plan"]', '["roadmap"]']));
    });
  });

  test("an import that wrote nothing says so", async () => {
    const user = userEvent.setup();
    applyResponse = () => jsonResponse(200, { revision: 14, created: [], bound: [], skipped: [{ jiraId: "1", issueKey: "IMP-1", reason: "ALREADY_BOUND" }] });
    open();
    await previewScope(user);
    await user.click(importButton());
    await screen.findByText("Nothing was created or linked: every selected row was skipped.");
    expect(screen.queryByText(/changed since the preview and/)).not.toBeInTheDocument();
  });
});

describe("JiraImportModal: back, and closing", () => {
  test("Back returns to the scope with its values kept, and Close calls onClose", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    open(onClose);
    await previewScope(user);
    await user.click(screen.getByRole("button", { name: "Back" }));
    expect(screen.getByRole("combobox", { name: /^Work stream/ })).toHaveValue("Platform");
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
