import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import userEvent from "@testing-library/user-event";
import { screen, waitFor, within } from "@testing-library/react";
import { QueryClient } from "@tanstack/react-query";
import { Route, Routes } from "react-router-dom";
import Baselines from "./Baselines";
import { headingOutline } from "../test/headings";
import { jsonResponse } from "../test/http";
import { renderWithProviders } from "../test/render";

const TOKEN_KEY = "astrolabe.auth.token";

type FetchMock = ReturnType<typeof vi.fn>;

// 2026-11-02 14:30:00 UTC
const TAKEN = Date.UTC(2026, 10, 2, 14, 30);
const ITEMS = [
  { id: 5, name: "Q2 commitment", description: "After replanning", planRevision: 40, createdAt: TAKEN, createdBy: { userId: 1, name: "Ada Admin" }, milestoneCount: 120, projectCount: 12 },
  { id: 4, name: "Q1 commitment", description: null, planRevision: 31, createdAt: TAKEN - 86_400_000, createdBy: null, milestoneCount: 100, projectCount: 10 },
];
const LIST = (manage: boolean, items = ITEMS) => ({ items, can: { manage } });

function serve(mockFetch: FetchMock, opts: { manage?: boolean; items?: typeof ITEMS; mutations?: Record<string, { status: number; body?: unknown }> } = {}) {
  const { manage = true, items = ITEMS, mutations = {} } = opts;
  mockFetch.mockImplementation((url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    const m = mutations[`${method} ${url}`];
    if (m) return Promise.resolve(m.body === undefined ? new Response(null, { status: m.status }) : jsonResponse(m.status, m.body));
    if (method === "GET" && url === "/api/v1/baselines") return Promise.resolve(jsonResponse(200, LIST(manage, items)));
    return Promise.resolve(jsonResponse(404, { title: "x", status: 404 }));
  });
}

const findCall = (mockFetch: FetchMock, method: string, url: string) =>
  mockFetch.mock.calls.find(([u, init]) => ((init as RequestInit | undefined)?.method ?? "GET") === method && u === url);
const listReads = (mockFetch: FetchMock) => mockFetch.mock.calls.filter(([u, init]) => u === "/api/v1/baselines" && ((init as RequestInit | undefined)?.method ?? "GET") === "GET").length;
const bodyOf = (call: unknown[] | undefined) => JSON.parse((call![1] as RequestInit).body as string) as unknown;

function renderPage(queryClient?: QueryClient) {
  return renderWithProviders(
    <Routes>
      <Route path="/baselines" element={<Baselines />} />
      <Route path="/baselines/:id" element={<p>compare page</p>} />
    </Routes>,
    { route: "/baselines", queryClient },
  );
}

describe("Baselines page", () => {
  let mockFetch: FetchMock;

  beforeEach(() => {
    mockFetch = vi.fn();
    vi.stubGlobal("fetch", mockFetch);
    localStorage.setItem(TOKEN_KEY, "fake-token");
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    localStorage.clear();
  });

  test("a reader gets the rows, the name as a link into the comparison, and neither the button nor the row menu", async () => {
    serve(mockFetch, { manage: false });
    renderPage();
    expect(await screen.findByRole("link", { name: "Compare Q2 commitment with the plan" })).toHaveAttribute("href", "/baselines/5");
    expect(screen.getByText("After replanning")).toBeInTheDocument();
    expect(screen.getByText("2026-11-02 14:30")).toBeInTheDocument();
    expect(screen.getByText("Ada Admin")).toBeInTheDocument();
    expect(screen.getByText("40")).toBeInTheDocument();
    expect(screen.getByRole("columnheader", { name: "Taken (UTC)" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Take baseline" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /operations for/i })).not.toBeInTheDocument();
    expect(screen.getByText("2 of 100 baselines")).toBeInTheDocument();
    expect(headingOutline()).toEqual([[2, "Baselines"]]);
  });

  test("the empty state tells a manager what to do and a reader who does", async () => {
    serve(mockFetch, { items: [] });
    renderPage();
    expect(await screen.findByText("No baselines yet")).toBeInTheDocument();
    expect(screen.getByText(/Take a baseline to freeze the plan/)).toBeInTheDocument();
  });

  test("a reader's empty state says who takes baselines", async () => {
    serve(mockFetch, { manage: false, items: [] });
    renderPage();
    expect(await screen.findByText("Administrators and roadmap editors take baselines.")).toBeInTheDocument();
  });

  test("a failed load is an inline alert, not an empty state", async () => {
    mockFetch.mockResolvedValue(jsonResponse(500, { title: "x", status: 500 }));
    renderPage();
    expect(await screen.findByText("Could not load the baselines")).toBeInTheDocument();
    expect(screen.queryByText("No baselines yet")).not.toBeInTheDocument();
  });

  test("a manager takes a baseline: the body is trimmed, a blank description is null, and the list is reloaded", async () => {
    serve(mockFetch, { mutations: { "POST /api/v1/baselines": { status: 201, body: { ...ITEMS[0], id: 6 } } } });
    const user = userEvent.setup();
    renderPage();
    await user.click(await screen.findByRole("button", { name: "Take baseline" }));
    const modal = screen.getByRole("dialog");
    expect(within(modal).getByText(/The copy cannot be changed afterwards/)).toBeInTheDocument();
    await user.type(within(modal).getByLabelText("Name"), "  Q3 commitment ");
    await user.click(within(modal).getByRole("button", { name: "Take baseline" }));
    await waitFor(() => expect(findCall(mockFetch, "POST", "/api/v1/baselines")).toBeDefined());
    expect(bodyOf(findCall(mockFetch, "POST", "/api/v1/baselines"))).toEqual({ name: "Q3 commitment", description: null });
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    // The list is read again (the plan views the revision bump made stale are refreshed by prefix too).
    await waitFor(() => expect(listReads(mockFetch)).toBeGreaterThanOrEqual(2));
  });

  test("an empty name is blocked before any request", async () => {
    serve(mockFetch);
    const user = userEvent.setup();
    renderPage();
    await user.click(await screen.findByRole("button", { name: "Take baseline" }));
    await user.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Take baseline" }));
    expect(await screen.findByText("Name must be 1–100 characters")).toBeInTheDocument();
    expect(findCall(mockFetch, "POST", "/api/v1/baselines")).toBeUndefined();
  });

  test("a name clash marks the name field and keeps the dialog", async () => {
    serve(mockFetch, { mutations: { "POST /api/v1/baselines": { status: 409, body: { title: "Conflict", status: 409 } } } });
    const user = userEvent.setup();
    renderPage();
    await user.click(await screen.findByRole("button", { name: "Take baseline" }));
    const modal = screen.getByRole("dialog");
    await user.type(within(modal).getByLabelText("Name"), "Q1 commitment");
    await user.click(within(modal).getByRole("button", { name: "Take baseline" }));
    expect(await within(modal).findByText("A baseline with this name already exists")).toBeInTheDocument();
  });

  test("the cap's 409 reads 'delete one first' as an alert, not as a name clash", async () => {
    serve(mockFetch, {
      mutations: { "POST /api/v1/baselines": { status: 409, body: { title: "Conflict", status: 409, type: "urn:astrolabe:problem:baseline-limit" } } },
    });
    const user = userEvent.setup();
    renderPage();
    await user.click(await screen.findByRole("button", { name: "Take baseline" }));
    const modal = screen.getByRole("dialog");
    await user.type(within(modal).getByLabelText("Name"), "One too many");
    await user.click(within(modal).getByRole("button", { name: "Take baseline" }));
    expect(await within(modal).findByRole("alert")).toHaveTextContent("The limit of 100 baselines is reached: delete one first");
    expect(within(modal).queryByText("A baseline with this name already exists")).not.toBeInTheDocument();
  });

  test("at the cap the page says so instead of counting", async () => {
    const full = Array.from({ length: 100 }, (_, i) => ({ ...ITEMS[0], id: 1000 - i, name: `b${i}` }));
    serve(mockFetch, { items: full });
    renderPage();
    expect(await screen.findByText("The limit of 100 baselines is reached: delete one first")).toBeInTheDocument();
  });

  test("Rename… prefills the row and PUTs the full replace", async () => {
    serve(mockFetch, { mutations: { "PUT /api/v1/baselines/5": { status: 204 } } });
    const user = userEvent.setup();
    renderPage();
    await user.click(await screen.findByRole("button", { name: "Operations for Q2 commitment" }));
    await user.click(await screen.findByRole("menuitem", { name: "Rename Q2 commitment" }));
    const modal = await screen.findByRole("dialog");
    expect(within(modal).getByLabelText("Name")).toHaveValue("Q2 commitment");
    expect(within(modal).getByLabelText("Description")).toHaveValue("After replanning");
    await user.clear(within(modal).getByLabelText("Name"));
    await user.type(within(modal).getByLabelText("Name"), "Q2 final");
    await user.click(within(modal).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(findCall(mockFetch, "PUT", "/api/v1/baselines/5")).toBeDefined());
    expect(bodyOf(findCall(mockFetch, "PUT", "/api/v1/baselines/5"))).toEqual({ name: "Q2 final", description: "After replanning" });
  });

  test("Delete asks first, then DELETEs and reloads the list", async () => {
    serve(mockFetch, { mutations: { "DELETE /api/v1/baselines/4": { status: 204 } } });
    const user = userEvent.setup();
    renderPage();
    await user.click(await screen.findByRole("button", { name: "Operations for Q1 commitment" }));
    await user.click(await screen.findByRole("menuitem", { name: "Delete Q1 commitment" }));
    const modal = await screen.findByRole("dialog");
    expect(within(modal).getByText(/will be deleted/)).toBeInTheDocument();
    expect(findCall(mockFetch, "DELETE", "/api/v1/baselines/4")).toBeUndefined();
    await user.click(within(modal).getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(findCall(mockFetch, "DELETE", "/api/v1/baselines/4")).toBeDefined());
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  });

  test("deleting a baseline someone else deleted first says so and reloads the list", async () => {
    serve(mockFetch, { mutations: { "DELETE /api/v1/baselines/4": { status: 404, body: { title: "Not found", status: 404 } } } });
    const user = userEvent.setup();
    renderPage();
    await user.click(await screen.findByRole("button", { name: "Operations for Q1 commitment" }));
    await user.click(await screen.findByRole("menuitem", { name: "Delete Q1 commitment" }));
    const modal = await screen.findByRole("dialog");
    await user.click(within(modal).getByRole("button", { name: "Delete" }));
    expect(await within(modal).findByText("This baseline was already deleted — the list was reloaded")).toBeInTheDocument();
    await waitFor(() => expect(listReads(mockFetch)).toBeGreaterThanOrEqual(2));
  });
  test("every write invalidates the list and the plan and roadmap views the revision bump made stale", async () => {
    // The REAL keys: the Plan page, a team/project view (under ["plan"]), the roadmap and the programs view.
    const keys = [["plan", "view"], ["plan", "team", 3], ["roadmap", "view"], ["roadmap", "programs"]] as const;
    const stale = (qc: QueryClient) => keys.map((key) => qc.getQueryState(key)?.isInvalidated);
    const seeded = () => {
      const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
      for (const key of keys) qc.setQueryData(key, { revision: 1 });
      return qc;
    };
    const user = userEvent.setup();

    // take
    serve(mockFetch, { mutations: { "POST /api/v1/baselines": { status: 201, body: { ...ITEMS[0], id: 6 } } } });
    let qc = seeded();
    const first = renderPage(qc);
    await user.click(await screen.findByRole("button", { name: "Take baseline" }));
    await user.type(within(screen.getByRole("dialog")).getByLabelText("Name"), "Q3");
    await user.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Take baseline" }));
    await waitFor(() => expect(stale(qc)).toEqual([true, true, true, true]));
    first.unmount();

    // rename
    mockFetch.mockReset();
    serve(mockFetch, { mutations: { "PUT /api/v1/baselines/5": { status: 204 } } });
    qc = seeded();
    const second = renderPage(qc);
    await user.click(await screen.findByRole("button", { name: "Operations for Q2 commitment" }));
    await user.click(await screen.findByRole("menuitem", { name: "Rename Q2 commitment" }));
    await user.type(within(await screen.findByRole("dialog")).getByLabelText("Name"), " v2");
    await user.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(stale(qc)).toEqual([true, true, true, true]));
    second.unmount();

    // delete
    mockFetch.mockReset();
    serve(mockFetch, { mutations: { "DELETE /api/v1/baselines/4": { status: 204 } } });
    qc = seeded();
    renderPage(qc);
    await user.click(await screen.findByRole("button", { name: "Operations for Q1 commitment" }));
    await user.click(await screen.findByRole("menuitem", { name: "Delete Q1 commitment" }));
    await user.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(stale(qc)).toEqual([true, true, true, true]));
  });

  test("a rename that changes nothing sends no request", async () => {
    serve(mockFetch);
    const user = userEvent.setup();
    renderPage();
    await user.click(await screen.findByRole("button", { name: "Operations for Q1 commitment" }));
    await user.click(await screen.findByRole("menuitem", { name: "Rename Q1 commitment" }));
    await user.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(mockFetch.mock.calls.some(([, init]) => (init as RequestInit | undefined)?.method === "PUT")).toBe(false);
  });

  test("a rename onto an existing name marks the name field and keeps the dialog", async () => {
    serve(mockFetch, { mutations: { "PUT /api/v1/baselines/5": { status: 409, body: { title: "Conflict", status: 409 } } } });
    const user = userEvent.setup();
    renderPage();
    await user.click(await screen.findByRole("button", { name: "Operations for Q2 commitment" }));
    await user.click(await screen.findByRole("menuitem", { name: "Rename Q2 commitment" }));
    const modal = await screen.findByRole("dialog");
    await user.clear(within(modal).getByLabelText("Name"));
    await user.type(within(modal).getByLabelText("Name"), "Q1 commitment");
    await user.click(within(modal).getByRole("button", { name: "Save" }));
    expect(await within(modal).findByText("A baseline with this name already exists")).toBeInTheDocument();
  });

  test("a rename of a baseline deleted elsewhere says so and reloads the list", async () => {
    serve(mockFetch, { mutations: { "PUT /api/v1/baselines/5": { status: 404, body: { title: "Not found", status: 404 } } } });
    const user = userEvent.setup();
    renderPage();
    await user.click(await screen.findByRole("button", { name: "Operations for Q2 commitment" }));
    await user.click(await screen.findByRole("menuitem", { name: "Rename Q2 commitment" }));
    const modal = await screen.findByRole("dialog");
    await user.type(within(modal).getByLabelText("Name"), " v2");
    await user.click(within(modal).getByRole("button", { name: "Save" }));
    expect(await within(modal).findByText("This baseline no longer exists — the list was reloaded")).toBeInTheDocument();
    await waitFor(() => expect(listReads(mockFetch)).toBeGreaterThanOrEqual(2));
  });

  test("a delete the server refuses (403) is told in the dialog, which stays open", async () => {
    serve(mockFetch, { mutations: { "DELETE /api/v1/baselines/4": { status: 403, body: { title: "Forbidden", status: 403 } } } });
    const user = userEvent.setup();
    renderPage();
    await user.click(await screen.findByRole("button", { name: "Operations for Q1 commitment" }));
    await user.click(await screen.findByRole("menuitem", { name: "Delete Q1 commitment" }));
    const modal = await screen.findByRole("dialog");
    await user.click(within(modal).getByRole("button", { name: "Delete" }));
    expect(await within(modal).findByText("Only administrators and roadmap editors can delete baselines")).toBeInTheDocument();
  });
});
