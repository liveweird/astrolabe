import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import userEvent from "@testing-library/user-event";
import { act, screen, waitFor, within } from "@testing-library/react";
import { QueryClient } from "@tanstack/react-query";
import { useLocation } from "react-router-dom";
import Programs from "./Programs";
import type { ProgramsView } from "../api/programs";
import type { RoadmapProject } from "../api/roadmap";
import { forgetRevalidated } from "../api/revalidate";
import { deferred } from "../test/deferred";
import i18n from "../i18n";
import { headingOutline } from "../test/headings";
import { milestonePage } from "../test/milestones";
import { dependencyListView, dependencyRow, violatedRow } from "../test/dependencyList";
import { jsonResponse, routeFetch } from "../test/http";
import { planOf } from "../test/planView";
import { renderWithProviders } from "../test/render";

// 1.29: the dependency panel under the Programs page's timeline (`PlanDependenciesPanel`): the same list as the Roadmap's, hidden and unread by default.

const INVOICES: RoadmapProject = {
  jira: null,
  id: 1,
  name: "Invoices",
  programId: 10,
  programName: "Billing",
  workStreamId: 1,
  workStreamName: "Platform",
  ownerPersonId: 5,
  ownerName: "Ola Owner",
  targetStart: null,
  targetEnd: null,
  rankPosition: null,
  teamIds: [],
  span: { start: "2026-03-02", end: "2026-04-10" },
  drift: null,
  flags: [],
  can: { editTargetWindow: false },
};

const VIEW: ProgramsView = {
  jiraSites: [],
  revision: 9,
  teams: [],
  links: [],
  workStreams: [
    {
      id: 1,
      name: "Platform",
      ownerName: "Sam Stream",
      startDate: "2026-01-05",
      endDate: null,
      span: { start: "2026-03-02", end: "2026-04-10" },
      flags: { warnings: 0, infos: 0 },
      programs: [{ id: 10, name: "Billing", ownerName: "Pat Program", span: { start: "2026-03-02", end: "2026-04-10" }, flags: { warnings: 0, infos: 0 }, projects: [INVOICES] }],
    },
  ],
};

let mockFetch: ReturnType<typeof routeFetch>;
const dependencyReads = () => mockFetch.mock.calls.filter(([url]) => String(url).startsWith("/api/v1/views/dependencies")).length;

beforeEach(() => {
  mockFetch = routeFetch({
    "GET /api/v1/views/programs": VIEW,
    "GET /api/v1/baselines": { items: [], can: { manage: false } },
    "GET /api/v1/public-holidays": { items: [] },
    "GET /api/v1/views/dependencies": () => dependencyListView([violatedRow({ id: 1 }, 3), dependencyRow({ id: 2 })]),
    "GET /api/v1/views/plan": planOf([{ id: 700, name: "Platform", programs: [{ id: 70, name: "Billing", projects: [{ id: 1, name: "Invoices" }] }] }]),
    "GET /api/v1/teams": { items: [], page: 1, pageSize: 100, total: 0 },
  });
  vi.stubGlobal("fetch", mockFetch);
  localStorage.setItem("astrolabe.auth.token", "fake-token");
});

afterEach(async () => {
  vi.unstubAllGlobals();
  forgetRevalidated();
  await i18n.changeLanguage("en");
});

function Where() {
  const location = useLocation();
  return <p data-testid="where">{location.search}</p>;
}
const renderAt = (route = "/programs", queryClient?: QueryClient) =>
  renderWithProviders(
    <>
      <Programs />
      <Where />
    </>,
    { route, queryClient },
  );

describe("Programs page: the dependency panel", () => {
  test("sits under the timeline, hidden: no table, no read, a Show button", async () => {
    renderAt();
    await screen.findByRole("grid");
    expect(headingOutline()).toEqual([
      [2, "Roadmap"],
      [3, "Timeline"],
      [3, "Dependencies"],
    ]);
    expect(screen.getByRole("button", { name: "Show the dependency list" })).toHaveAttribute("aria-expanded", "false");
    expect(dependencyReads()).toBe(0);
  });

  test("showing it lists every dependency of the plan, remembers the choice (the Roadmap's) and leaves the address alone", async () => {
    const user = userEvent.setup();
    renderAt("/programs?programId=10");
    await screen.findByRole("grid");
    await user.click(screen.getByRole("button", { name: "Show the dependency list" }));
    const table = await screen.findByRole("table", { name: "Dependencies of the plan" });
    expect(within(table).getAllByRole("row")).toHaveLength(3);
    expect(localStorage.getItem("astrolabe.viewSettings.roadmap.dependenciesOpen")).toBe("true");
    expect(screen.getByTestId("where")).toHaveTextContent("?programId=10");
  });

  test("an address naming the panel opens it", async () => {
    renderAt("/programs?dependencies=ok");
    const table = await screen.findByRole("table", { name: "Dependencies of the plan" });
    expect(within(table).getAllByRole("row")).toHaveLength(2);
  });

  test("the row menu's Dependencies opens the panel on this address narrowed to the project, keeps the page's own parameters, reads once and puts the focus on the heading", async () => {
    const user = userEvent.setup();
    renderAt("/programs?programId=10");
    await screen.findByRole("grid");
    await user.click(screen.getByRole("button", { name: "Expand all" }));
    await user.click(await screen.findByRole("button", { name: "Operations for Invoices" }));
    await user.click(await screen.findByRole("menuitem", { name: "Dependencies of Invoices" }));
    // The list's links are between other projects, so nothing matches Invoices: the panel is open and says so.
    expect(await screen.findByText("No dependency matches the filters")).toBeInTheDocument();
    expect(screen.getByTestId("where")).toHaveTextContent("?programId=10&dependencies=all&dependencyProjectId=1");
    expect(await screen.findByText("Project: Invoices")).toBeInTheDocument();
    expect(dependencyReads()).toBe(1);
    // The panel opened for this visit only: the memory is untouched.
    expect(localStorage.getItem("astrolabe.viewSettings.roadmap.dependenciesOpen")).toBeNull();
    await waitFor(() => expect(screen.getByRole("heading", { level: 3, name: "Dependencies" })).toHaveFocus());
  });
  // 1.30: the panel reads its own endpoint, so it sits outside the body: the view read's failure hides the tree and nothing else.
  test("a failed view read shows the error alert AND the panel's rows (the address names the panel)", async () => {
    mockFetch = routeFetch({
      "GET /api/v1/views/programs": jsonResponse(500, { title: "Internal error", status: 500 }),
      "GET /api/v1/views/dependencies": () => dependencyListView([violatedRow({ id: 1 }, 3), dependencyRow({ id: 2 })]),
      "GET /api/v1/views/plan": planOf([{ id: 700, name: "Platform", programs: [{ id: 70, name: "Billing", projects: [{ id: 1, name: "Invoices" }] }] }]),
      "GET /api/v1/teams": { items: [], page: 1, pageSize: 100, total: 0 },
    });
    vi.stubGlobal("fetch", mockFetch);
    renderAt("/programs?dependencies=all");
    expect(await screen.findByRole("alert")).toHaveTextContent("Could not load the programs");
    const table = await screen.findByRole("table", { name: "Dependencies of the plan" });
    expect(within(table).getAllByRole("row")).toHaveLength(3);
    expect(screen.queryByRole("grid")).toBeNull();
  });

  test("an open Add dialog survives the view read's recovery (the panel is never remounted)", async () => {
    const user = userEvent.setup();
    let answer: () => Response = () => jsonResponse(500, { title: "Internal error", status: 500 });
    mockFetch = routeFetch({
      "GET /api/v1/views/programs": () => answer(),
      "GET /api/v1/baselines": { items: [], can: { manage: false } },
      "GET /api/v1/public-holidays": { items: [] },
      "GET /api/v1/views/dependencies": () => dependencyListView([dependencyRow({ id: 2 })]),
      "GET /api/v1/views/plan": planOf([{ id: 700, name: "Platform", programs: [{ id: 70, name: "Billing", projects: [{ id: 1, name: "Invoices" }] }] }]),
      "GET /api/v1/teams": { items: [], page: 1, pageSize: 100, total: 0 },
      "GET /api/v1/milestones": milestonePage([]),
    });
    vi.stubGlobal("fetch", mockFetch);
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    renderAt("/programs?dependencies=all", queryClient);
    await screen.findByRole("alert");
    await user.click(await screen.findByRole("button", { name: "Add dependency" }));
    expect(await screen.findByRole("dialog", { name: "Add dependency" })).toBeInTheDocument();
    answer = () => jsonResponse(200, VIEW);
    await act(() => queryClient.refetchQueries({ queryKey: ["roadmap"] }));
    await screen.findByRole("grid");
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByRole("dialog", { name: "Add dependency" })).toBeInTheDocument();
  });

  test("an empty plan has no panel once the view is known", async () => {
    mockFetch = routeFetch({
      "GET /api/v1/views/programs": { ...VIEW, workStreams: [] },
      "GET /api/v1/views/dependencies": () => dependencyListView([]),
      "GET /api/v1/views/plan": planOf([]),
      "GET /api/v1/teams": { items: [], page: 1, pageSize: 100, total: 0 },
    });
    vi.stubGlobal("fetch", mockFetch);
    renderAt("/programs?dependencies=all");
    expect(await screen.findByText("No work streams yet")).toBeInTheDocument();
    // The panel stands (and reads) while the view loads, so a recovery never remounts it; once the plan is known to be empty it goes.
    expect(screen.queryByRole("heading", { level: 3, name: "Dependencies" })).toBeNull();
  });
  // 1.30: the arrival focus waits for the page's own view: the timeline inserted above a focused heading would push it below the fold.
  test("a link naming the panel focuses its heading only once the page's view has arrived, never while only the loading block is above it", async () => {
    const view = deferred<Response>();
    mockFetch = routeFetch({
      "GET /api/v1/views/programs": () => view.promise,
      "GET /api/v1/baselines": { items: [], can: { manage: false } },
      "GET /api/v1/public-holidays": { items: [] },
      "GET /api/v1/views/dependencies": () => dependencyListView([violatedRow({ id: 1 }, 3)]),
      "GET /api/v1/views/plan": planOf([{ id: 700, name: "Platform", programs: [{ id: 70, name: "Billing", projects: [{ id: 1, name: "Invoices" }] }] }]),
      "GET /api/v1/teams": { items: [], page: 1, pageSize: 100, total: 0 },
    });
    vi.stubGlobal("fetch", mockFetch);
    renderAt("/programs?dependencies=violated");
    const heading = await screen.findByRole("heading", { level: 3, name: "Dependencies" });
    await screen.findByRole("table", { name: "Dependencies of the plan" });
    expect(screen.queryByRole("grid")).toBeNull();
    expect(heading).not.toHaveFocus();
    view.resolve(jsonResponse(200, VIEW));
    await screen.findByRole("grid");
    await waitFor(() => expect(heading).toHaveFocus());
  });
});
