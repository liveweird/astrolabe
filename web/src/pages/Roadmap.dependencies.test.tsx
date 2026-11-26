import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import userEvent from "@testing-library/user-event";
import { screen, waitFor, within } from "@testing-library/react";
import { useLocation } from "react-router-dom";
import Roadmap from "./Roadmap";
import type { RoadmapProject, RoadmapView } from "../api/roadmap";
import { forgetRevalidated } from "../api/revalidate";
import i18n from "../i18n";
import { headingOutline } from "../test/headings";
import { dependencyListView, dependencyRow, violatedRow } from "../test/dependencyList";
import { routeFetch } from "../test/http";
import { planOf } from "../test/planView";
import { renderWithProviders } from "../test/render";

// 1.29: the Roadmap's dependency panel (`PlanDependenciesPanel`, its own tests beside it): its place under the Flags, hidden and unread by default,
// opened by the address, and the roadmap's own address handling (the remembered filters restoring themselves) leaving its parameters alone.

const project = (id: number, name: string, rankPosition: number): RoadmapProject => ({
  jira: null,
  id,
  name,
  programId: 10,
  programName: "Billing",
  workStreamId: 1,
  workStreamName: "Platform",
  ownerPersonId: 5,
  ownerName: "Ola Owner",
  targetStart: null,
  targetEnd: null,
  rankPosition,
  teamIds: [4],
  span: { start: "2026-03-09", end: "2026-04-10" },
  drift: null,
  flags: [],
  can: { editTargetWindow: false },
});

const VIEW: RoadmapView = {
  jiraSites: [],
  revision: 7,
  can: { editRank: false },
  teams: [{ id: 4, name: "Backend" }],
  links: [],
  ranked: [{ position: 1, project: project(1, "Invoices", 1) }],
  unranked: [],
};

let mockFetch: ReturnType<typeof routeFetch>;
const dependencyReads = () => mockFetch.mock.calls.filter(([url]) => String(url).startsWith("/api/v1/views/dependencies")).length;

beforeEach(() => {
  mockFetch = routeFetch({
    "GET /api/v1/views/roadmap": VIEW,
    "GET /api/v1/baselines": { items: [], can: { manage: false } },
    "GET /api/v1/public-holidays": { items: [] },
    "GET /api/v1/views/dependencies": () => dependencyListView([violatedRow({ id: 1 }, 3), dependencyRow({ id: 2 })]),
    "GET /api/v1/views/plan": planOf([{ id: 700, name: "Platform", programs: [{ id: 70, name: "Billing", projects: [{ id: 1, name: "Invoices" }] }] }]),
    "GET /api/v1/teams": { items: [{ id: 4, name: "Backend" }], page: 1, pageSize: 100, total: 1 },
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
const renderAt = (route = "/roadmap") =>
  renderWithProviders(
    <>
      <Roadmap />
      <Where />
    </>,
    { route },
  );

describe("Roadmap page: the dependency panel", () => {
  test("sits after the Flags, hidden: no table, no read, a Show button", async () => {
    renderAt();
    await screen.findByRole("grid", { name: "Roadmap timeline" });
    expect(headingOutline()).toEqual([
      [2, "Roadmap"],
      [3, "Timeline"],
      [3, "Flags"],
      [3, "Dependencies"],
    ]);
    expect(screen.getByRole("button", { name: "Show the dependency list" })).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByRole("table", { name: "Dependencies of the plan" })).toBeNull();
    expect(dependencyReads()).toBe(0);
  });

  test("showing it lists every dependency of the plan, violated first, and leaves the roadmap's address alone", async () => {
    const user = userEvent.setup();
    renderAt("/roadmap?programId=10");
    await screen.findByRole("grid", { name: "Roadmap timeline" });
    await user.click(screen.getByRole("button", { name: "Show the dependency list" }));
    const table = await screen.findByRole("table", { name: "Dependencies of the plan" });
    expect(within(table).getAllByRole("row")).toHaveLength(3);
    expect(dependencyReads()).toBe(1);
    expect(screen.getByTestId("where")).toHaveTextContent("?programId=10");
  });

  test("a link naming the panel opens it while the remembered filters restore themselves into the address: both survive", async () => {
    localStorage.setItem("astrolabe.viewSettings.roadmap.filter.team", "4");
    renderAt("/roadmap?dependencies=violated&dependencyTeamId=4");
    await screen.findByRole("table", { name: "Dependencies of the plan" });
    await waitFor(() => expect(screen.getByTestId("where")).toHaveTextContent("teamId=4"));
    expect(screen.getByTestId("where")).toHaveTextContent("dependencies=violated");
    expect(screen.getByTestId("where")).toHaveTextContent("dependencyTeamId=4");
    expect(screen.getByRole("table", { name: "Dependencies of the plan" })).toBeInTheDocument();
  });

  test("the row menu's Dependencies opens the panel on this address narrowed to the project, keeps the page's own parameters, reads once and puts the focus on the heading", async () => {
    const user = userEvent.setup();
    renderAt("/roadmap?programId=10");
    await screen.findByRole("grid", { name: "Roadmap timeline" });
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
