import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import { onlineManager, QueryClient } from "@tanstack/react-query";
import { Route, Routes, useLocation, useNavigationType } from "react-router-dom";
import ProjectView from "./ProjectView";
import { deferred } from "../test/deferred";
import { headingOutline } from "../test/headings";
import { jsonResponse, routeFetch } from "../test/http";
import type { PlanView } from "../api/plan";
import { planOf } from "../test/planView";
import { renderWithProviders } from "../test/render";

// The bare /projects (1.29): the same page without a project. It waits for the plan view, then opens the remembered project (by replace) or says none is picked.

const clients: QueryClient[] = [];
const newClient = () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  clients.push(client);
  return client;
};
const cached = (plan: PlanView) => {
  const queryClient = newClient();
  queryClient.setQueryData(["plan", "view"], plan);
  return queryClient;
};
const STALE = planOf([{ id: 2, name: "Platform", programs: [{ id: 21, name: "Billing", projects: [{ id: 211, name: "Invoices" }] }] }]);
const spinner = () => document.querySelector(".mantine-Loader-root");

const KEY = "astrolabe.viewSettings.projects.last";
const PLAN = planOf([{ id: 2, name: "Platform", programs: [{ id: 21, name: "Billing", projects: [{ id: 211, name: "Invoices" }, { id: 212, name: "Reports" }] }] }]);

/** The project's page stands in for itself here: where the router landed and how. */
function Landed() {
  const location = useLocation();
  return <p>{`landed at ${location.pathname} by ${useNavigationType()}`}</p>;
}

function renderStart(plan: PlanView | (() => Promise<Response>) = PLAN, queryClient?: QueryClient) {
  vi.stubGlobal("fetch", routeFetch({ "GET /api/v1/views/plan": plan }));
  return renderWithProviders(
    <Routes>
      <Route path="/projects" element={<ProjectView />} />
      <Route path="/projects/:id" element={<Landed />} />
    </Routes>,
    { route: "/projects", queryClient: queryClient ?? newClient() },
  );
}

beforeEach(() => localStorage.setItem("astrolabe.auth.token", "fake-token"));
afterEach(() => {
  // A fetch the offline tests left paused is dropped with its cache, so going back online resumes nothing.
  for (const client of clients.splice(0)) client.clear();
  onlineManager.setOnline(true);
  vi.unstubAllGlobals();
  localStorage.clear();
});

describe("the bare Projects page", () => {
  test("the remembered project the plan holds opens, by replace", async () => {
    localStorage.setItem(KEY, "212");
    renderStart();
    expect(await screen.findByText("landed at /projects/212 by REPLACE")).toBeInTheDocument();
    expect(localStorage.getItem(KEY)).toBe("212");
  });

  test("it waits for the plan view: nothing is decided, and no empty state flashes, before it answers", async () => {
    localStorage.setItem(KEY, "212");
    const answer = deferred<Response>();
    renderStart(() => answer.promise);
    expect(await screen.findByRole("heading", { level: 2, name: "Projects" })).toBeInTheDocument();
    expect(screen.queryByText("No project picked")).not.toBeInTheDocument();
    expect(screen.queryByText(/landed at/)).not.toBeInTheDocument();
    answer.resolve(jsonResponse(200, PLAN));
    expect(await screen.findByText("landed at /projects/212 by REPLACE")).toBeInTheDocument();
  });

  test("a cached plan view that holds the remembered project opens it at once, without waiting for the refetch", async () => {
    localStorage.setItem(KEY, "212");
    renderStart(() => new Promise<Response>(() => undefined), cached(PLAN));
    expect(await screen.findByText("landed at /projects/212 by REPLACE")).toBeInTheDocument();
    expect(localStorage.getItem(KEY)).toBe("212");
  });

  test("a cached plan view that predates the project is not trusted: the page waits for a fresh successful answer, which holds it", async () => {
    localStorage.setItem(KEY, "212");
    const answer = deferred<Response>();
    renderStart(() => answer.promise, cached(STALE));
    expect(await screen.findByRole("heading", { level: 2, name: "Projects" })).toBeInTheDocument();
    expect(screen.queryByText("No project picked")).not.toBeInTheDocument();
    expect(localStorage.getItem(KEY)).toBe("212");
    answer.resolve(jsonResponse(200, PLAN));
    expect(await screen.findByText("landed at /projects/212 by REPLACE")).toBeInTheDocument();
  });

  test("a fresh successful answer that still lacks the remembered project forgets it (a cached plan underneath changes nothing)", async () => {
    localStorage.setItem(KEY, "212");
    renderStart(STALE, cached(STALE));
    expect(await screen.findByText("No project picked")).toBeInTheDocument();
    await waitFor(() => expect(localStorage.getItem(KEY)).toBe("null"));
  });

  test("a failed refetch over a stale cache that lacks the project is a failure and forgets nothing", async () => {
    localStorage.setItem(KEY, "212");
    renderStart(() => Promise.resolve(jsonResponse(500, { title: "Boom", status: 500 })), cached(STALE));
    expect(await screen.findByText("Could not load the project")).toBeInTheDocument();
    expect(screen.queryByText("No project picked")).not.toBeInTheDocument();
    expect(localStorage.getItem(KEY)).toBe("212");
  });

  test("offline with a cached plan: the empty state with the picker and a quiet note, no spinner, nothing forgotten", async () => {
    onlineManager.setOnline(false);
    localStorage.setItem(KEY, "212");
    renderStart(PLAN, cached(STALE));
    expect(await screen.findByText("No project picked")).toBeInTheDocument();
    expect(screen.getByText("The server cannot be reached. The list may be out of date.")).toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "Project" })).toBeInTheDocument();
    expect(spinner()).toBeNull();
    expect(localStorage.getItem(KEY)).toBe("212");
  });

  test("offline without a cache: an alert that the server cannot be reached, no spinner, nothing forgotten", async () => {
    onlineManager.setOnline(false);
    localStorage.setItem(KEY, "212");
    renderStart();
    expect(await screen.findByRole("alert")).toHaveTextContent("The server cannot be reached.");
    expect(spinner()).toBeNull();
    expect(localStorage.getItem(KEY)).toBe("212");
  });

  test("a remembered project the plan no longer holds is forgotten and the empty state says none is picked, with the picker", async () => {
    localStorage.setItem(KEY, "999");
    renderStart();
    expect(await screen.findByText("No project picked")).toBeInTheDocument();
    expect(screen.getByText("Pick a project to see its milestones on the timeline.")).toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "Project" })).toHaveValue("");
    await waitFor(() => expect(localStorage.getItem(KEY)).toBe("null"));
    expect(headingOutline()).toEqual([[2, "Projects"]]);
  });

  test("with nothing remembered the empty state is the same", async () => {
    renderStart();
    expect(await screen.findByText("No project picked")).toBeInTheDocument();
    expect(screen.queryByText(/landed at/)).not.toBeInTheDocument();
  });

  test("a plan with no project at all says so and points to the Plan", async () => {
    localStorage.setItem(KEY, "211");
    renderStart(planOf([{ id: 2, name: "Platform", programs: [{ id: 21, name: "Billing" }] }]));
    expect(await screen.findByText("No projects yet")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Open the plan" })).toHaveAttribute("href", "/plan");
    expect(screen.queryByRole("combobox", { name: "Project" })).not.toBeInTheDocument();
    await waitFor(() => expect(localStorage.getItem(KEY)).toBe("null"));
  });

  test("a plan view that cannot be read is a failure, not an empty plan, and forgets nothing", async () => {
    localStorage.setItem(KEY, "211");
    renderStart(() => Promise.resolve(jsonResponse(500, { title: "Boom", status: 500 })));
    expect(await screen.findByText("Could not load the project")).toBeInTheDocument();
    expect(screen.queryByText("No projects yet")).not.toBeInTheDocument();
    expect(localStorage.getItem(KEY)).toBe("211");
  });
});
