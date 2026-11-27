import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import userEvent from "@testing-library/user-event";
import { screen, waitFor, within } from "@testing-library/react";
import { Route, Routes } from "react-router-dom";
import PersonDetails from "./PersonDetails";
import { jsonResponse, routeFetch } from "../test/http";
import { renderWithProviders } from "../test/render";
import { clientWithKeptHome, homeReadIsStale } from "../test/home";
import { deferred } from "../test/deferred";
import { headingOutline } from "../test/headings";
import { planOf } from "../test/planView";
import { forgetRevalidated } from "../api/revalidate";
import type { QueryClient } from "@tanstack/react-query";

const TOKEN_KEY = "astrolabe.auth.token";
const ROLES_KEY = "astrolabe.auth.roles";

type FetchMock = ReturnType<typeof routeFetch>;

let mockFetch: FetchMock;

const PERSON = {
  id: 1,
  name: "Anna Nowak",
  email: "anna@example.com",
  userId: 7,
  userEmail: "anna.login@example.com",
  createdAt: 1,
  updatedAt: 2,
};

const NO_TEAMS = { items: [], page: 1, pageSize: 100, total: 0 };

function team(id: number, name: string, managerPersonId: number | null) {
  return { id, name, description: null, managerPersonId, managerName: managerPersonId === null ? null : "Someone", colour: "INDIGO", createdAt: 1, updatedAt: 2 };
}

function stub(table: Parameters<typeof routeFetch>[0]) {
  mockFetch = routeFetch(table);
  vi.stubGlobal("fetch", mockFetch);
}

function serve(mutations: Record<string, { status: number; body?: unknown }> = {}, person: unknown = PERSON) {
  const answers = Object.entries(mutations).map(([route, m]) => [route, m.body === undefined ? new Response(null, { status: m.status }) : jsonResponse(m.status, m.body)]);
  stub({
    "GET /api/v1/people/1": person,
    "GET /api/v1/users/7": { id: 7, name: "Anna Login", email: "anna.login@example.com", roles: [], disabledFeatures: [], language: "en" },
    "GET /api/v1/users": { items: [], page: 1, pageSize: 50, total: 0 },
    "GET /api/v1/views/plan": planOf([]),
    "GET /api/v1/teams": NO_TEAMS,
    ...Object.fromEntries(answers),
  });
}

function findCall(method: string, url: string) {
  return mockFetch.mock.calls.find(([u, init]) => ((init as RequestInit | undefined)?.method ?? "GET") === method && u === url);
}

function renderPage(route = "/people/1", queryClient?: QueryClient) {
  return renderWithProviders(
    <Routes>
      <Route path="/people/:id" element={<PersonDetails />} />
    </Routes>,
    { route, queryClient },
  );
}

describe("PersonDetails page", () => {
  beforeEach(() => {
    localStorage.setItem(TOKEN_KEY, "fake-token");
    localStorage.setItem(ROLES_KEY, JSON.stringify(["ADMIN"]));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    forgetRevalidated();
    localStorage.clear();
  });

  test("a regular user sees the person, email and login, and no admin controls", async () => {
    localStorage.setItem(ROLES_KEY, "[]");
    serve();
    renderPage();
    expect(await screen.findByRole("heading", { level: 2, name: "Anna Nowak" })).toBeInTheDocument();
    expect(screen.getByText(/Email: anna@example\.com/)).toBeInTheDocument();
    expect(screen.getByText(/Login: anna\.login@example\.com/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^About this page/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^edit$/i })).not.toBeInTheDocument();
  });

  test("the Edit action opens the prefilled modal and PUTs", async () => {
    serve({ "PUT /api/v1/people/1": { status: 204 } });
    const user = userEvent.setup();
    const queryClient = clientWithKeptHome();
    renderPage("/people/1", queryClient);
    await user.click(await screen.findByRole("button", { name: /^edit$/i }));
    const modal = await screen.findByRole("dialog");
    expect(within(modal).getByLabelText("Name")).toHaveValue("Anna Nowak");
    await user.type(within(modal).getByLabelText("Name"), " Jr");
    await user.click(within(modal).getByRole("button", { name: /^save$/i }));
    await waitFor(() => expect(findCall("PUT", "/api/v1/people/1")).toBeDefined());
    await waitFor(() => expect(homeReadIsStale(queryClient)).toBe(true));
    const body = JSON.parse((findCall("PUT", "/api/v1/people/1")![1] as RequestInit).body as string);
    expect(body).toEqual({ name: "Anna Nowak Jr", email: "anna@example.com", userId: 7 });
  });

  test("a person without an email or a login says so", async () => {
    serve({}, { ...PERSON, email: null, userId: null, userEmail: null });
    renderPage();
    expect(await screen.findByText(/No email/)).toBeInTheDocument();
    expect(screen.getByText(/No login/)).toBeInTheDocument();
  });

  test("a missing person shows the not-found message with a way back", async () => {
    stub({ "GET /api/v1/people/1": jsonResponse(404, { title: "Not Found", status: 404 }) });
    renderPage();
    expect(await screen.findByText("This person does not exist (or was deleted).")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Back to people" })).toHaveAttribute("href", "/people");
  });

  describe("what the person is responsible for", () => {
    const PLAN = planOf([
      {
        id: 1,
        name: "Platform",
        ownerPersonId: 1,
        programs: [
          { id: 10, name: "Core", ownerPersonId: 2, projects: [{ id: 100, name: "Ledger", ownerPersonId: 1 }, { id: 101, name: "Billing", ownerPersonId: 2 }] },
          { id: 11, name: "Edge", ownerPersonId: 1 },
        ],
      },
      { id: 2, name: "Legacy", ownerPersonId: 1, endDate: "2026-06-30", programs: [] },
      { id: 3, name: "Other", ownerPersonId: 2, programs: [{ id: 30, name: "Side", ownerPersonId: 2, projects: [{ id: 300, name: "Hidden", ownerPersonId: 2 }] }] },
    ]);

    test("lists the teams they manage and the nodes they own, each a link to its page", async () => {
      serve();
      stub({
        "GET /api/v1/people/1": PERSON,
        "GET /api/v1/views/plan": PLAN,
        "GET /api/v1/teams": { items: [team(5, "Payments", 1), team(6, "Identity", 2), team(7, "Search", 1)], page: 1, pageSize: 100, total: 3 },
      });
      renderPage();
      expect(await screen.findByRole("link", { name: "Open team Payments" })).toHaveAttribute("href", "/teams/5");
      expect(screen.getByRole("link", { name: "Open team Search" })).toHaveAttribute("href", "/teams/7");
      expect(screen.queryByRole("link", { name: "Open team Identity" })).not.toBeInTheDocument();

      const streams = await screen.findByRole("list", { name: "Work streams owned" });
      expect(within(streams).getAllByRole("link").map((link) => link.getAttribute("aria-label"))).toEqual(["Open work stream Platform", "Open work stream Legacy (closed)"]);
      expect(within(streams).getByRole("link", { name: "Open work stream Platform" })).toHaveAttribute("href", "/roadmap?mode=overview&workStreamId=1");

      const programs = screen.getByRole("list", { name: "Programs owned" });
      expect(within(programs).getByRole("link", { name: "Open program Edge" })).toBeInTheDocument();
      expect(within(programs).getByRole("link", { name: "Open work stream Platform" })).toBeInTheDocument();

      const projects = screen.getByRole("list", { name: "Projects owned" });
      expect(within(projects).getByRole("link", { name: "Open project Ledger" })).toHaveAttribute("href", "/projects/100");
      expect(within(projects).getByRole("link", { name: "Open program Core" })).toBeInTheDocument();
      expect(within(projects).getByRole("link", { name: "Open work stream Platform" })).toBeInTheDocument();
      expect(screen.queryByRole("link", { name: "Open project Billing" })).not.toBeInTheDocument();
      expect(screen.queryByRole("link", { name: "Open project Hidden" })).not.toBeInTheDocument();
      expect(headingOutline()).toEqual([
        [2, "Anna Nowak"],
        [3, "Teams managed"],
        [3, "Work streams owned"],
        [3, "Programs owned"],
        [3, "Projects owned"],
      ]);
    });

    test("a person who manages and owns nothing gets four empty sentences", async () => {
      serve();
      renderPage();
      expect(await screen.findByText("Manages no team")).toBeInTheDocument();
      expect(screen.getByText("Owns no work stream")).toBeInTheDocument();
      expect(screen.getByText("Owns no program")).toBeInTheDocument();
      expect(screen.getByText("Owns no project")).toBeInTheDocument();
    });

    test("reads every team, past the first page of the teams read", async () => {
      serve();
      const first = Array.from({ length: 100 }, (_, index) => team(1000 + index, `Team ${index}`, 2));
      stub({
        "GET /api/v1/people/1": PERSON,
        "GET /api/v1/views/plan": planOf([]),
        "GET /api/v1/teams": ({ search }) => (search.includes("page=2") ? { items: [team(5, "Late team", 1)], page: 2, pageSize: 100, total: 101 } : { items: first, page: 1, pageSize: 100, total: 101 }),
      });
      renderPage();
      expect(await screen.findByRole("link", { name: "Open team Late team" })).toBeInTheDocument();
    });

    test("shows a loading state until the two reads answer", async () => {
      const planGate = deferred<unknown>();
      const teamsGate = deferred<unknown>();
      stub({ "GET /api/v1/people/1": PERSON, "GET /api/v1/views/plan": () => planGate.promise, "GET /api/v1/teams": () => teamsGate.promise });
      renderPage();
      expect(await screen.findByRole("heading", { level: 2, name: "Anna Nowak" })).toBeInTheDocument();
      expect(screen.getAllByRole("status", { name: "Loading…" })).toHaveLength(2);
      expect(screen.queryByText("Manages no team")).not.toBeInTheDocument();
      teamsGate.resolve(NO_TEAMS);
      expect(await screen.findByText("Manages no team")).toBeInTheDocument();
      expect(screen.getAllByRole("status", { name: "Loading…" })).toHaveLength(1);
      planGate.resolve(planOf([]));
      expect(await screen.findByText("Owns no project")).toBeInTheDocument();
    });

    test("a failed plan read says so beside the teams, which still list", async () => {
      stub({
        "GET /api/v1/people/1": PERSON,
        "GET /api/v1/views/plan": jsonResponse(500, { title: "Boom", status: 500 }),
        "GET /api/v1/teams": { items: [team(5, "Payments", 1)], page: 1, pageSize: 100, total: 1 },
      });
      renderPage();
      expect(await screen.findByRole("link", { name: "Open team Payments" })).toBeInTheDocument();
      expect(await screen.findByText("Could not load the work streams, programs and projects this person owns")).toBeInTheDocument();
      expect(screen.queryByText("Owns no project")).not.toBeInTheDocument();
    });

    test("a failed teams read says so beside the owned lists, which still list", async () => {
      stub({
        "GET /api/v1/people/1": PERSON,
        "GET /api/v1/views/plan": PLAN,
        "GET /api/v1/teams": jsonResponse(500, { title: "Boom", status: 500 }),
      });
      renderPage();
      expect(await screen.findByRole("link", { name: "Open project Ledger" })).toBeInTheDocument();
      expect(await screen.findByText("Could not load the teams this person manages")).toBeInTheDocument();
      expect(screen.queryByText("Manages no team")).not.toBeInTheDocument();
    });
  });
});
