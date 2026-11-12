import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import userEvent from "@testing-library/user-event";
import { QueryClient } from "@tanstack/react-query";
import { screen, waitFor, within } from "@testing-library/react";
import JiraImportModal from "./JiraImportModal";
import { jsonResponse } from "../test/http";
import { CONNECTION, ONE_CONNECTION_SOURCE } from "../test/jira";
import { installImportApi, previewScope, type Handler } from "../test/jiraImportHarness";
import { PREVIEW_ITEMS, previewOf } from "../test/jiraImport";
import { renderWithProviders } from "../test/render";
import type { ImportRoot, ImportSource } from "../utils/jiraImport";

// The rooted dialog (1.14): started from a LINKED program (the Plan page's program menu) it reads only what Jira lists under that node's item.

const OWNER = { value: "8", label: "Ola Owner" };
const PROGRAM_ROOT: ImportRoot = { level: "PROGRAM", nodeId: 4, name: "Billing", issueKey: "IMC-1", connectionId: 1, workStreamId: 3, owner: OWNER };
const PROJECT_ROOT: ImportRoot = { level: "PROJECT", nodeId: 9, name: "Invoices", issueKey: "IMC-2", connectionId: 1, workStreamId: 3, owner: OWNER };
const FILTER = { excludeDone: true, updatedWithinDays: 365 };
const RESULT = { revision: 13, created: [], bound: [], skipped: [] };

let api: ReturnType<typeof installImportApi>;
let previewHandler: Handler;

beforeEach(() => {
  previewHandler = () => jsonResponse(200, previewOf(PREVIEW_ITEMS));
  api = installImportApi({ preview: (body, init) => previewHandler(body, init), apply: () => jsonResponse(200, RESULT) });
});

afterEach(() => {
  vi.unstubAllGlobals();
  localStorage.clear();
});

const open = (root: ImportRoot, source: ImportSource = ONE_CONNECTION_SOURCE) =>
  renderWithProviders(<JiraImportModal source={source} root={root} onClose={vi.fn()} />, { queryClient: new QueryClient({ defaultOptions: { queries: { retry: false } } }) });
const previewButton = () => screen.getByRole("button", { name: "Preview" });
const importButton = () => screen.getByRole("button", { name: /^Import \(\d+\)$/ });
const ownerField = () => screen.queryByRole("combobox", { name: "Owner of the new items" });
const directProject = (key: string) => screen.queryByRole("combobox", { name: `Project for items directly under ${key}` });

describe("JiraImportModal: the rooted scope step", () => {
  test("a program root says what is read and where it lands", () => {
    open(PROGRAM_ROOT);
    expect(screen.getByRole("note")).toHaveTextContent("Importing what Jira lists under IMC-1 into the program “Billing”: its projects and their milestones.");
    expect(screen.queryByText(/^Reads the connection's Jira projects/)).not.toBeInTheDocument();
  });

  test("a project root says its milestones only", () => {
    open(PROJECT_ROOT);
    expect(screen.getByRole("note")).toHaveTextContent("Importing what Jira lists under IMC-2 into the project “Invoices”: its milestones.");
  });

  test("a program root hides the work stream, the Jira projects and the default program, keeps the owner at the program's own and the filter and dates as before", async () => {
    open(PROGRAM_ROOT);
    expect(screen.queryByRole("combobox", { name: /^Work stream/ })).not.toBeInTheDocument();
    expect(screen.queryByText("Jira projects")).not.toBeInTheDocument();
    expect(screen.queryByRole("combobox", { name: "Default program" })).not.toBeInTheDocument();
    expect(screen.queryByRole("combobox", { name: "Default project" })).not.toBeInTheDocument();
    await waitFor(() => expect(ownerField()).toHaveValue("Ola Owner"));
    expect(screen.getByRole("switch", { name: /^Leave out done items/ })).toBeChecked();
    expect(screen.getByRole("textbox", { name: "Updated within (days)" })).toHaveValue("365");
    expect(screen.getByRole("switch", { name: /^Copy Jira's dates/ })).toBeChecked();
    expect(screen.getByRole("combobox", { name: "Default team" })).toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: /^Jira connection/ })).toHaveValue("Acme Jira");
    expect(previewButton()).toBeEnabled();
  });

  test("a program root offers its own projects for the items directly under it", async () => {
    const user = userEvent.setup();
    open(PROGRAM_ROOT);
    expect(screen.getByText(/^Milestone-level items that Jira lists straight under IMC-1 have no project to go to/)).toBeInTheDocument();
    await user.click(directProject("IMC-1")!);
    expect(await screen.findAllByRole("option")).toHaveLength(1);
    await user.click(await screen.findByRole("option", { name: "Invoices" }));
    expect(directProject("IMC-1")).toHaveValue("Invoices");
  });

  test("a project root has no owner and no default project: the project's owner is sent", () => {
    open(PROJECT_ROOT);
    expect(ownerField()).not.toBeInTheDocument();
    expect(directProject("IMC-2")).not.toBeInTheDocument();
    expect(screen.queryByRole("combobox", { name: /^Work stream/ })).not.toBeInTheDocument();
    expect(previewButton()).toBeEnabled();
  });
});

describe("JiraImportModal: the rooted requests", () => {
  test("the preview carries the root and neither projectKeys nor defaults.programId; the apply repeats it", async () => {
    const user = userEvent.setup();
    open(PROGRAM_ROOT);
    await previewScope(user, true);
    expect(api.previews()).toEqual([{ workStreamId: 3, ownerPersonId: 8, copyDates: true, filter: FILTER, root: { level: "PROGRAM", nodeId: 4 } }]);
    await user.click(importButton());
    await screen.findByRole("heading", { level: 3, name: "Import finished" });
    const [applied] = api.applies() as { root: unknown; workStreamId: number; items: unknown[] }[];
    expect(applied).toMatchObject({ workStreamId: 3, ownerPersonId: 8, filter: FILTER, root: { level: "PROGRAM", nodeId: 4 } });
    expect(applied).not.toHaveProperty("projectKeys");
    expect(applied).not.toHaveProperty("defaults");
    expect(applied.items.length).toBeGreaterThan(0);
  });

  test("a default project and a default team go into defaults, a changed owner is sent", async () => {
    const user = userEvent.setup();
    open(PROGRAM_ROOT);
    await user.click(directProject("IMC-1")!);
    await user.click(await screen.findByRole("option", { name: "Invoices" }));
    await user.click(screen.getByRole("combobox", { name: "Default team" }));
    await user.click(await screen.findByRole("option", { name: "Default Team" }));
    await user.click(previewButton());
    await screen.findByRole("heading", { level: 3, name: "What the import would do" });
    expect(api.previews()).toEqual([{ workStreamId: 3, ownerPersonId: 8, defaults: { projectId: 9, teamId: 6 }, copyDates: true, filter: FILTER, root: { level: "PROGRAM", nodeId: 4 } }]);
  });

  test("a project root sends the project's owner and its own root, no defaults", async () => {
    const user = userEvent.setup();
    open(PROJECT_ROOT);
    await previewScope(user, true);
    expect(api.previews()).toEqual([{ workStreamId: 3, ownerPersonId: 8, copyDates: true, filter: FILTER, root: { level: "PROJECT", nodeId: 9 } }]);
  });
});

describe("JiraImportModal: the rooted connection", () => {
  test("a root linked through a connection that is not usable says so and Preview stays disabled", () => {
    open(PROGRAM_ROOT, { connections: [{ ...CONNECTION, id: 2, name: "Other Jira" }], failed: false, retry: () => undefined });
    expect(screen.getByText("This item is linked through a connection that is disabled or no longer fits its site: an administrator has to enable and test it.")).toBeInTheDocument();
    expect(screen.queryByRole("combobox", { name: /^Jira connection/ })).not.toBeInTheDocument();
    expect(previewButton()).toBeDisabled();
  });

  test("only the root's own connection is offered, never the others", () => {
    open(PROGRAM_ROOT, { connections: [{ ...CONNECTION, id: 2, name: "Other Jira" }, CONNECTION], failed: false, retry: () => undefined });
    expect(screen.getByRole("combobox", { name: /^Jira connection/ })).toHaveValue("Acme Jira");
    expect(previewButton()).toBeEnabled();
  });

  test("a source that has not answered yet shows the loading text, not the unusable note, and Preview waits", () => {
    open(PROGRAM_ROOT, { connections: null, failed: false, retry: () => undefined });
    expect(screen.getByText("Loading the Jira connections…")).toBeInTheDocument();
    expect(screen.queryByText(/disabled or no longer fits its site/)).not.toBeInTheDocument();
    expect(previewButton()).toBeDisabled();
  });
});

describe("JiraImportModal: the rooted preview", () => {
  test("nothing under the item and the filter on: three sentences naming the key", async () => {
    previewHandler = () => jsonResponse(200, previewOf([]));
    const user = userEvent.setup();
    open(PROGRAM_ROOT);
    await previewScope(user, true);
    const note = screen.getAllByRole("note").find((candidate) => candidate.textContent?.includes("Jira lists nothing under"))!;
    expect(within(note).getByText("Jira lists nothing under IMC-1 at the levels this connection maps.")).toBeInTheDocument();
    expect(within(note).getByText("The filter may be why: go back and switch “Leave out done items” off or widen the days.")).toBeInTheDocument();
    expect(within(note).getByText("If IMC-1 has child items in Jira, search Jira for parent = IMC-1.")).toBeInTheDocument();
    expect(screen.queryByText(/^Nothing in scope/)).not.toBeInTheDocument();
    expect(screen.queryByText(/^Nothing to import/)).not.toBeInTheDocument();
    expect(importButton()).toBeDisabled();
  });

  test("with the filter off the filter sentence is left out", async () => {
    previewHandler = () => jsonResponse(200, previewOf([]));
    const user = userEvent.setup();
    open(PROJECT_ROOT);
    await user.click(screen.getByRole("switch", { name: /^Leave out done items/ }));
    await user.clear(screen.getByRole("textbox", { name: "Updated within (days)" }));
    await previewScope(user, true);
    expect(api.previews()).toEqual([{ workStreamId: 3, ownerPersonId: 8, copyDates: true, root: { level: "PROJECT", nodeId: 9 } }]);
    expect(screen.getByText("Jira lists nothing under IMC-2 at the levels this connection maps.")).toBeInTheDocument();
    expect(screen.getByText("If IMC-2 has child items in Jira, search Jira for parent = IMC-2.")).toBeInTheDocument();
    expect(screen.queryByText(/The filter may be why/)).not.toBeInTheDocument();
  });

  test("rows keep the search and the ticks as in the whole-scope dialog", async () => {
    const user = userEvent.setup();
    open(PROGRAM_ROOT);
    await previewScope(user, true);
    expect(screen.getByRole("textbox", { name: "Search the preview" })).toBeInTheDocument();
    expect(screen.queryByText(/Jira lists nothing under/)).not.toBeInTheDocument();
  });
});

describe("JiraImportModal: the rooted refusals", () => {
  const rootUnusable = () => jsonResponse(409, { title: "x", status: 409, type: "urn:astrolabe:problem:jira-root-unusable", detail: "no link" });

  test("a preview refused with jira-root-unusable says the link cannot be used and points at the Deviations page", async () => {
    previewHandler = rootUnusable;
    const user = userEvent.setup();
    open(PROGRAM_ROOT);
    await user.click(previewButton());
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "The Jira link of this item cannot be used to import from: the Jira item was deleted or is no longer visible, moved outside the connection's projects, changed its level, or the link was removed. See the Deviations page.",
    );
    expect(screen.queryByText("no link")).not.toBeInTheDocument();
    expect(previewButton()).toBeEnabled();
  });

  test("an apply refused with it says the same and writes nothing the dialog shows", async () => {
    const user = userEvent.setup();
    api = installImportApi({ preview: () => jsonResponse(200, previewOf(PREVIEW_ITEMS)), apply: rootUnusable });
    open(PROGRAM_ROOT);
    await previewScope(user, true);
    await user.click(importButton());
    expect(await screen.findByRole("alert")).toHaveTextContent(/The Jira link of this item cannot be used to import from/);
    expect(screen.queryByRole("heading", { level: 3, name: "Import finished" })).not.toBeInTheDocument();
  });
});
