import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { QueryClient } from "@tanstack/react-query";
import userEvent from "@testing-library/user-event";
import { screen, waitFor, within } from "@testing-library/react";
import JiraBindingsSection from "./JiraBindingsSection";
import type { JiraBinding } from "../api/jira";
import type { PlanView } from "../api/plan";
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
let planStatus: number;

const OWNER = { ownerPersonId: 6, ownerName: "Pola Program" };
const PLAN = {
  revision: 3,
  can: { createWorkStream: true },
  workStreams: [
    {
      id: 3,
      name: "Platform",
      endDate: null,
      programs: [{ id: 4, name: "Billing", workStreamId: 3, ...OWNER, projects: [{ id: 7, name: "Invoices", programId: 4, workStreamId: 3, ownerPersonId: 5, ownerName: "Piotr Project" }] }],
    },
  ],
} as unknown as PlanView;
const emptyPage = { items: [], page: 1, pageSize: 50, total: 0 };

beforeEach(() => {
  rows = [binding(1), binding(2, { level: "PROJECT", node: { kind: "PROJECT", id: 7, name: "Invoices", programName: "Billing", workStreamName: "Platform" }, observation: { observedAt: 1, statusCategory: "DONE", summary: "Initiative", gone: true } })];
  deleteStatus = 204;
  planStatus = 200;
  mockFetch = vi.fn((url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    if (method === "DELETE") {
      if (deleteStatus === 204) rows = rows.filter((row) => row.id !== Number(url.split("/").at(-1)));
      return Promise.resolve(deleteStatus === 204 ? new Response(null, { status: 204 }) : jsonResponse(deleteStatus, { title: "x", status: deleteStatus }));
    }
    if (url.startsWith("/api/v1/integrations/jira/bindings?")) return Promise.resolve(jsonResponse(200, { items: rows, page: 1, pageSize: 20, total: rows.length }));
    if (url === "/api/v1/views/plan") return Promise.resolve(planStatus === 200 ? jsonResponse(200, PLAN) : jsonResponse(planStatus, { title: "x", status: planStatus }));
    if (url.startsWith("/api/v1/people?") || url.startsWith("/api/v1/teams?")) return Promise.resolve(jsonResponse(200, emptyPage));
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
  test("a gone link whose probe still read the issue wears the 'Moved out of scope' badge", async () => {
    rows = [binding(1, { observation: { observedAt: 1, statusCategory: "IN_PROGRESS", summary: "Epic 1", gone: true, goneReason: "MOVED_OUT" } })];
    renderWithProviders(<JiraBindingsSection connection={CONNECTION} />);
    const table = await screen.findByRole("table", { name: "Links to plan items" });
    expect(await within(table).findByText("Moved out of scope")).toBeInTheDocument();
    expect(within(table).queryByText("Gone from Jira")).not.toBeInTheDocument();
  });

  test("a moved link shows its current key as the link and 'was' the key it was last read under; an unmoved one shows no 'was'", async () => {
    rows = [
      binding(1, { issueKey: "OUT-6", url: "https://acme.atlassian.net/browse/OUT-6", observation: { observedAt: 1, statusCategory: "IN_PROGRESS", summary: "Epic 1", issueKey: "E2E-10", gone: true, goneReason: "MOVED_OUT" } }),
      binding(2, { observation: { observedAt: 1, statusCategory: "IN_PROGRESS", summary: "Epic 2", issueKey: "E2E-2", gone: false } }),
    ];
    renderWithProviders(<JiraBindingsSection connection={CONNECTION} />);
    const table = await screen.findByRole("table", { name: "Links to plan items" });
    expect(await within(table).findByRole("group", { name: "OUT-6, was E2E-10" })).toBeInTheDocument();
    expect(within(table).getByRole("link", { name: "OUT-6 (opens in Jira)" })).toHaveAttribute("href", "https://acme.atlassian.net/browse/OUT-6");
    expect(within(table).getByText("was E2E-10")).toBeInTheDocument();
    expect(within(table).getAllByText(/^was /)).toHaveLength(1);
  });

  test("a gone link whose probe found the issue inside the connection's projects wears the 'Not listed by Jira' badge", async () => {
    rows = [binding(1, { observation: { observedAt: 1, statusCategory: "IN_PROGRESS", summary: "Epic 1", gone: true, goneReason: "NOT_LISTED" } })];
    renderWithProviders(<JiraBindingsSection connection={CONNECTION} />);
    const table = await screen.findByRole("table", { name: "Links to plan items" });
    expect(await within(table).findByText("Not listed by Jira")).toBeInTheDocument();
    expect(within(table).queryByText("Gone from Jira")).not.toBeInTheDocument();
    expect(within(table).queryByText("Moved out of scope")).not.toBeInTheDocument();
  });

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

  describe("Import from Jira… on a program or project row (1.15)", () => {
    const programRow = () => binding(3, { level: "PROGRAM", issueKey: "E2E-3", node: { kind: "PROGRAM", id: 4, name: "Billing", workStreamName: "Platform" } });
    const projectRow = () => binding(2, { level: "PROJECT", issueKey: "E2E-2", node: { kind: "PROJECT", id: 7, name: "Invoices", programName: "Billing", workStreamName: "Platform" } });
    const planCalls = () => mockFetch.mock.calls.filter(([url]) => url === "/api/v1/views/plan").length;
    const rowOf = async (name: string) => {
      const table = await screen.findByRole("table", { name: "Links to plan items" });
      return (await within(table).findByText(name)).closest("tr") as HTMLElement;
    };

    test("a program row and a project row have the button, a milestone row has none, and the plan view is read once", async () => {
      rows = [binding(1), projectRow(), programRow()];
      renderWithProviders(<JiraBindingsSection connection={CONNECTION} />);
      const program = await rowOf("Billing");
      expect(await within(program).findByRole("button", { name: "Import from Jira what is listed under Billing" })).toBeInTheDocument();
      expect(within(program).getByRole("button", { name: "Unlink: Billing" })).toBeInTheDocument();
      const project = await rowOf("Invoices");
      expect(await within(project).findByRole("button", { name: "Import from Jira what is listed under Invoices" })).toBeInTheDocument();
      const milestone = await rowOf("Milestone 1");
      expect(within(milestone).queryByRole("button", { name: /^Import from Jira/ })).not.toBeInTheDocument();
      expect(within(milestone).getByRole("button", { name: "Unlink: Milestone 1" })).toBeInTheDocument();
      expect(planCalls()).toBe(1);
    });

    test("the page's own button keeps its name apart from the rows' (an exact name match finds one)", async () => {
      rows = [programRow()];
      renderWithProviders(<JiraBindingsSection connection={CONNECTION} />);
      await screen.findByRole("button", { name: "Import from Jira what is listed under Billing" });
      expect(screen.getAllByRole("button", { name: "Import from Jira…" })).toHaveLength(1);
    });

    test("none while the connection is disabled or untested, and the plan view is not asked", async () => {
      rows = [programRow(), projectRow()];
      const { unmount } = renderWithProviders(<JiraBindingsSection connection={{ ...CONNECTION, discoveredAt: null }} />);
      await rowOf("Billing");
      expect(screen.queryByRole("button", { name: /^Import from Jira what is listed under/ })).not.toBeInTheDocument();
      unmount();
      renderWithProviders(<JiraBindingsSection connection={{ ...CONNECTION, enabled: false }} />);
      await rowOf("Billing");
      expect(screen.queryByRole("button", { name: /^Import from Jira what is listed under/ })).not.toBeInTheDocument();
      expect(planCalls()).toBe(0);
    });

    test("the plan view is asked only when the page shows a program or project row", async () => {
      rows = [binding(1), binding(4)];
      renderWithProviders(<JiraBindingsSection connection={CONNECTION} />);
      await screen.findByText("Milestone 4");
      expect(planCalls()).toBe(0);
    });

    test("a node the plan view does not know has no button, and a failed plan read hides them all without an error", async () => {
      rows = [programRow(), binding(5, { level: "PROJECT", issueKey: "E2E-5", node: { kind: "PROJECT", id: 99, name: "Elsewhere", workStreamName: "Platform" } })];
      const { unmount } = renderWithProviders(<JiraBindingsSection connection={CONNECTION} />);
      const program = await rowOf("Billing");
      expect(await within(program).findByRole("button", { name: /^Import from Jira what is listed under Billing/ })).toBeInTheDocument();
      const elsewhere = await rowOf("Elsewhere");
      expect(within(elsewhere).queryByRole("button", { name: /^Import from Jira/ })).not.toBeInTheDocument();
      unmount();
      planStatus = 500;
      const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
      renderWithProviders(<JiraBindingsSection connection={CONNECTION} />, { queryClient });
      await rowOf("Billing");
      await waitFor(() => expect(queryClient.getQueryState(["plan", "view"])?.status).toBe("error"));
      expect(screen.queryByRole("button", { name: /^Import from Jira what is listed under/ })).not.toBeInTheDocument();
      expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    });

    test("it opens the import rooted at the row: the note, this connection, the node's own owner; Cancel returns the focus to the row's button", async () => {
      rows = [programRow()];
      const user = userEvent.setup();
      renderWithProviders(<JiraBindingsSection connection={CONNECTION} />);
      const entry = await screen.findByRole("button", { name: "Import from Jira what is listed under Billing" });
      await user.click(entry);
      const dialog = await screen.findByRole("dialog", { name: "Import from Jira" });
      expect(await within(dialog).findByText("Importing what Jira lists under E2E-3 into the program “Billing”: its projects and their milestones.")).toBeInTheDocument();
      expect(within(dialog).getByRole("combobox", { name: /^Jira connection/ })).toHaveValue("Acme Jira");
      await waitFor(() => expect(within(dialog).getByRole("combobox", { name: "Owner of the new items" })).toHaveValue("Pola Program"));
      await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
      await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
      await waitFor(() => expect(entry).toHaveFocus());
    });

    test("a project row opens the project-rooted note, and a gone observation opens with the 'cannot be used' note", async () => {
      rows = [binding(2, { level: "PROJECT", issueKey: "E2E-2", node: { kind: "PROJECT", id: 7, name: "Invoices", programName: "Billing", workStreamName: "Platform" }, observation: { observedAt: 1, statusCategory: "DONE", summary: "Initiative", gone: true } })];
      const user = userEvent.setup();
      renderWithProviders(<JiraBindingsSection connection={CONNECTION} />);
      await user.click(await screen.findByRole("button", { name: "Import from Jira what is listed under Invoices" }));
      const dialog = await screen.findByRole("dialog", { name: "Import from Jira" });
      expect(await within(dialog).findByText("Importing what Jira lists under E2E-2 into the project “Invoices”: its milestones.")).toBeInTheDocument();
      expect(within(dialog).getByText(/^The Jira link of this item cannot be used to import from/)).toBeInTheDocument();
      expect(within(dialog).getByRole("button", { name: "Preview" })).toBeDisabled();
    });
  });
});
