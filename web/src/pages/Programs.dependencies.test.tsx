import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import userEvent from "@testing-library/user-event";
import { screen, waitFor, within } from "@testing-library/react";
import { useLocation } from "react-router-dom";
import Programs from "./Programs";
import type { ProgramsView } from "../api/programs";
import type { RoadmapProject } from "../api/roadmap";
import { forgetRevalidated } from "../api/revalidate";
import i18n from "../i18n";
import { headingOutline } from "../test/headings";
import { dependencyListView, dependencyRow, violatedRow } from "../test/dependencyList";
import { routeFetch } from "../test/http";
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
const renderAt = (route = "/programs") =>
  renderWithProviders(
    <>
      <Programs />
      <Where />
    </>,
    { route },
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
});
