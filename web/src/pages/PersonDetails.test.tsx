import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import userEvent from "@testing-library/user-event";
import { screen, waitFor, within } from "@testing-library/react";
import { Route, Routes } from "react-router-dom";
import PersonDetails from "./PersonDetails";
import { jsonResponse } from "../test/http";
import { renderWithProviders } from "../test/render";

const TOKEN_KEY = "astrolabe.auth.token";
const ROLES_KEY = "astrolabe.auth.roles";

type FetchMock = ReturnType<typeof vi.fn>;

const PERSON = {
  id: 1,
  name: "Anna Nowak",
  email: "anna@example.com",
  userId: 7,
  userEmail: "anna.login@example.com",
  createdAt: 1,
  updatedAt: 2,
};

function serve(mockFetch: FetchMock, mutations: Record<string, { status: number; body?: unknown }> = {}, person: unknown = PERSON) {
  mockFetch.mockImplementation((url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    const m = mutations[`${method} ${url}`];
    if (m) return Promise.resolve(m.body === undefined ? new Response(null, { status: m.status }) : jsonResponse(m.status, m.body));
    if (method === "GET" && url === "/api/v1/people/1") return Promise.resolve(jsonResponse(200, person));
    if (method === "GET" && url === "/api/v1/users/7") {
      return Promise.resolve(jsonResponse(200, { id: 7, name: "Anna Login", email: "anna.login@example.com", roles: [], disabledFeatures: [], language: "en" }));
    }
    if (method === "GET" && url.startsWith("/api/v1/users?")) return Promise.resolve(jsonResponse(200, { items: [], page: 1, pageSize: 50, total: 0 }));
    return Promise.resolve(jsonResponse(404, { title: "Not Found", status: 404 }));
  });
}

function findCall(mockFetch: FetchMock, method: string, url: string) {
  return mockFetch.mock.calls.find(([u, init]) => ((init as RequestInit | undefined)?.method ?? "GET") === method && u === url);
}

function renderPage(route = "/people/1") {
  return renderWithProviders(
    <Routes>
      <Route path="/people/:id" element={<PersonDetails />} />
    </Routes>,
    { route },
  );
}

describe("PersonDetails page", () => {
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

  test("a regular user sees the person, email and login, and no admin controls", async () => {
    localStorage.setItem(ROLES_KEY, "[]");
    serve(mockFetch);
    renderPage();
    expect(await screen.findByRole("heading", { level: 2, name: "Anna Nowak" })).toBeInTheDocument();
    expect(screen.getByText("Email: anna@example.com")).toBeInTheDocument();
    expect(screen.getByText("Login: anna.login@example.com")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^edit$/i })).not.toBeInTheDocument();
  });

  test("the Edit action opens the prefilled modal and PUTs", async () => {
    serve(mockFetch, { "PUT /api/v1/people/1": { status: 204 } });
    const user = userEvent.setup();
    renderPage();
    await user.click(await screen.findByRole("button", { name: /^edit$/i }));
    const modal = await screen.findByRole("dialog");
    expect(within(modal).getByLabelText("Name")).toHaveValue("Anna Nowak");
    await user.type(within(modal).getByLabelText("Name"), " Jr");
    await user.click(within(modal).getByRole("button", { name: /^save$/i }));
    await waitFor(() => expect(findCall(mockFetch, "PUT", "/api/v1/people/1")).toBeDefined());
    const body = JSON.parse((findCall(mockFetch, "PUT", "/api/v1/people/1")![1] as RequestInit).body as string);
    expect(body).toEqual({ name: "Anna Nowak Jr", email: "anna@example.com", userId: 7 });
  });

  test("a person without an email or a login says so", async () => {
    serve(mockFetch, {}, { ...PERSON, email: null, userId: null, userEmail: null });
    renderPage();
    expect(await screen.findByText("No email")).toBeInTheDocument();
    expect(screen.getByText("No login")).toBeInTheDocument();
  });

  test("a missing person shows the not-found message with a way back", async () => {
    mockFetch.mockImplementation(() => Promise.resolve(jsonResponse(404, { title: "Not Found", status: 404 })));
    renderPage();
    expect(await screen.findByText("This person does not exist (or was deleted).")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Back to people" })).toHaveAttribute("href", "/people");
  });
});
