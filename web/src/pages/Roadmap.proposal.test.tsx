import type { ComponentProps } from "react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import userEvent from "@testing-library/user-event";
import { act, screen, waitFor, within } from "@testing-library/react";
import { DndContext } from "@dnd-kit/core";
import Roadmap from "./Roadmap";
import type { RoadmapProject, RoadmapView } from "../api/roadmap";
import { ACCEPT_URL, CHECK_URL, RUN_URL, SAVED_URL } from "../test/crossTeamRun";
import { routeFetch } from "../test/http";
import { DASHBOARDS, INVOICES, RUN, TEAMS, TEAM_LIST } from "../test/overviewRun";
import { renderWithProviders } from "../test/render";
import { roadmapProject, roadmapView } from "../test/roadmapView";
import { localIsoDate } from "../utils/isoDate";

// Prioritization previews a cross-team schedule proposal (1.39): the overview's run on the ranking's own timeline. Propose is a click over the visible projects' teams, the dashed
// bars are the projects' proposed spans, the ranking and the target windows are locked from the request until Discard, Accept works as on the overview, and there is no Save and no saved list.

let dndProps: ComponentProps<typeof DndContext> | null = null;
vi.mock("@dnd-kit/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@dnd-kit/core")>();
  return {
    ...actual,
    DndContext: (props: ComponentProps<typeof actual.DndContext>) => {
      dndProps = props;
      return <actual.DndContext {...props} />;
    },
  };
});
const emit = (name: "onDragStart" | "onDragEnd", event: unknown) => act(() => (dndProps?.[name] as ((e: unknown) => void) | undefined)?.(event));
function dragWindow(project: RoadmapProject, days: number) {
  const active = { id: `bar:window:${project.id}:move`, data: { current: { kind: "move", barId: `window:${project.id}`, label: project.name, start: project.targetStart, end: project.targetEnd } } };
  const event = { active, delta: { x: days * 3, y: 0 }, over: null, activatorEvent: null };
  emit("onDragStart", event);
  emit("onDragEnd", event);
}
/** A row dragged by its handle and released in the gap `slot` of the displayed rows (the Roadmap tests' own helper). */
function dropRow(project: RoadmapProject, position: number, slot: number, count = 4) {
  const dragged = { id: `row:${project.id}`, data: { current: { kind: "row", barId: project.id, label: project.name, position, count } } };
  const zone = { id: "timeline-rows", data: { current: { zoneTop: () => 100, rowBounds: () => ({ left: 0, right: 900, top: 100, bottom: 700 }), rowCount: count } } };
  const event = { active: dragged, delta: { x: 0, y: 0 }, over: zone, activatorEvent: { clientX: 40, clientY: 100 + 36 * slot } };
  act(() => dndProps?.onDragStart?.(event as never));
  act(() => dndProps?.onDragEnd?.(event as never));
}

const RANKED_INVOICES: RoadmapProject = { ...INVOICES, rankPosition: 1 };
const TAXES: RoadmapProject = roadmapProject({ id: 2, name: "Taxes", programId: 10, programName: "Billing", rankPosition: 2, teamIds: [1, 2], span: { start: "2042-05-04", end: "2042-06-05" }, can: { editTargetWindow: true } });
const UNRANKED_DASHBOARDS: RoadmapProject = DASHBOARDS;

let view: RoadmapView;
let rights: { id: number; name: string }[];
let mockFetch: ReturnType<typeof routeFetch>;

const routes = () => ({
  "GET /api/v1/teams": TEAM_LIST,
  "GET /api/v1/views/roadmap": () => view,
  "GET /api/v1/public-holidays": { items: [] },
  "GET /api/v1/baselines": { items: [], can: { manage: false } },
  "GET /api/v1/schedule-proposals/teams": () => ({ items: rights, truncated: false }),
  "POST /api/v1/schedule-proposals": RUN,
  "POST /api/v1/schedule-proposals/check": { teams: [] },
  "POST /api/v1/schedule-proposals/accept": { revision: 13, accepted: [11, 12, 21, 31], skipped: [] },
  "PUT /api/v1/roadmap/ranking": { revision: 8 },
  "PUT /api/v1/projects/:id/target-window": () => new Response(null, { status: 204 }),
});

beforeEach(() => {
  view = roadmapView({ revision: 7, can: { editRank: true }, teams: TEAMS, ranked: [{ position: 1, project: RANKED_INVOICES }, { position: 2, project: TAXES }], unranked: [UNRANKED_DASHBOARDS] });
  rights = TEAMS;
  dndProps = null;
  mockFetch = routeFetch(routes());
  vi.stubGlobal("fetch", mockFetch);
  localStorage.setItem("astrolabe.auth.token", "fake-token");
});

afterEach(() => {
  vi.unstubAllGlobals();
  localStorage.clear();
});

const calls = (method: string, url: string) => mockFetch.mock.calls.filter(([u, init]) => u === url && ((init as RequestInit | undefined)?.method ?? "GET") === method);
const bodies = (method: string, url: string) => calls(method, url).map(([, init]) => JSON.parse((init as RequestInit).body as string) as Record<string, unknown>);
const grid = () => screen.getByRole("grid", { name: "Roadmap timeline" });
const proposeButton = () => screen.getByRole("button", { name: "Propose schedule" });
const proposalBars = () => [...document.querySelectorAll('[data-tone="proposal"]')].map((bar) => bar.getAttribute("aria-label"));
const rowOf = (name: string) => within(grid()).getByRole("link", { name: `Open project ${name}` }).closest('[role="row"]') as HTMLElement;
const handles = () => document.querySelectorAll("[data-row-handle]").length;
const liveText = () => screen.getAllByRole("status").map((region) => region.textContent).join(" | ");
const noteText = () => screen.getAllByRole("note").map((note) => note.textContent).join("|");
const READ_ONLY = "A proposal is open, so the schedule is read-only";

async function opened(route = "/roadmap?mode=prioritization") {
  renderWithProviders(<Roadmap />, { route });
  await screen.findByRole("grid", { name: "Roadmap timeline" });
  await waitFor(() => expect(proposeButton()).toBeEnabled());
}
async function proposed(user: ReturnType<typeof userEvent.setup>, route?: string) {
  await opened(route);
  await user.click(proposeButton());
  await screen.findByRole("heading", { name: "Schedule proposal" });
}

describe("asking for the proposal", () => {
  test("nothing is requested until Propose is clicked; a click asks for every team of the plan when nothing is filtered", async () => {
    const user = userEvent.setup();
    await opened();
    expect(screen.getByText("Proposes dates for the 3 teams that work on the projects shown. Nothing changes until you accept.")).toBeInTheDocument();
    expect(calls("POST", RUN_URL)).toEqual([]);
    expect(proposalBars()).toEqual([]);
    await user.click(proposeButton());
    await screen.findByRole("heading", { name: "Schedule proposal" });
    expect(bodies("POST", RUN_URL)).toEqual([{ asOf: localIsoDate(), teamIds: [1, 2, 3] }]);
    expect(liveText()).toContain("Proposed schedule ready: 4 moves");
    expect(screen.getByText("Dashed bars on the timeline show the proposed dates. The ranking and the target windows stay read-only until you discard the proposal; dependencies can still be edited. Nothing changes until you accept.")).toBeInTheDocument();
  });

  test("a filter narrows the run to the visible projects' teams", async () => {
    const user = userEvent.setup();
    await proposed(user, "/roadmap?mode=prioritization&teamId=3");
    expect(bodies("POST", RUN_URL)).toEqual([{ asOf: localIsoDate(), teamIds: [3] }]);
  });

  test("a chosen team set replaces the page's; the picker is gone while the run is open", async () => {
    const user = userEvent.setup();
    await opened();
    await waitFor(() => expect(document.querySelectorAll(".mantine-MultiSelect-pill").length).toBeGreaterThan(0));
    await user.click(screen.getByRole("combobox", { name: "Teams in the run" }));
    await user.click(await screen.findByRole("option", { name: "Delta" }));
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.getByText(/Proposes dates for the 4 teams you chose/)).toBeInTheDocument());
    await user.click(proposeButton());
    await screen.findByRole("heading", { name: "Schedule proposal" });
    expect(bodies("POST", RUN_URL)).toEqual([{ asOf: localIsoDate(), teamIds: [1, 2, 3, 4] }]);
    expect(screen.queryByRole("combobox", { name: "Teams in the run" })).toBeNull();
  });

  test("more than 50 teams: Propose is off and the line says to narrow the filters", async () => {
    const many = Array.from({ length: 51 }, (_, index) => ({ id: index + 1, name: `Team ${index + 1}` }));
    view = { ...view, teams: many };
    renderWithProviders(<Roadmap />, { route: "/roadmap?mode=prioritization" });
    await screen.findByRole("grid", { name: "Roadmap timeline" });
    expect(await screen.findByText(/The run would cover 51 teams, but a proposal takes at most 50 — narrow the filters or the program pick/)).toBeInTheDocument();
    expect(proposeButton()).toBeDisabled();
  });
});

describe("what the open proposal draws", () => {
  test("a dashed bar on each project row whose span moves, beside the current bar; Prioritization has no program or work stream bars", async () => {
    const user = userEvent.setup();
    await proposed(user);
    expect(proposalBars().sort()).toEqual(["Proposed: Dashboards, 2042-08-10 to 2042-09-11, read-only", "Proposed: Invoices, 2042-03-09 to 2042-04-17, read-only", "Proposed: Taxes, 2042-04-27 to 2042-06-19, read-only"]);
    expect(within(rowOf("Invoices")).getByRole("img", { name: "Invoices, 2042-03-02 to 2042-04-10, read-only" })).toBeInTheDocument();
    expect(screen.getByRole("table", { name: "Projects whose dates would move" })).toBeInTheDocument();
  });

  test("the section sits under the timeline and offers no Save, and no saved proposals are read or listed", async () => {
    const user = userEvent.setup();
    await proposed(user);
    expect(screen.getByRole("button", { name: "Accept selected (4)" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Discard" })).toBeEnabled();
    expect(screen.queryByRole("button", { name: "Save proposal" })).toBeNull();
    expect(screen.queryByRole("heading", { name: /^Saved proposals/ })).toBeNull();
    expect(calls("GET", SAVED_URL)).toEqual([]);
  });

  test("a saved proposal's address parameter is ignored: nothing is read, nothing opens", async () => {
    await opened("/roadmap?mode=prioritization&proposal=5");
    expect(calls("GET", `${SAVED_URL}/5`)).toEqual([]);
    expect(screen.queryByRole("heading", { name: "Schedule proposal" })).toBeNull();
    expect(proposeButton()).toBeEnabled();
  });
});

describe("the ranking and the target windows are locked from the request to Discard", () => {
  test("the handles, the rank and window items and the bands go; a drop or a drag is refused out loud with no write; Discard gives them back", async () => {
    const user = userEvent.setup();
    await opened();
    expect(handles()).toBe(3);
    expect(within(rowOf("Invoices")).getByLabelText("Invoices, target window 2042-02-03 to 2042-03-31")).toHaveAttribute("data-tone", "window");
    expect(rowOf("Dashboards").querySelector("[data-draw-surface]")).not.toBeNull();
    await user.click(proposeButton());
    await screen.findByRole("heading", { name: "Schedule proposal" });
    expect(handles()).toBe(0);
    expect(within(rowOf("Invoices")).getByRole("img", { name: "Invoices, target window 2042-02-03 to 2042-03-31, read-only" })).toBeInTheDocument();
    expect(rowOf("Dashboards").querySelector("[data-draw-surface]")).toBeNull();
    // the menu keeps its links, the critical path and the dependencies, but not the ranking and the windows
    await user.click(screen.getByRole("button", { name: "Operations for Taxes" }));
    expect(await screen.findByRole("menuitem", { name: /Open project Taxes/ })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: "Dependencies of Taxes" })).toBeInTheDocument();
    expect(screen.queryByRole("menuitem", { name: /Move|Unrank|target window/ })).toBeNull();
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("menuitem")).toBeNull());
    // an unranked row's Rank item is gone too
    await user.click(screen.getByRole("button", { name: "Operations for Dashboards" }));
    await screen.findByRole("menuitem", { name: /Open project Dashboards/ });
    expect(screen.queryByRole("menuitem", { name: /^Rank / })).toBeNull();
    await user.keyboard("{Escape}");
    // a drop and a drag that still reach the write paths are refused out loud
    dropRow(TAXES, 2, 0);
    expect(liveText()).toContain(READ_ONLY);
    expect(noteText()).toContain(READ_ONLY);
    dragWindow(RANKED_INVOICES, 7);
    expect(calls("PUT", "/api/v1/roadmap/ranking")).toEqual([]);
    expect(calls("PUT", "/api/v1/projects/1/target-window")).toEqual([]);
    await user.click(screen.getByRole("button", { name: "Discard" }));
    expect(screen.queryByRole("heading", { name: "Schedule proposal" })).toBeNull();
    expect(proposalBars()).toEqual([]);
    expect(handles()).toBe(3);
    expect(within(rowOf("Invoices")).getByLabelText("Invoices, target window 2042-02-03 to 2042-03-31")).toHaveAttribute("data-tone", "window");
    expect(rowOf("Dashboards").querySelector("[data-draw-surface]")).not.toBeNull();
    dropRow(TAXES, 2, 0);
    await waitFor(() => expect(bodies("PUT", "/api/v1/roadmap/ranking")).toEqual([{ projectIds: [2, 1], expectedRevision: 7 }]));
  });

  test("the lock starts with the request, not with the answer", async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    mockFetch = routeFetch({
      ...routes(),
      "POST /api/v1/schedule-proposals": async () => {
        await gate;
        return RUN;
      },
    });
    vi.stubGlobal("fetch", mockFetch);
    const user = userEvent.setup();
    await opened();
    await user.click(proposeButton());
    await waitFor(() => expect(handles()).toBe(0));
    expect(screen.getByText("Asking for a proposal — the ranking and the target windows are read-only until it arrives.")).toBeInTheDocument();
    dropRow(TAXES, 2, 0);
    expect(liveText()).toContain("A save is still running");
    expect(calls("PUT", "/api/v1/roadmap/ranking")).toEqual([]);
    release();
    await screen.findByRole("heading", { name: "Schedule proposal" });
  });
});

describe("what the viewer may accept", () => {
  test("an administrator: every move is ticked and the accept names every team; the run closes and the lock goes", async () => {
    const user = userEvent.setup();
    await proposed(user);
    await user.click(screen.getByRole("button", { name: "Accept selected (4)" }));
    await waitFor(() => expect(bodies("POST", ACCEPT_URL)).toHaveLength(1));
    const [body] = bodies("POST", ACCEPT_URL);
    expect(body).toMatchObject({ expectedRevision: 12, teamIds: [1, 2, 3], acceptTeamIds: [1, 2, 3] });
    expect((body.items as { milestoneId: number }[]).map((item) => item.milestoneId)).toEqual([11, 12, 21, 31]);
    expect(await screen.findAllByText("4 scheduled")).toHaveLength(2);
    expect(screen.queryByRole("heading", { name: "Schedule proposal" })).toBeNull();
    expect(proposalBars()).toEqual([]);
    expect(handles()).toBe(3);
  });

  test("the manager of one run team: only that team's moves are ticked and the accept names that team alone", async () => {
    rights = [TEAMS[1]];
    const user = userEvent.setup();
    await proposed(user);
    expect(screen.getByRole("button", { name: "Accept selected (1)" })).toBeEnabled();
    await user.click(screen.getByRole("button", { name: "Accept selected (1)" }));
    await waitFor(() => expect(bodies("POST", ACCEPT_URL)).toHaveLength(1));
    expect(bodies("POST", ACCEPT_URL)[0]).toMatchObject({ acceptTeamIds: [2] });
  });

  test("a login that manages none previews: no Accept, no check is asked, the bars and the lock stay", async () => {
    rights = [];
    const user = userEvent.setup();
    await proposed(user);
    expect(screen.queryByRole("button", { name: /^Accept selected/ })).toBeNull();
    expect(screen.getByText(/This is a preview/)).toBeInTheDocument();
    expect(proposalBars()).toHaveLength(3);
    expect(handles()).toBe(0);
    expect(calls("POST", CHECK_URL)).toEqual([]);
    expect(calls("POST", ACCEPT_URL)).toEqual([]);
  });
});

describe("what the page leaves out of the run", () => {
  test("projects the filters hide are counted in the filters' own words, and the button clears every filter", async () => {
    const user = userEvent.setup();
    await opened("/roadmap?mode=prioritization&teamId=3");
    await waitFor(() => expect(document.querySelectorAll(".mantine-MultiSelect-pill").length).toBeGreaterThan(0));
    await user.click(screen.getByRole("combobox", { name: "Teams in the run" }));
    await user.click(await screen.findByRole("option", { name: "Alpha" }));
    await user.keyboard("{Escape}");
    await user.click(proposeButton());
    await screen.findByRole("heading", { name: "Schedule proposal" });
    expect(bodies("POST", RUN_URL)).toEqual([{ asOf: localIsoDate(), teamIds: [1, 3] }]);
    expect(screen.getByText("2 of the projects this proposal moves are hidden by the current filters")).toBeInTheDocument();
    expect(within(grid()).queryByRole("link", { name: "Open project Invoices" })).toBeNull();
    await user.click(screen.getByRole("button", { name: "Clear the filters" }));
    await waitFor(() => expect(within(grid()).getByRole("link", { name: "Open project Invoices" })).toBeInTheDocument());
    expect(screen.queryByText(/hidden by the current filters/)).toBeNull();
    expect(screen.queryByRole("button", { name: "Clear the filters" })).toBeNull();
  });

  test("a failed rights read says so only once a run is requested; before that the page carries no note", async () => {
    mockFetch = routeFetch({ ...routes(), "GET /api/v1/schedule-proposals/teams": () => new Response(JSON.stringify({ title: "Boom", status: 500 }), { status: 500, headers: { "Content-Type": "application/json" } }) });
    vi.stubGlobal("fetch", mockFetch);
    const user = userEvent.setup();
    await opened();
    expect(screen.queryByText("Could not read which teams you manage; this is a preview only.")).toBeNull();
    await user.click(proposeButton());
    await screen.findByRole("heading", { name: "Schedule proposal" });
    expect(screen.getByText("Could not read which teams you manage; this is a preview only.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Accept selected/ })).toBeNull();
  });
});
