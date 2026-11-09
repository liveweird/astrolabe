import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import userEvent from "@testing-library/user-event";
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import ScheduleProposals from "./ScheduleProposals";
import type { CrossTeamProposal } from "../api/scheduleProposals";
import { ACCEPT_URL, block, CHECK_URL, ids, move, RUN, RUN_URL, STALE_REVISION, STALE_SCOPE, TEAMS_URL, violatedLink, week } from "../test/crossTeamRun";
import { headingOutline } from "../test/headings";
import { jsonResponse } from "../test/http";
import { renderWithProviders } from "../test/render";

// The cross-team schedule proposal page: the teams the server offers, the run, one section per team, ONE accept, the ticked-subset check.

type FetchMock = ReturnType<typeof vi.fn>;
type Answer = Response | (() => Response | Promise<Response>);

const TEAMS = { items: [{ id: 1, name: "Platform" }, { id: 2, name: "Payments" }] };

let mockFetch: FetchMock;
let teamsAnswer: Answer;
let runAnswer: Answer;
let acceptAnswer: Answer;
let checkAnswer: Answer;

const answer = (a: Answer) => (typeof a === "function" ? a() : a.clone());
const posts = (url: string) => mockFetch.mock.calls.filter(([u, init]) => u === url && (init as RequestInit | undefined)?.method === "POST").map(([, init]) => JSON.parse((init as RequestInit).body as string));
const liveText = () => screen.getAllByRole("status").map((region) => region.textContent).join(" | ");
// A fake clock (real time still flows for waitFor): the 300 ms debounce of the check is advanced by hand.
const settle = () => act(() => vi.advanceTimersByTimeAsync(450));

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  teamsAnswer = jsonResponse(200, TEAMS);
  runAnswer = jsonResponse(200, RUN);
  acceptAnswer = jsonResponse(200, { revision: 13, accepted: [11, 12, 21], skipped: [] });
  checkAnswer = jsonResponse(200, { teams: [{ teamId: 1, weeks: [week("2042-01-05", 2)], weeksTruncated: false, dependencies: [] }, { teamId: 2, weeks: [], weeksTruncated: false, dependencies: [] }] });
  mockFetch = vi.fn((url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    if (method === "GET" && url === TEAMS_URL) return Promise.resolve(answer(teamsAnswer));
    if (method === "POST" && url === RUN_URL) return Promise.resolve(answer(runAnswer));
    if (method === "POST" && url === ACCEPT_URL) return Promise.resolve(answer(acceptAnswer));
    if (method === "POST" && url === CHECK_URL) return Promise.resolve(answer(checkAnswer));
    return Promise.resolve(jsonResponse(404, { title: "Not Found", status: 404 }));
  });
  vi.stubGlobal("fetch", mockFetch);
  localStorage.setItem("astrolabe.auth.token", "fake-token");
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  localStorage.clear();
});

async function pickTeams(user: ReturnType<typeof userEvent.setup>, ...names: string[]) {
  await screen.findByRole("combobox", { name: "Teams" });
  for (const name of names) {
    await user.click(screen.getByRole("combobox", { name: "Teams" }));
    await user.click(await screen.findByRole("option", { name }));
  }
}

async function openRun(user: ReturnType<typeof userEvent.setup>) {
  renderWithProviders(<ScheduleProposals />);
  await pickTeams(user, "Platform", "Payments");
  await user.click(screen.getByRole("button", { name: "Propose" }));
  await screen.findByRole("button", { name: "Discard" });
}

const rowOf = (name: string) => screen.getByRole("checkbox", { name: `Accept ${name}` }).closest("tr") as HTMLElement;

describe("the teams", () => {
  test("the multi-select offers the teams the server lists; the page is an h2 and Propose waits for a pick", async () => {
    const user = userEvent.setup();
    renderWithProviders(<ScheduleProposals />);
    await screen.findByRole("combobox", { name: "Teams" });
    expect(headingOutline()).toEqual([[2, "Schedule proposals"]]);
    expect(screen.getByRole("button", { name: "Propose" })).toBeDisabled();
    await user.click(screen.getByRole("combobox", { name: "Teams" }));
    expect(within(await screen.findByRole("listbox")).getAllByRole("option").map((o) => o.textContent)).toEqual(["Platform", "Payments"]);
    await user.click(screen.getByRole("option", { name: "Payments" }));
    expect(screen.getByRole("button", { name: "Propose" })).toBeEnabled();
  });

  test("a caller who manages no team sees the empty state and no Propose", async () => {
    teamsAnswer = jsonResponse(200, { items: [] });
    renderWithProviders(<ScheduleProposals />);
    expect(await screen.findByText("You manage no team")).toBeInTheDocument();
    expect(screen.getByText("A team's manager or an administrator can run a proposal.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Propose" })).toBeNull();
    expect(screen.queryByRole("combobox", { name: "Teams" })).toBeNull();
    expect(headingOutline()).toEqual([[2, "Schedule proposals"]]);
  });

  test("an administrator with no team at all is told there is none to propose for (the words only; the server's list decides)", async () => {
    localStorage.setItem("astrolabe.auth.roles", JSON.stringify(["ADMIN"]));
    teamsAnswer = jsonResponse(200, { items: [] });
    renderWithProviders(<ScheduleProposals />);
    expect(await screen.findByText("No team to propose for yet")).toBeInTheDocument();
    expect(screen.getByText("Create a team under Teams first.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Propose" })).toBeNull();
  });

  test("while the proposal is on its way the teams say they are locked, and why", async () => {
    runAnswer = () => new Promise<Response>(() => undefined);
    const user = userEvent.setup();
    renderWithProviders(<ScheduleProposals />);
    await pickTeams(user, "Platform");
    await user.click(screen.getByRole("button", { name: "Propose" }));
    expect(await screen.findByText("Asking for a proposal — the teams are locked until it arrives.")).toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "Teams" })).toBeDisabled();
  });

  test("a failed teams read is an inline alert", async () => {
    teamsAnswer = jsonResponse(500, { title: "Boom", status: 500 });
    renderWithProviders(<ScheduleProposals />);
    expect(await screen.findByText("Could not load your teams")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Propose" })).toBeNull();
  });
});

describe("the run", () => {
  test("Propose posts the team set with the viewer's day; the facts line, the sections in the answer's order, ready said in the status region", async () => {
    const user = userEvent.setup();
    await openRun(user);
    expect(posts(RUN_URL)).toEqual([{ asOf: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/), teamIds: [1, 2] }]);
    expect(screen.getByText("Placed in 1 pass · settled")).toBeInTheDocument();
    expect(headingOutline()).toEqual([
      [2, "Schedule proposals"],
      [3, "Platform"],
      [4, "Proposed load"],
      [3, "Payments"],
      [4, "Proposed load"],
    ]);
    expect(screen.getByText("placed 1 of 2")).toBeInTheDocument();
    expect(screen.getByText("placed 2 of 2")).toBeInTheDocument();
    expect(within(screen.getByRole("table", { name: "Proposed moves of Platform" })).getByText("x1")).toBeInTheDocument();
    expect(within(screen.getByRole("table", { name: "Proposed moves of Payments" })).getByText("y1")).toBeInTheDocument();
    expect(liveText()).toContain("Proposed schedule ready: 3 moves");
    expect(screen.getByRole("button", { name: "Accept selected across teams (3)" })).toBeEnabled();
    // the teams are locked while the run is open, Propose is off
    expect(screen.getByRole("combobox", { name: "Teams" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Propose" })).toBeDisabled();
  });

  test("a run that did not settle says plainly what that means, in an orange note", async () => {
    runAnswer = jsonResponse(200, { ...RUN, passes: 5, settled: false });
    const user = userEvent.setup();
    await openRun(user);
    expect(screen.getByRole("note")).toHaveTextContent(/Not settled after 5 passes: the teams depend on each other in a loop/);
    expect(screen.queryByText("Placed in 5 passes · settled")).toBeNull();
  });

  test("an unsettled run is announced in the status region after the ready sentence", async () => {
    runAnswer = jsonResponse(200, { ...RUN, passes: 5, settled: false });
    const user = userEvent.setup();
    await openRun(user);
    expect(liveText()).toMatch(/Proposed schedule ready: 3 moves\. Not settled after 5 passes: the teams depend on each other in a loop/);
  });

  test("a run with nothing to move opens nothing and leaves a note", async () => {
    runAnswer = jsonResponse(200, { ...RUN, teams: [block(1, "Platform", [], { unchanged: [11] }), block(2, "Payments", [], { unchanged: [21] })] });
    const user = userEvent.setup();
    renderWithProviders(<ScheduleProposals />);
    await pickTeams(user, "Platform");
    await user.click(screen.getByRole("button", { name: "Propose" }));
    expect(await screen.findByText("Nothing to propose: every milestone has started or stays where it is.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Discard" })).toBeNull();
    expect(screen.getByRole("button", { name: "Propose" })).toBeEnabled();
  });

  test.each([
    [403, "Only a manager of every listed team or an administrator can propose or accept a schedule across teams"],
    [404, "A team of the proposal no longer exists — reload the page"],
    [400, "The proposal could not be applied — propose again"],
  ])("a %i on the run is an inline alert in words, never a toast", async (status, words) => {
    runAnswer = jsonResponse(status, { title: "x", status });
    const user = userEvent.setup();
    renderWithProviders(<ScheduleProposals />);
    await pickTeams(user, "Platform");
    await user.click(screen.getByRole("button", { name: "Propose" }));
    expect(await screen.findByText(words)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Discard" })).toBeNull();
  });

  test("Select all in one section acts on that team's moves only; the status region says the run-wide figures", async () => {
    const user = userEvent.setup();
    await openRun(user);
    const platform = within(screen.getByRole("table", { name: "Proposed moves of Platform" }));
    await user.click(platform.getByRole("checkbox", { name: "Accept all" }));
    expect(screen.getByRole("checkbox", { name: "Accept x1" })).not.toBeChecked();
    expect(screen.getByRole("checkbox", { name: "Accept y1" })).toBeChecked();
    expect(liveText()).toContain("1 of 3 selected");
    expect(screen.getByRole("button", { name: "Accept selected across teams (1)" })).toBeInTheDocument();
  });

  test("Discard closes the run without a write", async () => {
    const user = userEvent.setup();
    await openRun(user);
    await user.click(screen.getByRole("button", { name: "Discard" }));
    expect(screen.queryByRole("table", { name: "Proposed moves of Platform" })).toBeNull();
    expect(posts(ACCEPT_URL)).toEqual([]);
    expect(screen.getByRole("combobox", { name: "Teams" })).toBeEnabled();
  });
});

describe("the accept", () => {
  test("ONE accept sends every ticked item of every section with the run's revision, hash and teams; the outcome is inline", async () => {
    const user = userEvent.setup();
    await openRun(user);
    await user.click(screen.getByRole("checkbox", { name: "Accept x2" }));
    await user.click(screen.getByRole("button", { name: "Accept selected across teams (2)" }));
    expect(await screen.findByRole("note")).toHaveTextContent("3 scheduled");
    expect(posts(ACCEPT_URL)).toHaveLength(1);
    const [body] = posts(ACCEPT_URL);
    expect(body).toMatchObject({ expectedRevision: 12, scopeHash: "b".repeat(64), teamIds: [1, 2] });
    expect(ids(body)).toEqual([11, 21]);
    expect(screen.queryByRole("button", { name: "Discard" })).toBeNull();
    expect(liveText()).toContain("3 scheduled");
  });

  test("skipped milestones are counted with the server's reasons in the fixed vocabulary", async () => {
    acceptAnswer = jsonResponse(200, { revision: 13, accepted: [11], skipped: [{ milestoneId: 12, reason: "STALE" }, { milestoneId: 21, reason: "NO_WORKING_DAY" }] });
    const user = userEvent.setup();
    await openRun(user);
    await user.click(screen.getByRole("button", { name: "Accept selected across teams (3)" }));
    expect(await screen.findByRole("note")).toHaveTextContent("1 scheduled · 2 skipped: rescheduled in the meantime, no working day left in the span");
  });

  test("a double click on Accept sends ONE request and the second click is refused out loud in the page's note", async () => {
    acceptAnswer = () => new Promise<Response>(() => undefined);
    const user = userEvent.setup();
    await openRun(user);
    const accept = screen.getByRole("button", { name: "Accept selected across teams (3)" });
    // Both clicks land before React has re-rendered the button as busy: the same tick, as a double click delivers them.
    act(() => {
      fireEvent.click(accept);
      fireEvent.click(accept);
    });
    await waitFor(() => expect(posts(ACCEPT_URL)).toHaveLength(1));
    await waitFor(() => expect(screen.getAllByRole("note").map((note) => note.textContent)).toContain("A save is still running — try your change again in a moment."));
    expect(liveText()).toContain("A save is still running");
  });

  test("a stale revision closes the run with the reload note", async () => {
    acceptAnswer = jsonResponse(409, STALE_REVISION);
    const user = userEvent.setup();
    await openRun(user);
    await user.click(screen.getByRole("button", { name: "Accept selected across teams (3)" }));
    expect(await screen.findByRole("note")).toHaveTextContent(/The plan changed in the meantime/);
    expect(screen.queryByRole("button", { name: "Discard" })).toBeNull();
  });

  test("a stale scope re-proposes the same teams at once and keeps the ticks of the moves that still exist", async () => {
    acceptAnswer = jsonResponse(409, STALE_SCOPE);
    const user = userEvent.setup();
    await openRun(user);
    await user.click(screen.getByRole("checkbox", { name: "Accept x2" }));
    const fresh: CrossTeamProposal = {
      ...RUN,
      revision: 14,
      scopeHash: "c".repeat(64),
      teams: [block(1, "Platform", [move(11, "x1", "2042-01-07", "2042-01-09"), move(13, "x3", "2042-01-12", "2042-01-12")]), block(2, "Payments", [move(21, "y1", "2042-01-13", "2042-01-15")])],
    };
    runAnswer = jsonResponse(200, fresh);
    await user.click(screen.getByRole("button", { name: "Accept selected across teams (2)" }));
    expect(await screen.findByText(/The plan of the chosen teams changed since the proposal: here is a fresh one/)).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole("checkbox", { name: "Accept x3" })).toBeInTheDocument());
    expect(screen.getByRole("checkbox", { name: "Accept x1" })).toBeChecked();
    expect(screen.getByRole("checkbox", { name: "Accept y1" })).toBeChecked();
    expect(screen.getByRole("checkbox", { name: "Accept x3" })).not.toBeChecked();
    expect(posts(RUN_URL)).toHaveLength(2);
    expect(posts(RUN_URL)[1]).toMatchObject({ teamIds: [1, 2] });
    expect(screen.getByRole("button", { name: "Accept selected across teams (2)" })).toBeEnabled();
  });

  test.each([
    [403, "Only a manager of every listed team or an administrator can propose or accept a schedule across teams"],
    [400, "The proposal could not be applied — propose again"],
    [404, "A team of the proposal no longer exists — reload the page"],
  ])("a %i on the accept stays inline above the buttons with the run still open", async (status, words) => {
    acceptAnswer = jsonResponse(status, { title: "x", status });
    const user = userEvent.setup();
    await openRun(user);
    await user.click(screen.getByRole("button", { name: "Accept selected across teams (3)" }));
    const alert = await screen.findByText(words);
    expect(alert).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Discard" })).toBeEnabled();
    await waitFor(() => expect(alert.closest("[tabindex='-1']")).toHaveFocus());
  });
});

describe("the ticked-subset check", () => {
  test("unticking a move asks the server about the ticked items of all sections; the Links column and the load follow; all ticked sends nothing", async () => {
    runAnswer = jsonResponse(200, { ...RUN, teams: [RUN.teams[0], { ...RUN.teams[1], dependencies: [] }] });
    checkAnswer = jsonResponse(200, {
      teams: [
        { teamId: 1, weeks: [week("2042-01-05", 2)], weeksTruncated: false, dependencies: [] },
        { teamId: 2, weeks: [], weeksTruncated: false, dependencies: [violatedLink()] },
      ],
    });
    const user = userEvent.setup();
    await openRun(user);
    await settle();
    expect(posts(CHECK_URL)).toEqual([]);
    expect(within(rowOf("y1")).queryByText("Conflict")).toBeNull();

    await user.click(screen.getByRole("checkbox", { name: "Accept x1" }));
    expect(screen.getAllByText("Checking the ticked moves…").length).toBeGreaterThan(0);
    await waitFor(() => expect(posts(CHECK_URL)).toHaveLength(1));
    expect(posts(CHECK_URL)[0]).toMatchObject({ teamIds: [1, 2] });
    expect(ids(posts(CHECK_URL)[0])).toEqual([12, 21]);
    await waitFor(() => expect(within(rowOf("y1")).getByText("Conflict")).toBeInTheDocument());
    expect(within(rowOf("y1")).getByText("would violate: must start on 2042-03-04 or later (link from Invoices › x1)")).toBeInTheDocument();
    expect(screen.queryByText("Checking the ticked moves…")).toBeNull();

    await user.click(screen.getByRole("checkbox", { name: "Accept x1" }));
    expect(within(rowOf("y1")).queryByText("Conflict")).toBeNull();
    await settle();
    expect(posts(CHECK_URL)).toHaveLength(1);
  });

  test("nothing ticked anywhere: no request, no warnings, and the sections say there is no load to show", async () => {
    const user = userEvent.setup();
    await openRun(user);
    await user.click(screen.getByRole("checkbox", { name: "Accept x1" }));
    await user.click(screen.getByRole("checkbox", { name: "Accept x2" }));
    await user.click(screen.getByRole("checkbox", { name: "Accept y1" }));
    await settle();
    expect(screen.getAllByText("Tick a move to see the load after accepting it.")).toHaveLength(2);
    expect(screen.getByRole("button", { name: "Accept selected across teams (0)" })).toBeDisabled();
  });

  test("a failed check says so inline and the run's own verdicts stay", async () => {
    checkAnswer = jsonResponse(500, { title: "Boom", status: 500 });
    const user = userEvent.setup();
    await openRun(user);
    await user.click(screen.getByRole("checkbox", { name: "Accept x1" }));
    expect((await screen.findAllByText("The ticked moves could not be checked; the warnings describe all moves.")).length).toBeGreaterThan(0);
    expect(screen.queryByRole("alert")).toBeNull();
  });
});
