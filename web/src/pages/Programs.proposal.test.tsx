import type { ComponentProps } from "react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import userEvent from "@testing-library/user-event";
import { act, screen, waitFor, within } from "@testing-library/react";
import { DndContext } from "@dnd-kit/core";
import { QueryClient } from "@tanstack/react-query";
import Programs from "./Programs";
import { programsViewKey, type ProgramsView } from "../api/programs";
import type { RoadmapProject } from "../api/roadmap";
import { ACCEPT_URL, CHECK_URL, RUN_URL } from "../test/crossTeamRun";
import { headingOutline } from "../test/headings";
import { routeFetch } from "../test/http";
import { DASHBOARDS, INVOICES, REPORTS, RUN, TEAMS, TEAM_LIST, viewOf } from "../test/overviewRun";
import { renderWithProviders } from "../test/render";
import { localIsoDate } from "../utils/isoDate";

// The Roadmap overview previews a cross-team schedule proposal (1.33): the Propose button (a click, never automatic), the dashed bars on the tree, the table of the projects
// that would move, the run's own sections by what the viewer may accept (an administrator, the manager of one run team, a login that manages none), the lock over the target
// windows while a run is requested or open, and the team set the page's pick leaves.

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

let view: ProgramsView;
let rights: { id: number; name: string }[];
let runAnswer: () => unknown;
let checkAnswer: () => unknown;
let mockFetch: ReturnType<typeof routeFetch>;

beforeEach(() => {
  view = viewOf();
  rights = TEAMS;
  runAnswer = () => RUN;
  checkAnswer = () => ({ teams: [] });
  dndProps = null;
  mockFetch = routeFetch({
    "GET /api/v1/teams": TEAM_LIST,
    "GET /api/v1/views/programs": () => view,
    "GET /api/v1/public-holidays": { items: [] },
    "GET /api/v1/baselines": { items: [], can: { manage: false } },
    "GET /api/v1/saved-schedule-proposals": { items: [] },
    "GET /api/v1/schedule-proposals/teams": () => ({ items: rights, truncated: false }),
    "POST /api/v1/schedule-proposals": () => runAnswer(),
    "POST /api/v1/schedule-proposals/check": () => checkAnswer(),
    "POST /api/v1/schedule-proposals/accept": { revision: 13, accepted: [11, 12, 21, 31], skipped: [] },
    "PUT /api/v1/projects/:id/target-window": () => new Response(null, { status: 204 }),
  });
  vi.stubGlobal("fetch", mockFetch);
  localStorage.setItem("astrolabe.auth.token", "fake-token");
});

afterEach(() => {
  vi.unstubAllGlobals();
  localStorage.clear();
});

const bodies = (method: string, url: string) => mockFetch.mock.calls.filter(([u, init]) => u === url && ((init as RequestInit | undefined)?.method ?? "GET") === method).map(([, init]) => JSON.parse((init as RequestInit).body as string) as Record<string, unknown>);
const grid = () => screen.getByRole("grid", { name: "Programs timeline" });
const proposeButton = () => screen.getByRole("button", { name: "Propose schedule" });
const proposalBars = () => [...document.querySelectorAll('[data-tone="proposal"]')].map((bar) => bar.getAttribute("aria-label"));
const rowOf = (name: string) => within(grid()).getByRole("link", { name: `Open project ${name}` }).closest('[role="row"]') as HTMLElement;
const liveText = () => screen.getAllByRole("status").map((region) => region.textContent).join(" | ");

/** The page, with the proposal's team list read and every work stream and program open. */
async function opened(user: ReturnType<typeof userEvent.setup>, route = "/roadmap?mode=overview") {
  renderWithProviders(<Programs />, { route });
  await screen.findByRole("grid", { name: "Programs timeline" });
  await waitFor(() => expect(proposeButton()).toBeEnabled());
  await user.click(screen.getByRole("button", { name: "Expand all" }));
}
async function proposed(user: ReturnType<typeof userEvent.setup>, route?: string) {
  await opened(user, route);
  await user.click(proposeButton());
  await screen.findByRole("heading", { name: "Schedule proposal" });
}

describe("asking for the proposal", () => {
  test("nothing is requested until Propose is clicked; the row says what it would cover", async () => {
    const user = userEvent.setup();
    await opened(user);
    expect(screen.getByText("Proposes dates for the 3 teams that work on the projects shown. Nothing changes until you accept.")).toBeInTheDocument();
    expect(bodies("POST", RUN_URL)).toEqual([]);
    expect(screen.queryByRole("heading", { name: "Schedule proposal" })).toBeNull();
    expect(proposalBars()).toEqual([]);
    await screen.findByRole("heading", { name: "Saved proposals (0)" });
    expect(headingOutline()).toEqual([
      [2, "Roadmap"],
      [3, "Timeline"],
      [3, "Saved proposals (0)"],
      [3, "Dependencies"],
    ]);
  });

  test("Propose waits for the viewer's rights, then asks for every team with a milestone when nothing is narrowed (one click, one request)", async () => {
    const user = userEvent.setup();
    await proposed(user);
    expect(bodies("POST", RUN_URL)).toEqual([{ asOf: localIsoDate(), teamIds: [1, 2, 3] }]);
    expect(screen.getByText(/^Proposal for 3 teams:/)).toHaveTextContent("Proposal for 3 teams: Alpha, Beta, Gamma; other teams' dates are kept.");
    expect(within(screen.getByText(/^Proposal for 3 teams:/)).getAllByRole("link").map((link) => link.getAttribute("aria-label"))).toEqual(["Open team Alpha", "Open team Beta", "Open team Gamma"]);
    expect(proposeButton()).toBeDisabled();
    expect(liveText()).toContain("Proposed schedule ready: 4 moves");
  });

  test("the program pick narrows the team set to the teams of the projects shown", async () => {
    const user = userEvent.setup();
    await proposed(user, "/roadmap?mode=overview&programId=10");
    expect(bodies("POST", RUN_URL)).toEqual([{ asOf: localIsoDate(), teamIds: [1, 2] }]);
  });

  test("a work stream narrowing to a stream with no scheduled team says there is nothing to propose", async () => {
    view = viewOf({ workStreams: [{ ...viewOf().workStreams[0], programs: [{ ...REPORTS, projects: [{ ...DASHBOARDS, teamIds: [] }] }] }] });
    const user = userEvent.setup();
    renderWithProviders(<Programs />, { route: "/roadmap?mode=overview&workStreamId=1" });
    await screen.findByRole("grid", { name: "Programs timeline" });
    expect(await screen.findByText("No team has a milestone on the projects shown, so there is nothing to propose.")).toBeInTheDocument();
    expect(proposeButton()).toBeDisabled();
    await user.click(proposeButton());
    expect(bodies("POST", RUN_URL)).toEqual([]);
  });

  test("more than 50 teams: Propose is off and the line says to narrow the pick", async () => {
    const many = Array.from({ length: 51 }, (_, index) => ({ id: index + 1, name: `Team ${index + 1}` }));
    view = viewOf({ teams: many });
    rights = many;
    renderWithProviders(<Programs />, { route: "/roadmap?mode=overview" });
    await screen.findByRole("grid", { name: "Programs timeline" });
    expect(await screen.findByText("The run would cover 51 teams, but a proposal takes at most 50 — narrow the program or work stream pick, or choose fewer teams.")).toBeInTheDocument();
    expect(proposeButton()).toBeDisabled();
    expect(proposeButton()).toHaveAccessibleDescription("The run would cover 51 teams, but a proposal takes at most 50 — narrow the program or work stream pick, or choose fewer teams.");
    expect(bodies("POST", RUN_URL)).toEqual([]);
  });

  test("while the rights are being read Propose is off and the line says so", async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    mockFetch = routeFetch({
      "GET /api/v1/teams": TEAM_LIST,
      "GET /api/v1/views/programs": () => view,
      "GET /api/v1/public-holidays": { items: [] },
      "GET /api/v1/baselines": { items: [], can: { manage: false } },
      "GET /api/v1/saved-schedule-proposals": { items: [] },
      "GET /api/v1/schedule-proposals/teams": async () => {
        await gate;
        return { items: TEAMS, truncated: false };
      },
    });
    vi.stubGlobal("fetch", mockFetch);
    renderWithProviders(<Programs />, { route: "/roadmap?mode=overview" });
    await screen.findByRole("grid", { name: "Programs timeline" });
    expect(proposeButton()).toBeDisabled();
    expect(proposeButton()).toHaveAccessibleDescription("Checking what you may accept…");
    release();
    await waitFor(() => expect(proposeButton()).toBeEnabled());
    expect(screen.queryByText("Checking what you may accept…")).toBeNull();
  });

  test("Propose waits while the address names a work stream the view does not narrow to yet, then asks for what the page shows", async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    mockFetch = routeFetch({
      "GET /api/v1/teams": TEAM_LIST,
      "GET /api/v1/views/programs": async () => {
        await gate;
        return view;
      },
      "GET /api/v1/public-holidays": { items: [] },
      "GET /api/v1/baselines": { items: [], can: { manage: false } },
      "GET /api/v1/saved-schedule-proposals": { items: [] },
      "GET /api/v1/schedule-proposals/teams": { items: TEAMS, truncated: false },
      "POST /api/v1/schedule-proposals": RUN,
      "POST /api/v1/schedule-proposals/check": { teams: [] },
    });
    vi.stubGlobal("fetch", mockFetch);
    // a cached copy (the plan before work stream 1 existed) shows at once while the fresh read is on its way: the address's stream is not in it
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    queryClient.setQueryData(programsViewKey(null, null), viewOf({ workStreams: [{ ...viewOf().workStreams[0], id: 7, name: "Older", programs: [] }] }));
    renderWithProviders(<Programs />, { route: "/roadmap?mode=overview&workStreamId=1", queryClient });
    await screen.findByRole("grid", { name: "Programs timeline" });
    // once the rights are read, what holds Propose back is the narrowing
    expect(await screen.findByText("Waiting for the work stream the address names…")).toBeInTheDocument();
    expect(proposeButton()).toBeDisabled();
    expect(proposeButton()).toHaveAccessibleDescription("Waiting for the work stream the address names…");
    release();
    await waitFor(() => expect(proposeButton()).toBeEnabled());
    expect(screen.getByText(/Proposes dates for the 3 teams/)).toBeInTheDocument();
  });
});

describe("what the open proposal draws", () => {
  test("dashed bars on the rows whose span moves - projects, programs and the work stream - and a table of the projects that would move", async () => {
    const user = userEvent.setup();
    await proposed(user);
    expect(proposalBars().sort()).toEqual(
      [
        "Proposed: Billing, 2042-03-09 to 2042-06-19, read-only",
        "Proposed: Dashboards, 2042-08-10 to 2042-09-11, read-only",
        "Proposed: Invoices, 2042-03-09 to 2042-04-17, read-only",
        "Proposed: Platform, 2042-03-09 to 2042-09-11, read-only",
        "Proposed: Reports, 2042-08-10 to 2042-09-11, read-only",
        "Proposed: Taxes, 2042-04-27 to 2042-06-19, read-only",
      ].sort(),
    );
    // the current bars stay beside them
    expect(within(rowOf("Invoices")).getByRole("img", { name: "Invoices, 2042-03-02 to 2042-04-10, read-only" })).toBeInTheDocument();
    const table = screen.getByRole("table", { name: "Projects whose dates would move" });
    const cells = within(table).getAllByRole("row").slice(1).map((row) => within(row).getAllByRole("cell").map((cell) => cell.textContent));
    expect(cells).toEqual([
      ["Invoices", "2042-03-02 to 2042-04-10", "2042-03-09 to 2042-04-17", "5 working days later"],
      ["Taxes", "2042-05-04 to 2042-06-05", "2042-04-27 to 2042-06-19", "10 working days later"],
      ["Dashboards", "2042-08-03 to 2042-09-04", "2042-08-10 to 2042-09-11", "5 working days later"],
    ]);
    expect(within(table).getByRole("link", { name: "Open project Taxes" })).toBeInTheDocument();
  });

  test("the bars and the table follow the ticks (1.38): unticking Gamma's only move takes the Dashboards and Reports bars off and the stream's end back to Reports' own, the table keeps its rows, from the server's check", async () => {
    // g1 unticked: the server's answer for the other three moves
    checkAnswer = () => ({ teams: [], projects: RUN.projects.slice(0, 2) });
    const user = userEvent.setup();
    await proposed(user);
    expect(proposalBars()).toHaveLength(6);
    await user.click(screen.getByRole("checkbox", { name: "Accept g1" }));
    await waitFor(() => expect(proposalBars().sort()).toEqual([
      "Proposed: Billing, 2042-03-09 to 2042-06-19, read-only",
      "Proposed: Invoices, 2042-03-09 to 2042-04-17, read-only",
      "Proposed: Platform, 2042-03-09 to 2042-09-04, read-only",
      "Proposed: Taxes, 2042-04-27 to 2042-06-19, read-only",
    ]));
    // the table keeps the run's rows and their order: Dashboards stays, reading "Unchanged" (it sits above the ticks, so nothing jumps under the pointer)
    const cells = () => within(screen.getByRole("table", { name: "Projects whose dates would move" })).getAllByRole("row").slice(1).map((row) => within(row).getAllByRole("cell").map((cell) => cell.textContent));
    expect(cells()).toEqual([
      ["Invoices", "2042-03-02 to 2042-04-10", "2042-03-09 to 2042-04-17", "5 working days later"],
      ["Taxes", "2042-05-04 to 2042-06-05", "2042-04-27 to 2042-06-19", "10 working days later"],
      ["Dashboards", "2042-08-03 to 2042-09-04", "Unchanged", "Would not move"],
    ]);
    // the move's own row stays in the section's table, unticked
    expect(screen.getByRole("checkbox", { name: "Accept g1" })).not.toBeChecked();
    // ticking it again is every move ticked: the run's projects
    await user.click(screen.getByRole("checkbox", { name: "Accept g1" }));
    expect(proposalBars()).toHaveLength(6);
    expect(cells()[2]).toEqual(["Dashboards", "2042-08-03 to 2042-09-04", "2042-08-10 to 2042-09-11", "5 working days later"]);
    // nothing ticked: no project moves, every row stays and says so (the "no project moves" sentence is for a run that moves none)
    for (const all of screen.getAllByRole("checkbox", { name: "Accept all" })) await user.click(all);
    expect(proposalBars()).toEqual([]);
    expect(cells().map((row) => row[3])).toEqual(["Would not move", "Would not move", "Would not move"]);
    expect(screen.queryByText("No project's dates would move.")).toBeNull();
  });

  test("while a newer check is on its way the LAST answered projects stay - nothing flashes back to the whole run between two ticks", async () => {
    checkAnswer = () => ({ teams: [], projects: RUN.projects.slice(0, 2) });
    const user = userEvent.setup();
    await proposed(user);
    await user.click(screen.getByRole("checkbox", { name: "Accept g1" }));
    await waitFor(() => expect(proposalBars()).toHaveLength(4));
    let release: (() => void) | null = null;
    checkAnswer = () => new Promise((resolve) => (release = () => resolve({ teams: [], projects: RUN.projects.slice(0, 1) })));
    await user.click(screen.getByRole("checkbox", { name: "Accept b1" }));
    await waitFor(() => expect(bodies("POST", CHECK_URL)).toHaveLength(2));
    // the answer for the new ticks is held: still the first answer's bars, never the run's six
    expect(proposalBars()).toHaveLength(4);
    expect(release).not.toBeNull();
    await act(async () => (release as unknown as () => void)());
    await waitFor(() => expect(proposalBars().sort()).toEqual([
      "Proposed: Billing, 2042-03-09 to 2042-06-05, read-only",
      "Proposed: Invoices, 2042-03-09 to 2042-04-17, read-only",
      "Proposed: Platform, 2042-03-09 to 2042-09-04, read-only",
    ]));
  });

  test("a manager of one run team previews the whole run: the server's answer covers the ticked moves alone, so the bars do not follow their ticks", async () => {
    rights = [TEAMS[0]];
    checkAnswer = () => ({ teams: [], projects: [] });
    const user = userEvent.setup();
    await proposed(user);
    await user.click(screen.getByRole("checkbox", { name: "Accept a1" }));
    await waitFor(() => expect(bodies("POST", CHECK_URL)).toHaveLength(1));
    expect(bodies("POST", CHECK_URL)[0]).toMatchObject({ items: [{ milestoneId: 12 }] });
    await waitFor(() => expect(screen.queryByText("Checking the ticked moves…")).toBeNull());
    expect(proposalBars()).toHaveLength(6);
    expect(within(screen.getByRole("table", { name: "Projects whose dates would move" })).getAllByRole("row")).toHaveLength(4);
  });

  test("a project the proposal newly schedules or only starts earlier is worded as such; a run that moves no project says so", async () => {
    runAnswer = () => ({
      ...RUN,
      projects: [
        { projectId: 1, name: "Invoices", before: null, after: { start: "2042-03-09", end: "2042-04-17" }, endShiftDays: null },
        { projectId: 2, name: "Taxes", before: { start: "2042-05-04", end: "2042-06-05" }, after: { start: "2042-04-27", end: "2042-06-05" }, endShiftDays: 0 },
      ],
    });
    const user = userEvent.setup();
    await proposed(user);
    const table = screen.getByRole("table", { name: "Projects whose dates would move" });
    const rows = within(table).getAllByRole("row").slice(1).map((row) => within(row).getAllByRole("cell").map((cell) => cell.textContent));
    expect(rows).toEqual([
      ["Invoices", "Unscheduled", "2042-03-09 to 2042-04-17", "Newly scheduled"],
      ["Taxes", "2042-05-04 to 2042-06-05", "2042-04-27 to 2042-06-05", "End unchanged"],
    ]);
    await user.click(screen.getByRole("button", { name: "Discard" }));
    runAnswer = () => ({ ...RUN, projects: [] });
    await user.click(proposeButton());
    expect(await screen.findByText("No project's dates would move.")).toBeInTheDocument();
    expect(screen.queryByRole("table", { name: "Projects whose dates would move" })).toBeNull();
    expect(proposalBars()).toEqual([]);
  });

  test("a run opens on its heading: scrolled to the top and focused (not Discard, the last control), once; Propose again lands on it again", async () => {
    const original = Element.prototype.scrollIntoView;
    const scrolled = vi.fn();
    Element.prototype.scrollIntoView = scrolled as unknown as typeof original;
    try {
      const user = userEvent.setup();
      await proposed(user);
      const heading = screen.getByRole("heading", { level: 3, name: "Schedule proposal" });
      await waitFor(() => expect(heading).toHaveFocus());
      expect(heading).toHaveAttribute("tabindex", "-1");
      expect(scrolled).toHaveBeenCalledTimes(1);
      expect(scrolled).toHaveBeenCalledWith({ block: "start" });
      expect(scrolled.mock.contexts[0]).toBe(heading);
      // a tick leaves the focus where the user put it
      const tick = screen.getAllByRole("checkbox")[0];
      await user.click(tick);
      expect(tick).toHaveFocus();
      expect(scrolled).toHaveBeenCalledTimes(1);
      await user.click(screen.getByRole("button", { name: "Propose again" }));
      await waitFor(() => expect(bodies("POST", RUN_URL)).toHaveLength(2));
      await waitFor(() => expect(scrolled).toHaveBeenCalledTimes(2));
      await waitFor(() => expect(screen.getByRole("heading", { level: 3, name: "Schedule proposal" })).toHaveFocus());
    } finally {
      Element.prototype.scrollIntoView = original;
    }
  });

  test("Discard removes the bars and the section, gives the focus back to Propose and unlocks the page; Propose again is a click, not automatic", async () => {
    const user = userEvent.setup();
    await proposed(user);
    await user.click(screen.getByRole("button", { name: "Propose again" }));
    await waitFor(() => expect(bodies("POST", RUN_URL)).toHaveLength(2));
    await screen.findByRole("heading", { name: "Schedule proposal" });
    await user.click(screen.getByRole("button", { name: "Discard" }));
    expect(screen.queryByRole("heading", { name: "Schedule proposal" })).toBeNull();
    expect(proposalBars()).toEqual([]);
    await waitFor(() => expect(proposeButton()).toHaveFocus());
    expect(bodies("POST", RUN_URL)).toHaveLength(2);
  });
});

describe("the range", () => {
  const trackWidth = () => Math.max(...[...rowOf("Invoices").querySelectorAll('[role="gridcell"]')].map((cell) => parseInt((cell as HTMLElement).style.width, 10) || 0));

  test("covers the proposed spans of the shown projects only; the table still lists every project the run moves", async () => {
    const far = { projectId: 3, name: "Dashboards", before: { start: "2042-08-03", end: "2042-09-04" }, after: { start: "2060-01-05", end: "2060-02-02" }, endShiftDays: 900 };
    runAnswer = () => ({ ...RUN, projects: [...RUN.projects.slice(0, 2), far] });
    const user = userEvent.setup();
    const { unmount } = renderWithProviders(<Programs />, { route: "/roadmap?mode=overview&programId=10" });
    await screen.findByRole("grid", { name: "Programs timeline" });
    await waitFor(() => expect(proposeButton()).toBeEnabled());
    await user.click(screen.getByRole("button", { name: "Expand all" }));
    await user.click(proposeButton());
    await screen.findByRole("heading", { name: "Schedule proposal" });
    const narrowedWidth = trackWidth();
    expect(within(screen.getByRole("table", { name: "Projects whose dates would move" })).getByRole("link", { name: "Open project Dashboards" })).toBeInTheDocument();
    unmount();
    renderWithProviders(<Programs />, { route: "/roadmap?mode=overview" });
    await screen.findByRole("grid", { name: "Programs timeline" });
    await waitFor(() => expect(proposeButton()).toBeEnabled());
    await user.click(screen.getByRole("button", { name: "Expand all" }));
    await user.click(proposeButton());
    await screen.findByRole("heading", { name: "Schedule proposal" });
    expect(trackWidth()).toBeGreaterThan(narrowedWidth);
  });
});

describe("the target windows are locked while a proposal is requested or open", () => {
  test("the band is read-only, the draw surface and the menu's window items are gone, a change is refused out loud with no write; Discard gives them back", async () => {
    const user = userEvent.setup();
    await opened(user);
    expect(within(rowOf("Invoices")).getByLabelText("Invoices, target window 2042-02-03 to 2042-03-31")).toHaveAttribute("data-tone", "window");
    expect(within(rowOf("Invoices")).queryByRole("img", { name: /target window/ })).toBeNull();
    expect(rowOf("Taxes").querySelector("[data-draw-surface]")).not.toBeNull();
    await user.click(proposeButton());
    await screen.findByRole("heading", { name: "Schedule proposal" });
    expect(within(rowOf("Invoices")).getByRole("img", { name: "Invoices, target window 2042-02-03 to 2042-03-31, read-only" })).toBeInTheDocument();
    expect(rowOf("Taxes").querySelector("[data-draw-surface]")).toBeNull();
    await user.click(screen.getByRole("button", { name: "Operations for Invoices" }));
    expect(await screen.findByRole("menuitem", { name: /Open project Invoices/ })).toBeInTheDocument();
    expect(screen.queryByRole("menuitem", { name: /target window/ })).toBeNull();
    await user.keyboard("{Escape}");
    // a drag that still reaches the write path is refused out loud: the lock's sentence in the region and in a visible note, and no PUT
    dragWindow(INVOICES, 7);
    expect(liveText()).toContain("A proposal is open, so the schedule is read-only");
    expect(screen.getAllByRole("note").map((note) => note.textContent).join("|")).toContain("A proposal is open, so the schedule is read-only");
    expect(bodies("PUT", "/api/v1/projects/1/target-window")).toEqual([]);
    await user.click(screen.getByRole("button", { name: "Discard" }));
    expect(within(rowOf("Invoices")).getByLabelText("Invoices, target window 2042-02-03 to 2042-03-31")).toHaveAttribute("data-tone", "window");
    expect(within(rowOf("Invoices")).queryByRole("img", { name: /target window/ })).toBeNull();
    expect(rowOf("Taxes").querySelector("[data-draw-surface]")).not.toBeNull();
  });

  test("the lock starts with the request, not with the answer", async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    mockFetch = routeFetch({
      "GET /api/v1/teams": TEAM_LIST,
      "GET /api/v1/views/programs": () => view,
      "GET /api/v1/public-holidays": { items: [] },
      "GET /api/v1/baselines": { items: [], can: { manage: false } },
      "GET /api/v1/saved-schedule-proposals": { items: [] },
      "GET /api/v1/schedule-proposals/teams": { items: TEAMS, truncated: false },
      "POST /api/v1/schedule-proposals": async () => {
        await gate;
        return RUN;
      },
    });
    vi.stubGlobal("fetch", mockFetch);
    const user = userEvent.setup();
    await opened(user);
    await user.click(proposeButton());
    await waitFor(() => expect(within(rowOf("Invoices")).getByRole("img", { name: /target window.*read-only/ })).toBeInTheDocument());
    expect(screen.getByText("Asking for a proposal — the target windows are read-only until it arrives.")).toBeInTheDocument();
    dragWindow(INVOICES, 7);
    expect(liveText()).toContain("A save is still running");
    release();
    await screen.findByRole("heading", { name: "Schedule proposal" });
  });
});

describe("what the viewer may accept", () => {
  test("an administrator: every move is ticked, Save and Accept are offered, and the accept names every team", async () => {
    const user = userEvent.setup();
    await proposed(user);
    expect(screen.getByRole("button", { name: "Save proposal" })).toBeEnabled();
    await user.click(screen.getByRole("button", { name: "Accept selected (4)" }));
    await waitFor(() => expect(bodies("POST", ACCEPT_URL)).toHaveLength(1));
    const [body] = bodies("POST", ACCEPT_URL);
    expect(body).toMatchObject({ expectedRevision: 12, teamIds: [1, 2, 3], acceptTeamIds: [1, 2, 3] });
    expect((body.items as { milestoneId: number }[]).map((item) => item.milestoneId)).toEqual([11, 12, 21, 31]);
    // the visible note and the status region both say it
    expect(await screen.findAllByText("4 scheduled")).toHaveLength(2);
    expect(screen.queryByRole("heading", { name: "Schedule proposal" })).toBeNull();
    expect(proposalBars()).toEqual([]);
  });

  test("the manager of one run team: only that team's moves are ticked, the accept names that team alone, the others are a read-only preview, and Save is not offered", async () => {
    rights = [TEAMS[1]];
    const user = userEvent.setup();
    await proposed(user);
    expect(screen.getByRole("button", { name: "Accept selected (1)" })).toBeEnabled();
    expect(screen.queryByRole("button", { name: "Save proposal" })).toBeNull();
    // the bars show the WHOLE run, whatever is ticked
    expect(proposalBars()).toHaveLength(6);
    // the other teams' sections are collapsed, read-only (their tables are not rendered while closed)
    expect(screen.getByRole("button", { name: "Show the moves of Alpha" })).toHaveAttribute("aria-expanded", "false");
    expect(screen.getByRole("button", { name: "Show the moves of Gamma" })).toHaveAttribute("aria-expanded", "false");
    expect(screen.getByRole("button", { name: "Hide the moves of Beta" })).toHaveAttribute("aria-expanded", "true");
    await user.click(screen.getByRole("button", { name: "Accept selected (1)" }));
    await waitFor(() => expect(bodies("POST", ACCEPT_URL)).toHaveLength(1));
    const [body] = bodies("POST", ACCEPT_URL);
    expect(body).toMatchObject({ teamIds: [1, 2, 3], acceptTeamIds: [2] });
    expect((body.items as { milestoneId: number }[]).map((item) => item.milestoneId)).toEqual([21]);
  });

  test("a login that manages no team previews: the bars, the sentence and the table, no Accept, no Save, no check request, only Discard and Propose again", async () => {
    rights = [];
    const user = userEvent.setup();
    await proposed(user);
    expect(screen.getByText(/This is a preview\./)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Accept selected/ })).toBeNull();
    expect(screen.queryByRole("button", { name: "Save proposal" })).toBeNull();
    expect(screen.getByRole("button", { name: "Discard" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Propose again" })).toBeEnabled();
    expect(proposalBars()).toHaveLength(6);
    expect(screen.getByRole("table", { name: "Projects whose dates would move" })).toBeInTheDocument();
    expect(bodies("POST", CHECK_URL)).toEqual([]);
    expect(bodies("POST", ACCEPT_URL)).toEqual([]);
  });

  test("a failed rights read degrades to a preview: Propose still works, nothing is offered to accept", async () => {
    mockFetch = routeFetch({
      "GET /api/v1/teams": TEAM_LIST,
      "GET /api/v1/views/programs": () => view,
      "GET /api/v1/public-holidays": { items: [] },
      "GET /api/v1/baselines": { items: [], can: { manage: false } },
      "GET /api/v1/saved-schedule-proposals": { items: [] },
      "GET /api/v1/schedule-proposals/teams": () => new Response(JSON.stringify({ title: "x", status: 500 }), { status: 500, headers: { "Content-Type": "application/json" } }),
      "POST /api/v1/schedule-proposals": RUN,
    });
    vi.stubGlobal("fetch", mockFetch);
    const user = userEvent.setup();
    await proposed(user);
    expect(screen.getByText("Could not read which teams you manage; this is a preview only.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Accept selected/ })).toBeNull();
  });
});
