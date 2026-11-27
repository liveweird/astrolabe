import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import userEvent from "@testing-library/user-event";
import { screen, waitFor } from "@testing-library/react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import RoadmapModes from "./RoadmapModes";
import type { ProgramsView } from "../api/programs";
import type { RoadmapView } from "../api/roadmap";
import { forgetRevalidated } from "../api/revalidate";
import i18n from "../i18n";
import { headingOutline } from "../test/headings";
import { routeFetch } from "../test/http";
import { renderWithProviders } from "../test/render";
import { roadmapProject, roadmapView } from "../test/roadmapView";
import { roadmapModePath, roadmapPath } from "../utils/planLinks";

// 1.29: `/roadmap` is one page in two modes. The bodies (Roadmap, Programs) keep their own tests; this one pins what the page itself owns: which mode opens,
// what the browser remembers, what the address says, and the switch.

const MODE_KEY = "astrolabe.viewSettings.roadmap.mode";
const PICK_KEY = "astrolabe.viewSettings.planning.programPick";

const ROADMAP: RoadmapView = roadmapView({ ranked: [{ position: 1, project: roadmapProject({ id: 1, name: "Invoices", rankPosition: 1 }) }] });
const PROGRAMS: ProgramsView = {
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
      span: null,
      flags: { warnings: 0, infos: 0 },
      programs: [{ id: 10, name: "Billing", ownerName: "Pat Program", span: null, flags: { warnings: 0, infos: 0 }, projects: [roadmapProject({ id: 1, name: "Invoices" })] }],
    },
  ],
};

let mockFetch: ReturnType<typeof routeFetch>;
const reads = (path: string) => mockFetch.mock.calls.filter(([url]) => String(url).startsWith(path)).length;

beforeEach(() => {
  mockFetch = routeFetch({
    "GET /api/v1/views/roadmap": ROADMAP,
    "GET /api/v1/views/programs": PROGRAMS,
    "GET /api/v1/baselines": { items: [], can: { manage: false } },
    "GET /api/v1/public-holidays": { items: [] },
  });
  vi.stubGlobal("fetch", mockFetch);
  localStorage.setItem("astrolabe.auth.token", "fake-token");
});

afterEach(async () => {
  vi.unstubAllGlobals();
  forgetRevalidated();
  localStorage.clear();
  await i18n.changeLanguage("en");
});

function Where() {
  const location = useLocation();
  return (
    <>
      <p data-testid="where">{`${location.pathname}${location.search}`}</p>
      <p data-testid="where-hash">{location.hash}</p>
    </>
  );
}
function Back() {
  const navigate = useNavigate();
  return <button onClick={() => navigate(-1)}>back</button>;
}
const renderAt = (route: string) =>
  renderWithProviders(
    <>
      <main id="main-content" tabIndex={-1}>
        <RoadmapModes />
      </main>
      <Back />
      <Where />
      <Link to={roadmapPath}>bare link</Link>
      <Link to={roadmapModePath("overview")}>overview link</Link>
    </>,
    { route },
  );
const where = () => screen.getByTestId("where").textContent;
const whereHash = () => screen.getByTestId("where-hash").textContent;
const prioritizationShown = () => screen.findByText("1 ranked");
const overviewShown = () => screen.findByText("1 work stream");

describe("RoadmapModes: which mode opens", () => {
  test("a first visit opens Prioritization and says so in the address, by replace, remembering nothing", async () => {
    renderAt("/roadmap");
    await prioritizationShown();
    expect(where()).toBe("/roadmap?mode=prioritization");
    expect(reads("/api/v1/views/programs")).toBe(0);
    expect(localStorage.getItem(MODE_KEY)).toBeNull();
    expect(screen.getByRole("radio", { name: "Prioritization" })).toBeChecked();
  });

  test("a bare visit opens the mode last used here and keeps what the address carries", async () => {
    localStorage.setItem(MODE_KEY, JSON.stringify("overview"));
    renderAt("/roadmap?baseline=3&x=1");
    await overviewShown();
    expect(where()).toBe("/roadmap?mode=overview&baseline=3&x=1");
    expect(reads("/api/v1/views/roadmap")).toBe(0);
  });

  test("a remembered value that is not one of the two words is a first visit", async () => {
    localStorage.setItem(MODE_KEY, JSON.stringify("tree"));
    renderAt("/roadmap");
    await prioritizationShown();
    expect(where()).toBe("/roadmap?mode=prioritization");
  });

  test("an address that is not one of the two words (case counts) is bare too", async () => {
    localStorage.setItem(MODE_KEY, JSON.stringify("overview"));
    renderAt("/roadmap?mode=Prioritization");
    await overviewShown();
    expect(where()).toBe("/roadmap?mode=overview");
  });

  test("a bare address naming a filter only Prioritization has opens Prioritization whatever is remembered, and keeps its hash", async () => {
    localStorage.setItem(MODE_KEY, JSON.stringify("overview"));
    renderAt("/roadmap?workStreamId=1&x=1#top");
    await prioritizationShown();
    expect(where()).toBe("/roadmap?mode=prioritization&workStreamId=1&x=1");
    expect(whereHash()).toBe("#top");
  });

  test("a bare address naming only the program pick (both modes read it) still opens the remembered mode", async () => {
    localStorage.setItem(MODE_KEY, JSON.stringify("overview"));
    renderAt("/roadmap?programId=10");
    await overviewShown();
    expect(where()).toBe("/roadmap?mode=overview&programId=10");
  });

  test("a link naming a mode is shown as written and does not change what is remembered", async () => {
    localStorage.setItem(MODE_KEY, JSON.stringify("overview"));
    renderAt("/roadmap?mode=prioritization");
    await prioritizationShown();
    expect(where()).toBe("/roadmap?mode=prioritization");
    expect(localStorage.getItem(MODE_KEY)).toBe(JSON.stringify("overview"));
    expect(screen.getByRole("radio", { name: "Prioritization" })).toBeChecked();
  });

  test("both modes title themselves Roadmap, with the switch in the header", async () => {
    const user = userEvent.setup();
    renderAt("/roadmap?mode=prioritization");
    await prioritizationShown();
    expect(headingOutline()[0]).toEqual([2, "Roadmap"]);
    expect(screen.getByRole("radiogroup", { name: "Roadmap mode" })).toBeInTheDocument();
    await user.click(screen.getByRole("radio", { name: "Roadmap overview" }));
    await overviewShown();
    expect(headingOutline()[0]).toEqual([2, "Roadmap"]);
    expect(screen.getByRole("radiogroup", { name: "Roadmap mode" })).toBeInTheDocument();
  });
});

describe("RoadmapModes: the switch", () => {
  test("a choice is remembered, put in the address as a history entry and keeps the focus on the control", async () => {
    const user = userEvent.setup();
    renderAt("/roadmap?mode=prioritization&programId=10&workStreamId=1&dependencyTeamId=3&x=1");
    await prioritizationShown();
    await user.click(screen.getByRole("radio", { name: "Roadmap overview" }));
    await overviewShown();
    expect(localStorage.getItem(MODE_KEY)).toBe(JSON.stringify("overview"));
    // `mode` first; the filters and the pick (a link's, never stored) are left behind, the dependency panel's parameters and foreign ones stay.
    expect(where()).toBe("/roadmap?mode=overview&dependencyTeamId=3&x=1");
    await waitFor(() => expect(screen.getByRole("radio", { name: "Roadmap overview" })).toHaveFocus());
    await user.click(screen.getByRole("radio", { name: "Prioritization" }));
    await prioritizationShown();
    expect(where()).toBe("/roadmap?mode=prioritization&dependencyTeamId=3&x=1");
    expect(localStorage.getItem(MODE_KEY)).toBe(JSON.stringify("prioritization"));
    await waitFor(() => expect(screen.getByRole("radio", { name: "Prioritization" })).toHaveFocus());
  });

  test("the arrow keys move between the two options like a native radio group", async () => {
    const user = userEvent.setup();
    renderAt("/roadmap?mode=prioritization");
    await prioritizationShown();
    screen.getByRole("radio", { name: "Prioritization" }).focus();
    await user.keyboard("{ArrowRight}");
    await overviewShown();
    expect(where()).toBe("/roadmap?mode=overview");
  });

  test("Back between the modes puts the focus on the main region, and the switch is hidden from print", async () => {
    const user = userEvent.setup();
    renderAt("/roadmap?mode=prioritization");
    await prioritizationShown();
    expect(screen.getByRole("radiogroup", { name: "Roadmap mode" })).toHaveAttribute("data-print", "hide");
    await user.click(screen.getByRole("radio", { name: "Roadmap overview" }));
    await overviewShown();
    await user.click(screen.getByRole("button", { name: "back" }));
    await prioritizationShown();
    await waitFor(() => expect(screen.getByRole("main")).toHaveFocus());
  });

  test("each mode restores its own memory after a switch: the remembered program pick (one shared key) shows in both", async () => {
    const user = userEvent.setup();
    localStorage.setItem(PICK_KEY, JSON.stringify([10]));
    renderAt("/roadmap?mode=prioritization");
    await prioritizationShown();
    await waitFor(() => expect(where()).toBe("/roadmap?mode=prioritization&programId=10"));
    await user.click(screen.getByRole("radio", { name: "Roadmap overview" }));
    await overviewShown();
    await waitFor(() => expect(where()).toBe("/roadmap?mode=overview&programId=10"));
    expect(localStorage.getItem(PICK_KEY)).toBe(JSON.stringify([10]));
  });

  test("a switch leaves the overview's work stream narrowing behind with the filters (it is the address's alone)", async () => {
    const user = userEvent.setup();
    renderAt("/roadmap?mode=overview&workStreamId=1");
    await overviewShown();
    expect(where()).toBe("/roadmap?mode=overview&workStreamId=1");
    await user.click(screen.getByRole("radio", { name: "Prioritization" }));
    await prioritizationShown();
    expect(where()).toBe("/roadmap?mode=prioritization");
  });

  test("a bare link after a choice lands on the chosen mode; a link naming the other mode shows it and leaves the choice", async () => {
    const user = userEvent.setup();
    renderAt("/roadmap?mode=prioritization");
    await prioritizationShown();
    await user.click(screen.getByRole("radio", { name: "Roadmap overview" }));
    await overviewShown();
    await user.click(screen.getByRole("radio", { name: "Prioritization" }));
    await prioritizationShown();
    await user.click(screen.getByRole("link", { name: "overview link" }));
    await overviewShown();
    expect(localStorage.getItem(MODE_KEY)).toBe(JSON.stringify("prioritization"));
    await user.click(screen.getByRole("link", { name: "bare link" }));
    await prioritizationShown();
    expect(where()).toBe("/roadmap?mode=prioritization");
  });
});
