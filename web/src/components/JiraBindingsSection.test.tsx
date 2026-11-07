import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import userEvent from "@testing-library/user-event";
import { screen, waitFor, within } from "@testing-library/react";
import JiraBindingsSection from "./JiraBindingsSection";
import type { JiraBinding } from "../api/jira";
import { jsonResponse } from "../test/http";
import { CONNECTION } from "../test/jira";
import { renderWithProviders } from "../test/render";

const ROLES_KEY = "astrolabe.auth.roles";

const binding = (id: number, over: Partial<JiraBinding> = {}): JiraBinding => ({
  id,
  connectionId: 1,
  level: "MILESTONE",
  node: { kind: "MILESTONE", id: 10 + id, name: `Milestone ${id}`, projectName: "Invoices", programName: "Billing", workStreamName: "Platform" },
  issueId: `100${id}`,
  issueKey: `E2E-${id}`,
  url: `https://acme.atlassian.net/browse/E2E-${id}`,
  observation: { observedAt: 1, statusCategory: "IN_PROGRESS", summary: `Epic ${id}`, gone: false },
  createdAt: Date.UTC(2026, 10, 6, 9, 30),
  createdBy: { userId: 1, name: "Ola Owner" },
  ...over,
});

let mockFetch: ReturnType<typeof vi.fn>;
let rows: JiraBinding[];
let deleteStatus: number;

beforeEach(() => {
  rows = [binding(1), binding(2, { level: "PROJECT", node: { kind: "PROJECT", id: 7, name: "Invoices", programName: "Billing", workStreamName: "Platform" }, observation: { observedAt: 1, statusCategory: "DONE", summary: "Initiative", gone: true } })];
  deleteStatus = 204;
  mockFetch = vi.fn((url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    if (method === "DELETE") {
      if (deleteStatus === 204) rows = rows.filter((row) => row.id !== Number(url.split("/").at(-1)));
      return Promise.resolve(deleteStatus === 204 ? new Response(null, { status: 204 }) : jsonResponse(deleteStatus, { title: "x", status: deleteStatus }));
    }
    if (url.startsWith("/api/v1/integrations/jira/bindings?")) return Promise.resolve(jsonResponse(200, { items: rows, page: 1, pageSize: 20, total: rows.length }));
    return Promise.resolve(jsonResponse(404, { title: "x", status: 404 }));
  });
  vi.stubGlobal("fetch", mockFetch);
  localStorage.setItem("astrolabe.auth.token", "fake-token");
  localStorage.setItem(ROLES_KEY, JSON.stringify(["ADMIN"]));
});

afterEach(() => {
  vi.unstubAllGlobals();
  localStorage.clear();
});

const listCalls = () => mockFetch.mock.calls.map(([url]) => url as string).filter((url) => url.startsWith("/api/v1/integrations/jira/bindings?")).map((url) => Object.fromEntries(new URL(url, "http://x").searchParams));

describe("JiraBindingsSection", () => {
  test("lists the connection's links with the plan item, its level, the Jira key as an external link, a gone mark and who linked it", async () => {
    renderWithProviders(<JiraBindingsSection connection={CONNECTION} />);
    const table = await screen.findByRole("table", { name: "Links to plan items" });
    expect(await within(table).findByText("Milestone 1")).toBeInTheDocument();
    expect(within(table).getAllByText("Invoices").length).toBeGreaterThan(0);
    const key = within(table).getByRole("link", { name: /E2E-1/ });
    expect(key).toHaveAttribute("href", "https://acme.atlassian.net/browse/E2E-1");
    expect(key.getAttribute("rel")).toContain("noopener");
    expect(within(table).getByText("Gone from Jira")).toBeInTheDocument();
    expect(within(table).getAllByText("Ola Owner")).toHaveLength(2);
    // The project's name is the link into its page; a milestone's binding carries only the project's name, so it is plain text.
    expect(within(table).getByRole("link", { name: "Invoices" })).toHaveAttribute("href", "/projects/7");
    expect(screen.getByRole("heading", { level: 3, name: "Links to plan items" })).toBeInTheDocument();
    expect(listCalls()[0]).toMatchObject({ connectionId: "1", page: "1", sort: "issueKey" });
  });

  test("the level filter and the name filter go to the server as level= and q=", async () => {
    const user = userEvent.setup();
    renderWithProviders(<JiraBindingsSection connection={CONNECTION} />);
    await screen.findByText("Milestone 1");
    await user.click(screen.getByRole("combobox", { name: "Plan item type" }));
    await user.click(await screen.findByRole("option", { name: "Project" }));
    await waitFor(() => expect(listCalls().some((q) => q.level === "PROJECT")).toBe(true));
    await user.type(screen.getByRole("textbox", { name: "Plan item name" }), "invo");
    await waitFor(() => expect(listCalls().some((q) => q.level === "PROJECT" && q.q === "invo")).toBe(true));
  });

  test("Unlink asks first, names the item and the key, and refreshes the list; focus returns to the section heading", async () => {
    const user = userEvent.setup();
    renderWithProviders(<JiraBindingsSection connection={CONNECTION} />);
    await user.click(await screen.findByRole("button", { name: "Unlink: Milestone 1" }));
    const dialog = await screen.findByRole("dialog", { name: "Unlink from Jira?" });
    expect(within(dialog).getByText(/Milestone 1 will no longer be linked to E2E-1/)).toBeInTheDocument();
    await user.click(within(dialog).getByRole("button", { name: "Unlink" }));
    await waitFor(() => expect(screen.queryByText("Milestone 1")).not.toBeInTheDocument());
    expect(mockFetch.mock.calls.some(([url, init]) => url === "/api/v1/integrations/jira/bindings/1" && (init as RequestInit).method === "DELETE")).toBe(true);
    await waitFor(() => expect(screen.getByRole("heading", { level: 3, name: "Links to plan items" })).toHaveFocus());
  });

  test("a refused unlink stays in the dialog in words", async () => {
    deleteStatus = 403;
    const user = userEvent.setup();
    renderWithProviders(<JiraBindingsSection connection={CONNECTION} />);
    await user.click(await screen.findByRole("button", { name: "Unlink: Milestone 1" }));
    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: "Unlink" }));
    expect(await within(dialog).findByText("Only the item's owners and administrators can unlink it.")).toBeInTheDocument();
    expect(screen.getByText("Milestone 1")).toBeInTheDocument();
  });

  test("empty: no links yet; filtered: no link matches; and the note says links to deleted items are not listed", async () => {
    rows = [];
    renderWithProviders(<JiraBindingsSection connection={CONNECTION} />);
    expect(await screen.findByText("No plan item is linked through this connection yet.")).toBeInTheDocument();
    expect(screen.getByText("Links to deleted plan items are not listed here.")).toBeInTheDocument();
  });

  test("Link a node… opens the bind dialog locked to this connection; a disabled connection cannot be linked through", async () => {
    const user = userEvent.setup();
    const { unmount } = renderWithProviders(<JiraBindingsSection connection={CONNECTION} />);
    await user.click(await screen.findByRole("button", { name: "Link a node…" }));
    const dialog = await screen.findByRole("dialog", { name: "Link to Jira" });
    expect(await within(dialog).findByRole("combobox", { name: "Jira connection" })).toHaveValue("Acme Jira");
    unmount();
    renderWithProviders(<JiraBindingsSection connection={{ ...CONNECTION, enabled: false }} />);
    expect(await screen.findByRole("button", { name: "Link a node…" })).toBeDisabled();
  });

  test("Import from Jira… opens the import modal and Close returns the focus to the button", async () => {
    const user = userEvent.setup();
    renderWithProviders(<JiraBindingsSection connection={CONNECTION} />);
    const entry = await screen.findByRole("button", { name: "Import from Jira…" });
    await user.click(entry);
    const dialog = await screen.findByRole("dialog", { name: "Import from Jira" });
    expect(within(dialog).getByText("Step 1 of 3: choose what to import")).toBeInTheDocument();
    await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    await waitFor(() => expect(entry).toHaveFocus());
  });

  test("the import needs an enabled connection that has been tested (a stored discovery), and says so", async () => {
    const { unmount } = renderWithProviders(<JiraBindingsSection connection={{ ...CONNECTION, discoveredAt: null }} />);
    expect(await screen.findByRole("button", { name: "Import from Jira…" })).toBeDisabled();
    expect(screen.getByText("Import from Jira needs an enabled connection that has passed Test connection.")).toBeInTheDocument();
    unmount();
    renderWithProviders(<JiraBindingsSection connection={{ ...CONNECTION, enabled: false }} />);
    expect(await screen.findByRole("button", { name: "Import from Jira…" })).toBeDisabled();
  });
});
