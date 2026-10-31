import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import userEvent from "@testing-library/user-event";
import { screen, waitFor, within } from "@testing-library/react";
import { Route, Routes, useLocation } from "react-router-dom";
import People from "./People";
import { jsonResponse } from "../test/http";
import { renderWithProviders } from "../test/render";

const TOKEN_KEY = "astrolabe.auth.token";
const ROLES_KEY = "astrolabe.auth.roles";

type FetchMock = ReturnType<typeof vi.fn>;

const PAGE = {
  items: [
    { id: 1, name: "Anna Nowak", email: "anna@example.com", userId: 7, userEmail: "anna.login@example.com", createdAt: 1, updatedAt: 2 },
    { id: 2, name: "Piotr Zielinski", email: null, userId: null, userEmail: null, createdAt: 1, updatedAt: 2 },
  ],
  page: 1,
  pageSize: 20,
  total: 2,
};
const USERS = {
  items: [
    { id: 7, name: "Anna Login", email: "anna.login@example.com", roles: [], disabledFeatures: [], language: "en" },
    { id: 12, name: "Cara New", email: "cara@example.com", roles: [], disabledFeatures: [], language: "en" },
  ],
  page: 1,
  pageSize: 50,
  total: 2,
};

function serve(mockFetch: FetchMock, mutations: Record<string, { status: number; body?: unknown }> = {}) {
  mockFetch.mockImplementation((url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    const m = mutations[`${method} ${url}`];
    if (m) return Promise.resolve(m.body === undefined ? new Response(null, { status: m.status }) : jsonResponse(m.status, m.body));
    if (method === "GET" && url.startsWith("/api/v1/people?")) return Promise.resolve(jsonResponse(200, PAGE));
    if (method === "GET" && url.startsWith("/api/v1/users?")) return Promise.resolve(jsonResponse(200, USERS));
    if (method === "GET" && url === "/api/v1/users/7") return Promise.resolve(jsonResponse(200, USERS.items[0]));
    return Promise.resolve(jsonResponse(404, { title: "x", status: 404 }));
  });
}

function findCall(mockFetch: FetchMock, method: string, url: string) {
  return mockFetch.mock.calls.find(([u, init]) => ((init as RequestInit | undefined)?.method ?? "GET") === method && u === url);
}

function bodyOf(mockFetch: FetchMock, method: string, url: string) {
  return JSON.parse((findCall(mockFetch, method, url)![1] as RequestInit).body as string);
}

function Probe() {
  const { pathname } = useLocation();
  return <p>at {pathname}</p>;
}

function renderPage() {
  return renderWithProviders(
    <Routes>
      <Route path="/people" element={<People />} />
      <Route path="/people/:id" element={<Probe />} />
    </Routes>,
    { route: "/people" },
  );
}

describe("People page", () => {
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

  test("a regular user gets the read-only list, emails and logins included, with the names as links", async () => {
    localStorage.setItem(ROLES_KEY, "[]");
    serve(mockFetch);
    renderPage();
    expect(await screen.findByRole("link", { name: "Open person Anna Nowak" })).toHaveAttribute("href", "/people/1");
    expect(screen.getByText("anna@example.com")).toBeInTheDocument();
    expect(screen.getByText("anna.login@example.com")).toBeInTheDocument();
    expect(screen.getByRole("columnheader", { name: "Login" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /new person/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /operations for/i })).not.toBeInTheDocument();
    // The read-only list never opens the editor, so it never runs the ADMIN-only users search.
    expect(mockFetch.mock.calls.some(([url]) => typeof url === "string" && url.startsWith("/api/v1/users"))).toBe(false);
  });

  test("the empty state spans every column", async () => {
    mockFetch.mockImplementation(() => Promise.resolve(jsonResponse(200, { ...PAGE, items: [], total: 0 })));
    renderPage();
    const empty = await screen.findByText("No people yet");
    expect(empty.closest("td")).toHaveAttribute("colspan", String(screen.getAllByRole("columnheader").length));
  });

  test("an admin creates a person with a login and lands on their page", async () => {
    serve(mockFetch, {
      "POST /api/v1/people": { status: 201, body: { id: 9, name: "Ola", email: "ola@example.com", userId: 12, userEmail: "cara@example.com", createdAt: 1, updatedAt: 2 } },
    });
    const user = userEvent.setup();
    renderPage();
    await user.click(await screen.findByRole("button", { name: /new person/i }));
    const modal = screen.getByRole("dialog");
    await user.type(within(modal).getByLabelText("Name"), "Ola");
    await user.type(within(modal).getByLabelText("Email"), " ola@example.com ");
    await user.click(within(modal).getByRole("combobox", { name: "Login" }));
    await user.type(within(modal).getByRole("combobox", { name: "Login" }), "cara");
    await user.click(await screen.findByRole("option", { name: "Cara New (cara@example.com)" }));
    await user.click(within(modal).getByRole("button", { name: /^create$/i }));
    await waitFor(() => expect(findCall(mockFetch, "POST", "/api/v1/people")).toBeDefined());
    expect(bodyOf(mockFetch, "POST", "/api/v1/people")).toEqual({ name: "Ola", email: "ola@example.com", userId: 12 });
    expect(await screen.findByText("at /people/9")).toBeInTheDocument();
  });

  test("the email and the login are optional — a bare name posts nulls", async () => {
    serve(mockFetch, {
      "POST /api/v1/people": { status: 201, body: { id: 10, name: "Ext", email: null, userId: null, userEmail: null, createdAt: 1, updatedAt: 2 } },
    });
    const user = userEvent.setup();
    renderPage();
    await user.click(await screen.findByRole("button", { name: /new person/i }));
    const modal = screen.getByRole("dialog");
    await user.type(within(modal).getByLabelText("Name"), "Ext");
    await user.click(within(modal).getByRole("button", { name: /^create$/i }));
    await waitFor(() => expect(findCall(mockFetch, "POST", "/api/v1/people")).toBeDefined());
    expect(bodyOf(mockFetch, "POST", "/api/v1/people")).toEqual({ name: "Ext", email: null, userId: null });
  });

  test("modal validation blocks an empty name and a malformed email", async () => {
    serve(mockFetch);
    const user = userEvent.setup();
    renderPage();
    await user.click(await screen.findByRole("button", { name: /new person/i }));
    const modal = screen.getByRole("dialog");
    await user.type(within(modal).getByLabelText("Email"), "nope");
    await user.click(within(modal).getByRole("button", { name: /^create$/i }));
    expect(await screen.findByText("Name must be 1–100 characters")).toBeInTheDocument();
    expect(screen.getByText("Enter a valid email address")).toBeInTheDocument();
    expect(findCall(mockFetch, "POST", "/api/v1/people")).toBeUndefined();
  });

  test("an admin edits a person — the modal prefills from the row; clearing the login sends null", async () => {
    serve(mockFetch, { "PUT /api/v1/people/1": { status: 204 } });
    const user = userEvent.setup();
    renderPage();
    await user.click(await screen.findByRole("button", { name: "Operations for Anna Nowak" }));
    await user.click(await screen.findByRole("menuitem", { name: "Edit Anna Nowak" }));
    const modal = await screen.findByRole("dialog");
    expect(within(modal).getByLabelText("Name")).toHaveValue("Anna Nowak");
    expect(within(modal).getByLabelText("Email")).toHaveValue("anna@example.com");
    expect(within(modal).getByRole("combobox", { name: "Login" })).toHaveValue("Anna Login (anna.login@example.com)");
    // Mantine marks its clear button aria-hidden (a mouse affordance; the keyboard clears by emptying the box).
    await user.click(within(modal).getByLabelText("Clear the login"));
    await user.click(within(modal).getByRole("button", { name: /^save$/i }));
    await waitFor(() => expect(findCall(mockFetch, "PUT", "/api/v1/people/1")).toBeDefined());
    expect(bodyOf(mockFetch, "PUT", "/api/v1/people/1")).toEqual({ name: "Anna Nowak", email: "anna@example.com", userId: null });
  });

  test("a 409 marks the email field, or the login field when the link is taken", async () => {
    serve(mockFetch, {
      "POST /api/v1/people": { status: 409, body: { title: "Conflict", status: 409, detail: "A person with this email already exists" } },
    });
    const user = userEvent.setup();
    renderPage();
    await user.click(await screen.findByRole("button", { name: /new person/i }));
    const modal = screen.getByRole("dialog");
    await user.type(within(modal).getByLabelText("Name"), "Anna");
    await user.type(within(modal).getByLabelText("Email"), "anna@example.com");
    await user.click(within(modal).getByRole("button", { name: /^create$/i }));
    expect(await screen.findByText("A person with this email already exists")).toBeInTheDocument();
    expect(within(modal).getByLabelText("Email")).toHaveAttribute("aria-invalid", "true");

    serve(mockFetch, {
      "POST /api/v1/people": { status: 409, body: { title: "Conflict", status: 409, detail: "Another person is already linked to this user" } },
    });
    await user.click(within(modal).getByRole("button", { name: /^create$/i }));
    expect(await screen.findByText("Another person is already linked to this login")).toBeInTheDocument();
  });

  test("an admin deletes a person after confirming; a 409 says to reassign first", async () => {
    serve(mockFetch, { "DELETE /api/v1/people/2": { status: 204 }, "DELETE /api/v1/people/1": { status: 409, body: { title: "Conflict", status: 409 } } });
    const user = userEvent.setup();
    renderPage();
    await user.click(await screen.findByRole("button", { name: "Operations for Piotr Zielinski" }));
    await user.click(await screen.findByRole("menuitem", { name: "Delete Piotr Zielinski" }));
    expect(await screen.findByText(/"Piotr Zielinski" will be deleted/)).toBeInTheDocument();
    await user.click(within(screen.getByRole("dialog")).getByRole("button", { name: /^delete$/i }));
    await waitFor(() => expect(findCall(mockFetch, "DELETE", "/api/v1/people/2")).toBeDefined());
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());

    await user.click(screen.getByRole("button", { name: "Operations for Anna Nowak" }));
    await user.click(await screen.findByRole("menuitem", { name: "Delete Anna Nowak" }));
    await user.click(within(await screen.findByRole("dialog")).getByRole("button", { name: /^delete$/i }));
    expect(await screen.findByText(/still owns something or manages a team/)).toBeInTheDocument();
  });

  test("the name filter refetches with name=", async () => {
    serve(mockFetch);
    const user = userEvent.setup();
    renderPage();
    await screen.findByText("anna@example.com");
    await user.click(screen.getByRole("button", { name: /filters/i }));
    await user.type(screen.getByLabelText("Name"), "ann");
    await waitFor(() => expect(mockFetch.mock.calls.some(([url]) => typeof url === "string" && url.includes("name=ann"))).toBe(true));
  });

  test("shows the load-failure alert", async () => {
    mockFetch.mockImplementation(() => Promise.resolve(jsonResponse(500, { title: "boom", status: 500 })));
    renderPage();
    expect(await screen.findByText("Could not load the people")).toBeInTheDocument();
  });
});
