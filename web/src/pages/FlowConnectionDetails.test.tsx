import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import userEvent from "@testing-library/user-event";
import { Link, Route, Routes } from "react-router-dom";
import { renderWithProviders, screen, waitFor, within } from "../test/render";
import { jsonResponse } from "../test/http";
import { headingOutline } from "../test/headings";
import { CONNECTION, TEAMS, run } from "../test/flow";
import FlowConnectionDetails from "./FlowConnectionDetails";

const TOKEN_KEY = "astrolabe.auth.token";
const ROLES_KEY = "astrolabe.auth.roles";
const BASE = "/api/v1/integrations/flow/connections/1";
type FetchMock = ReturnType<typeof vi.fn>;

function serve(mockFetch: FetchMock, connection: typeof CONNECTION | null = CONNECTION, teams = TEAMS) {
  mockFetch.mockImplementation((url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    if (url === "/api/v1/integrations/flow/connections/2" && method === "GET") return Promise.resolve(jsonResponse(200, { ...CONNECTION, id: 2, name: "Other Flow" }));
    if (url.startsWith("/api/v1/integrations/flow/connections/2/")) return Promise.resolve(jsonResponse(404, { title: "x", status: 404 }));
    if (url === BASE && method === "GET") return Promise.resolve(connection ? jsonResponse(200, connection) : jsonResponse(404, { title: "Not Found", status: 404 }));
    if (url.startsWith("/api/v1/integrations/flow/teams?")) return Promise.resolve(jsonResponse(200, teams));
    if (url.startsWith("/api/v1/integrations/sync/runs") && method === "GET") return Promise.resolve(jsonResponse(200, { items: [run()] }));
    if (url === `${BASE}` && method === "PUT") return Promise.resolve(new Response(null, { status: 204 }));
    return Promise.resolve(jsonResponse(404, { title: "x", status: 404 }));
  });
}

function renderPage(route = "/integrations/flow/1") {
  return renderWithProviders(
    <Routes>
      <Route
        path="/integrations/flow/:id"
        element={
          <>
            <Link to="/integrations/flow/2">other connection</Link>
            <FlowConnectionDetails />
          </>
        }
      />
      <Route path="/integrations/flow" element={<p>the list</p>} />
    </Routes>,
    { route },
  );
}

describe("Flow connection page", () => {
  let mockFetch: FetchMock;
  beforeEach(() => {
    mockFetch = vi.fn();
    vi.stubGlobal("fetch", mockFetch);
    localStorage.setItem(TOKEN_KEY, "fake-token");
    localStorage.setItem(ROLES_KEY, JSON.stringify(["ADMIN"]));
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    localStorage.clear();
  });

  test("composes the Connection section (facts, runs) and the Teams section, under one h2 with the connection's name", async () => {
    serve(mockFetch);
    renderPage();
    expect(await screen.findByRole("heading", { level: 2, name: "Acme Flow" })).toBeInTheDocument();
    await screen.findByRole("table", { name: "Flow teams" });
    expect(headingOutline()).toEqual([
      [2, "Acme Flow"],
      [3, "Connection"],
      [4, "Recent runs"],
      [3, "Teams"],
    ]);
    const facts = screen.getByRole("table", { name: "Connection facts" });
    expect(within(facts).getByText("A token is stored")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Back to Flow connections" })).toHaveAttribute("href", "/integrations/flow");
    expect(mockFetch.mock.calls.some(([url]) => url === "/api/v1/integrations/flow/teams?connectionId=1")).toBe(true);
  });

  test("before the first run the Teams section says to refresh first", async () => {
    serve(mockFetch, { ...CONNECTION, teamsAt: null }, { connectionId: 1, teamsAt: null, items: [] });
    renderPage();
    expect(await screen.findByText("Refresh the connection first")).toBeInTheDocument();
  });

  test("Edit opens the editor on the connection, and a save re-reads the page", async () => {
    serve(mockFetch);
    const user = userEvent.setup();
    renderPage();
    await user.click(await screen.findByRole("button", { name: "Edit" }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByLabelText("Name")).toHaveValue("Acme Flow");
    const reads = () => mockFetch.mock.calls.filter(([url, init]) => url === BASE && ((init as RequestInit | undefined)?.method ?? "GET") === "GET").length;
    const before = reads();
    await user.click(within(dialog).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    await waitFor(() => expect(reads()).toBeGreaterThan(before));
  });

  test("Cancel closes the editor without writing anything", async () => {
    serve(mockFetch);
    const user = userEvent.setup();
    renderPage();
    await user.click(await screen.findByRole("button", { name: "Edit" }));
    await user.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(mockFetch.mock.calls.some(([, init]) => (init as RequestInit | undefined)?.method === "PUT")).toBe(false);
  });

  test("the page starts over when the route's id changes in place: a test result of one connection never shows under another", async () => {
    serve(mockFetch);
    const user = userEvent.setup();
    renderPage();
    await user.click(await screen.findByRole("button", { name: "Test connection" }));
    // The stored test of connection 1 is not served by this fixture (404 → a failure alert): the point is that it is gone after the switch.
    await screen.findByRole("alert");
    await user.click(screen.getByRole("link", { name: "other connection" }));
    expect(await screen.findByRole("heading", { level: 2, name: "Other Flow" })).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  test("an unknown connection (404) and a malformed id are the not-found alert under the page's title", async () => {
    serve(mockFetch, null);
    const { unmount } = renderPage();
    expect(await screen.findByText("This Flow connection does not exist (or was deleted).")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Back to Flow connections" })).toBeInTheDocument();
    unmount();
    serve(mockFetch);
    renderPage("/integrations/flow/abc");
    expect(await screen.findByText("This Flow connection does not exist (or was deleted).")).toBeInTheDocument();
  });

  test("a failing load (500) is a status-mapped alert, not the not-found sentence", async () => {
    mockFetch.mockResolvedValue(jsonResponse(500, { title: "x", status: 500 }));
    renderPage();
    expect(await screen.findByText(/500/)).toBeInTheDocument();
    expect(screen.queryByText("This Flow connection does not exist (or was deleted).")).not.toBeInTheDocument();
  });
});
