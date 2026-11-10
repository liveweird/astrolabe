import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import userEvent from "@testing-library/user-event";
import { screen, waitFor, within } from "@testing-library/react";
import JiraBindDialog from "./JiraBindDialog";
import type { DeviationConnection } from "../api/deviations";
import { DEV_CONNECTION } from "../test/deviations";
import { jsonResponse } from "../test/http";
import { renderWithProviders } from "../test/render";

const ROLES_KEY = "astrolabe.auth.roles";

const MILESTONES = {
  items: [
    { id: 11, projectId: 2, projectName: "Alpha", name: "Checkout", teamId: 3, teamName: "Backend", estimateMd: 1, description: null, startDate: null, endDate: null, createdAt: 1, updatedAt: 2 },
    { id: 12, projectId: 3, projectName: "Beta", name: "Checkout", teamId: 3, teamName: "Backend", estimateMd: 1, description: null, startDate: null, endDate: null, createdAt: 1, updatedAt: 2 },
  ],
  page: 1,
  pageSize: 50,
  total: 2,
};
const PROJECTS = {
  items: [{ id: 2, programId: 20, programName: "Billing", workStreamId: 200, workStreamName: "Platform", name: "Alpha", description: null, ownerPersonId: 1, ownerName: "O", targetStart: null, targetEnd: null, createdAt: 1, updatedAt: 2 }],
  page: 1,
  pageSize: 50,
  total: 1,
};
const can = { edit: true, delete: true, createProject: true, move: true };
/** Two programs: one the viewer may link and one they may not (the plan view's own `can.edit` is the bind's guard). */
const PLAN = {
  revision: 1,
  workStreams: [
    { id: 200, name: "Platform", programs: [{ id: 20, name: "Billing", workStreamId: 200, can, projects: [] }, { id: 21, name: "Secret", workStreamId: 200, can: { ...can, edit: false }, projects: [] }] },
  ],
};

let mockFetch: ReturnType<typeof vi.fn>;
let connections: readonly DeviationConnection[] | null;
let failed = false;
const retry = vi.fn();
let post: { status: number; body: unknown };

beforeEach(() => {
  connections = [DEV_CONNECTION];
  failed = false;
  retry.mockClear();
  post = { status: 201, body: { id: 90 } };
  mockFetch = vi.fn((url: string, init?: RequestInit) => {
    if (init?.method === "POST") return Promise.resolve(jsonResponse(post.status, post.body));
    if (url === "/api/v1/views/plan") return Promise.resolve(jsonResponse(200, PLAN));
    if (url.startsWith("/api/v1/milestones?")) return Promise.resolve(jsonResponse(200, MILESTONES));
    if (url.startsWith("/api/v1/projects?")) return Promise.resolve(jsonResponse(200, PROJECTS));
    return Promise.resolve(jsonResponse(404, { title: "x", status: 404 }));
  });
  vi.stubGlobal("fetch", mockFetch);
  localStorage.setItem("astrolabe.auth.token", "fake-token");
  localStorage.setItem(ROLES_KEY, JSON.stringify(["USER"]));
});

afterEach(() => {
  vi.unstubAllGlobals();
  localStorage.clear();
});

const posts = () => mockFetch.mock.calls.filter(([, init]) => (init as RequestInit | undefined)?.method === "POST").map(([url, init]) => ({ url: url as string, body: JSON.parse((init as RequestInit).body as string) }));

function renderDialog(props: Partial<React.ComponentProps<typeof JiraBindDialog>> = {}) {
  const onBound = vi.fn(() => Promise.resolve());
  const onClose = vi.fn();
  const result = renderWithProviders(<JiraBindDialog source={{ connections, failed, retry }} onBound={onBound} onClose={onClose} {...props} />);
  return { onBound, onClose, unmount: result.unmount, rerender: result.rerender };
}

describe("JiraBindDialog - a plan owner who is no administrator", () => {
  test("takes its connections from the page (the registry is ADMIN only), preselects the only enabled one and asks the server for nothing but the bind", async () => {
    const user = userEvent.setup();
    const { onBound } = renderDialog({ target: { level: "MILESTONE", id: 11, name: "Checkout page" } });
    const dialog = await screen.findByRole("dialog", { name: "Link to Jira" });
    expect(await within(dialog).findByRole("combobox", { name: "Jira connection" })).toHaveValue("Acme Jira");
    expect(within(dialog).getByRole("textbox", { name: "Plan item" })).toHaveValue("Checkout page");
    expect(mockFetch.mock.calls.some(([url]) => (url as string).includes("/integrations/jira/connections") || (url as string).includes("/views/deviations"))).toBe(false);
    await user.type(within(dialog).getByRole("textbox", { name: "Jira issue key" }), "e2e-3");
    await user.click(within(dialog).getByRole("button", { name: "Link" }));
    await waitFor(() => expect(onBound).toHaveBeenCalled());
    expect(posts()).toEqual([{ url: "/api/v1/integrations/jira/bindings", body: { connectionId: 1, level: "MILESTONE", nodeId: 11, issueKey: "E2E-3" } }]);
  });

  test("offers only enabled connections, lets several be chosen from and marks one whose mapping needs fixing", async () => {
    const user = userEvent.setup();
    connections = [
      DEV_CONNECTION,
      { ...DEV_CONNECTION, id: 2, name: "Off Jira", enabled: false },
      { ...DEV_CONNECTION, id: 3, name: "Broken Jira", mappingOk: false },
    ];
    renderDialog({ target: { level: "PROJECT", id: 7, name: "Invoices" } });
    const dialog = await screen.findByRole("dialog");
    const select = await within(dialog).findByRole("combobox", { name: "Jira connection" });
    expect(select).toHaveValue("");
    await user.click(select);
    expect(await screen.findByRole("option", { name: "Acme Jira" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "Broken Jira (mapping needs fixing)" })).toBeInTheDocument();
    expect(screen.queryByRole("option", { name: "Off Jira" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("option", { name: "Broken Jira (mapping needs fixing)" }));
    expect(within(dialog).getByText(/linking is refused until an administrator fixes it/)).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "Link" })).toBeDisabled();
  });

  test("two enabled connections and none chosen: Submit is disabled and the dialog says why", async () => {
    connections = [DEV_CONNECTION, { ...DEV_CONNECTION, id: 2, name: "Other Jira" }];
    renderDialog({ target: { level: "PROJECT", id: 7, name: "Invoices" } });
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("Choose a connection to link through.")).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "Link" })).toBeDisabled();
  });

  test("a chosen connection that leaves the list is forgotten: the only one left is picked again, several wait for a new pick", async () => {
    const user = userEvent.setup();
    const other = { ...DEV_CONNECTION, id: 2, name: "Other Jira" };
    const third = { ...DEV_CONNECTION, id: 3, name: "Third Jira" };
    connections = [DEV_CONNECTION, other, third];
    const view = renderDialog({ target: { level: "PROJECT", id: 7, name: "Invoices" } });
    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("combobox", { name: "Jira connection" }));
    await user.click(await screen.findByRole("option", { name: "Other Jira" }));
    expect(within(dialog).getByRole("combobox", { name: "Jira connection" })).toHaveValue("Other Jira");
    const rerenderWith = (list: typeof connections) =>
      view.rerender(<JiraBindDialog source={{ connections: list, failed, retry }} target={{ level: "PROJECT", id: 7, name: "Invoices" }} onBound={view.onBound} onClose={view.onClose} />);
    rerenderWith([DEV_CONNECTION, third]);
    expect(within(dialog).getByRole("combobox", { name: "Jira connection" })).toHaveValue("");
    expect(within(dialog).getByText("Choose a connection to link through.")).toBeInTheDocument();
    rerenderWith([DEV_CONNECTION]);
    expect(within(dialog).getByRole("combobox", { name: "Jira connection" })).toHaveValue("Acme Jira");
    expect(within(dialog).queryByText("Choose a connection to link through.")).not.toBeInTheDocument();
  });

  test("a connection list that is not known yet says loading; one that failed says so and retries", async () => {
    const user = userEvent.setup();
    connections = null;
    const loading = renderDialog({ target: { level: "PROJECT", id: 7, name: "Invoices" } });
    expect(await screen.findByText("Loading the Jira connections…")).toBeInTheDocument();
    loading.unmount();
    failed = true;
    renderDialog({ target: { level: "PROJECT", id: 7, name: "Invoices" } });
    expect(await screen.findByText("Could not load the Jira connections")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Retry" }));
    expect(retry).toHaveBeenCalledTimes(1);
  });

  test("with no connection at all it says so, and tells a non-admin that an administrator has to add one", async () => {
    connections = [];
    renderDialog({ target: { level: "PROJECT", id: 7, name: "Invoices" } });
    const dialog = await screen.findByRole("dialog");
    expect(await within(dialog).findByText("No Jira connection has been set up yet.")).toBeInTheDocument();
    expect(within(dialog).getByText("An administrator has to add one first.")).toBeInTheDocument();
    expect(within(dialog).queryByRole("link")).not.toBeInTheDocument();
    expect(within(dialog).queryByRole("button", { name: "Link" })).not.toBeInTheDocument();
  });

  test("an administrator is pointed at the registry; a site with only disabled connections says so", async () => {
    localStorage.setItem(ROLES_KEY, JSON.stringify(["ADMIN"]));
    connections = [];
    const first = renderDialog({ target: { level: "PROJECT", id: 7, name: "Invoices" } });
    const dialog = await screen.findByRole("dialog");
    expect(await within(dialog).findByRole("link", { name: "Add one under Administration, Jira." })).toHaveAttribute("href", "/integrations/jira");
    expect(first.onClose).not.toHaveBeenCalled();
  });

  test("every connection disabled: the dialog says so plainly", async () => {
    connections = [{ ...DEV_CONNECTION, enabled: false }];
    renderDialog({ target: { level: "PROJECT", id: 7, name: "Invoices" } });
    expect(await screen.findByText(/Every Jira connection is disabled/)).toBeInTheDocument();
  });
});

describe("JiraBindDialog - the node pickers", () => {
  test("a milestone is found by name across projects and equal names are told apart by project", async () => {
    const user = userEvent.setup();
    renderDialog();
    const dialog = await screen.findByRole("dialog");
    await within(dialog).findByRole("combobox", { name: "Jira connection" });
    await user.click(within(dialog).getByRole("combobox", { name: "Plan item type" }));
    await user.click(await screen.findByRole("option", { name: "Milestone" }));
    await user.click(within(dialog).getByRole("combobox", { name: "Milestone" }));
    expect(await screen.findByRole("option", { name: "Checkout · Alpha" })).toBeInTheDocument();
    await user.click(screen.getByRole("option", { name: "Checkout · Beta" }));
    await user.type(within(dialog).getByRole("textbox", { name: "Jira issue key" }), "E2E-3");
    await user.click(within(dialog).getByRole("button", { name: "Link" }));
    await waitFor(() => expect(posts()).toHaveLength(1));
    expect(posts()[0].body).toEqual({ connectionId: 1, level: "MILESTONE", nodeId: 12, issueKey: "E2E-3" });
    expect(mockFetch.mock.calls.some(([url]) => (url as string).startsWith("/api/v1/milestones?") && (url as string).includes("sort=name"))).toBe(true);
  });

  test("a project comes from the paged project search", async () => {
    const user = userEvent.setup();
    renderDialog();
    const dialog = await screen.findByRole("dialog");
    await within(dialog).findByRole("combobox", { name: "Jira connection" });
    await user.click(within(dialog).getByRole("combobox", { name: "Project" }));
    await user.click(await screen.findByRole("option", { name: "Alpha · Billing · Platform" }));
    await user.type(within(dialog).getByRole("textbox", { name: "Jira issue key" }), "E2E-1");
    await user.click(within(dialog).getByRole("button", { name: "Link" }));
    await waitFor(() => expect(posts()).toHaveLength(1));
    expect(posts()[0].body).toMatchObject({ level: "PROJECT", nodeId: 2, issueKey: "E2E-1" });
  });

  test("a program comes from the plan view (no list exists) and only the programs the viewer may link are offered", async () => {
    const user = userEvent.setup();
    renderDialog();
    const dialog = await screen.findByRole("dialog");
    await within(dialog).findByRole("combobox", { name: "Jira connection" });
    await user.click(within(dialog).getByRole("combobox", { name: "Plan item type" }));
    await user.click(await screen.findByRole("option", { name: "Program" }));
    await user.click(within(dialog).getByRole("combobox", { name: "Program" }));
    expect(await screen.findByRole("option", { name: "Billing · Platform" })).toBeInTheDocument();
    expect(screen.queryByRole("option", { name: "Secret · Platform" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("option", { name: "Billing · Platform" }));
    await user.type(within(dialog).getByRole("textbox", { name: "Jira issue key" }), "E2E-9");
    await user.click(within(dialog).getByRole("button", { name: "Link" }));
    await waitFor(() => expect(posts()).toHaveLength(1));
    expect(posts()[0].body).toMatchObject({ level: "PROGRAM", nodeId: 20, issueKey: "E2E-9" });
  });

  test("a missing plan item and a malformed key are field errors and nothing is sent", async () => {
    const user = userEvent.setup();
    renderDialog();
    const dialog = await screen.findByRole("dialog");
    await within(dialog).findByRole("combobox", { name: "Jira connection" });
    await user.type(within(dialog).getByRole("textbox", { name: "Jira issue key" }), "nope");
    await user.click(within(dialog).getByRole("button", { name: "Link" }));
    expect(await within(dialog).findByText("Pick a plan item")).toBeInTheDocument();
    expect(within(dialog).getByText("Enter an issue key like ABC-12")).toBeInTheDocument();
    expect(posts()).toEqual([]);
  });
});

describe("JiraBindDialog - one request at a time", () => {
  test("pressing Enter again while the link is in flight sends nothing more", async () => {
    let release!: (response: Response) => void;
    mockFetch.mockImplementation((_url: string, init?: RequestInit) =>
      init?.method === "POST" ? new Promise<Response>((resolve) => (release = resolve)) : Promise.resolve(jsonResponse(404, { title: "x", status: 404 })),
    );
    const user = userEvent.setup();
    const { onBound } = renderDialog({ target: { level: "MILESTONE", id: 11, name: "Checkout page" } });
    const dialog = await screen.findByRole("dialog");
    const key = within(dialog).getByRole("textbox", { name: "Jira issue key" });
    await user.type(key, "E2E-3{Enter}");
    await waitFor(() => expect(posts()).toHaveLength(1));
    await user.type(key, "{Enter}");
    expect(posts()).toHaveLength(1);
    release(jsonResponse(201, { id: 90 }));
    await waitFor(() => expect(onBound).toHaveBeenCalledTimes(1));
  });
});

describe("JiraBindDialog - the server's refusals stay inline with the key kept", () => {
  async function attempt(status: number, body: unknown) {
    post = { status, body };
    const user = userEvent.setup();
    const { onBound } = renderDialog({ target: { level: "MILESTONE", id: 11, name: "Checkout page" } });
    const dialog = await screen.findByRole("dialog");
    await within(dialog).findByRole("combobox", { name: "Jira connection" });
    const key = within(dialog).getByRole("textbox", { name: "Jira issue key" });
    await user.type(key, "E2E-3");
    await user.click(within(dialog).getByRole("button", { name: "Link" }));
    await waitFor(() => expect(posts()).toHaveLength(1));
    return { dialog, key, onBound };
  }

  test("409 already-bound: the server's sentence names the other side under the localized lead", async () => {
    const { dialog, key, onBound } = await attempt(409, { type: "urn:astrolabe:problem:already-bound", title: "Conflict", status: 409, detail: "E2E-3 is already linked to project Invoices" });
    expect(await within(dialog).findByText("Already linked:")).toBeInTheDocument();
    expect(within(dialog).getByText("E2E-3 is already linked to project Invoices")).toBeInTheDocument();
    expect(key).toHaveValue("E2E-3");
    expect(onBound).not.toHaveBeenCalled();
    expect(within(dialog).getByRole("button", { name: "Link" })).toBeEnabled();
  });

  test("400 (out of scope, wrong level, unknown issue) shows the server's sentence", async () => {
    const { dialog, key } = await attempt(400, { title: "Bad Request", status: 400, detail: "ABC-12 is outside the connection's project keys" });
    expect(await within(dialog).findByText("This link was refused:")).toBeInTheDocument();
    expect(within(dialog).getByText("ABC-12 is outside the connection's project keys")).toBeInTheDocument();
    expect(key).toHaveValue("E2E-3");
  });

  test("409 jira-mapping-invalid says an administrator has to fix the mapping", async () => {
    const { dialog } = await attempt(409, { type: "urn:astrolabe:problem:jira-mapping-invalid", title: "Conflict", status: 409, detail: "level 5 is gone" });
    expect(await within(dialog).findByText(/An administrator has to fix it on the connection page/)).toBeInTheDocument();
  });

  test("429 (the per-user bucket) says to wait", async () => {
    const { dialog } = await attempt(429, { title: "Too Many Requests", status: 429 });
    expect(await within(dialog).findByText(/Too many link attempts/)).toBeInTheDocument();
  });

  test("502 lifts Jira's failure code out of the detail and puts it in words", async () => {
    const { dialog } = await attempt(502, { type: "urn:astrolabe:problem:jira-upstream", title: "Bad Gateway", status: 502, detail: "Jira did not answer (TIMEOUT)" });
    expect(await within(dialog).findByText("Jira could not be reached or refused the request:")).toBeInTheDocument();
    expect(within(dialog).getByText(/\(TIMEOUT\)/)).toBeInTheDocument();
  });

  test("404 says the plan item no longer exists", async () => {
    const { dialog } = await attempt(404, { title: "Not Found", status: 404 });
    expect(await within(dialog).findByText("This plan item no longer exists.")).toBeInTheDocument();
  });
});
