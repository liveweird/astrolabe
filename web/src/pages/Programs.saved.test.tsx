import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import userEvent from "@testing-library/user-event";
import { act, screen, waitFor, within } from "@testing-library/react";
import { QueryClient } from "@tanstack/react-query";
import { useLocation, useNavigate } from "react-router-dom";
import Programs from "./Programs";
import { savedProposalKey, type SavedProposalRecord } from "../api/savedProposals";
import { ACCEPT_URL, CHECK_URL, RUN_URL, SAVED, SAVED_RECORD, SAVED_URL, STALE_REVISION, STALE_SCOPE, week } from "../test/crossTeamRun";
import { jsonResponse, routeFetch } from "../test/http";
import { RUN, TEAMS, viewOf } from "../test/overviewRun";
import { renderWithProviders } from "../test/render";
import { localIsoDate } from "../utils/isoDate";

// A saved cross-team proposal on the Roadmap overview (1.33): `?proposal=<id>` opens the stored run in the overview's own run - the state, the stored ticks and check, who may
// tick and accept, Propose again, Close - and the ways it does not open (gone, unreadable, malformed, failed).

const TODAY = localIsoDate();
// Alpha moves a1 and a2 (11, 12), Beta b1 (21), Gamma g1 (31); three of the four were ticked, so a stored check exists (Alpha's week lighter).
const STORED_CHECK = {
  teams: [
    { teamId: 1, weeks: [week("2042-01-05", 2)], weeksTruncated: false, dependencies: [] },
    { teamId: 2, weeks: [], weeksTruncated: false, dependencies: [] },
    { teamId: 3, weeks: [], weeksTruncated: false, dependencies: [] },
  ],
};
const CURRENT: SavedProposalRecord = {
  ...SAVED_RECORD,
  asOf: TODAY,
  planRevision: 12,
  teams: TEAMS,
  moveCount: 4,
  selectedCount: 3,
  selectedMilestoneIds: [11, 21, 31],
  proposal: RUN,
  check: STORED_CHECK,
  can: { accept: true, delete: true },
};
const CHANGED: SavedProposalRecord = { ...CURRENT, state: "CHANGED", can: { accept: false, delete: true } };
const OPEN = "astrolabe.viewSettings.roadmap.savedProposalsOpen";

let record: SavedProposalRecord | Response;
let rights: { id: number; name: string }[];
let runAnswer: Response;
let acceptAnswer: Response;
let mockFetch: ReturnType<typeof routeFetch>;
// What `GET /views/programs` answers (a plan with no work streams for the empty overview) and, when set, the gate the record read waits on.
let planView: ReturnType<typeof viewOf>;
let hold: Promise<void> | null;

const posts = (url: string) => mockFetch.mock.calls.filter(([u, init]) => String(u) === url && (init as RequestInit | undefined)?.method === "POST").map(([, init]) => JSON.parse((init as RequestInit).body as string) as Record<string, unknown>);
const recordReads = () => mockFetch.mock.calls.filter(([u, init]) => String(u).startsWith(`${SAVED_URL}/`) && (init as RequestInit | undefined)?.method === undefined).length;
const ticked = (names: string[]) => names.map((name) => (screen.getByRole("checkbox", { name: `Accept ${name}` }) as HTMLInputElement).checked);
const proposalBars = () => document.querySelectorAll('[data-tone="proposal"]').length;

function Where() {
  const navigate = useNavigate();
  return (
    <>
      <output data-testid="where">{useLocation().search}</output>
      <button onClick={() => void navigate(-1)}>history back</button>
    </>
  );
}
const where = () => screen.getByTestId("where").textContent;
// A fake clock (real time still flows for waitFor): the 300 ms debounce of the live check is advanced by hand.
const settle = () => act(() => vi.advanceTimersByTimeAsync(450));

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  record = CURRENT;
  planView = viewOf();
  hold = null;
  rights = TEAMS;
  runAnswer = jsonResponse(200, { ...RUN, revision: 13, scopeHash: "c".repeat(64) });
  acceptAnswer = jsonResponse(200, { revision: 13, accepted: [11, 21, 31], skipped: [] });
  mockFetch = routeFetch({
    "GET /api/v1/views/programs": () => planView,
    "GET /api/v1/public-holidays": { items: [] },
    "GET /api/v1/baselines": { items: [], can: { manage: false } },
    "GET /api/v1/schedule-proposals/teams": () => ({ items: rights, truncated: false }),
    [`GET ${SAVED_URL}`]: { items: [SAVED] },
    [`GET ${SAVED_URL}/:id`]: async () => {
      await hold;
      return record;
    },
    [`DELETE ${SAVED_URL}/:id`]: () => new Response(null, { status: 204 }),
    [`POST ${RUN_URL}`]: () => runAnswer,
    [`POST ${ACCEPT_URL}`]: () => acceptAnswer,
    [`POST ${CHECK_URL}`]: { teams: STORED_CHECK.teams.map((team) => ({ ...team, weeks: [week("2042-01-05", 4)] })) },
  });
  vi.stubGlobal("fetch", mockFetch);
  localStorage.setItem("astrolabe.auth.token", "fake-token");
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  localStorage.clear();
});

/** The overview at the saved proposal's address; resolves once the run is open. */
async function opened(route = "/roadmap?mode=overview&proposal=5", queryClient?: QueryClient) {
  renderWithProviders(
    <>
      <Programs />
      <Where />
    </>,
    { route, queryClient },
  );
  await screen.findByRole("heading", { name: "Saved proposal: Q1 plan" });
}

describe("a saved proposal the viewer may accept", () => {
  test("opens as the overview's run: the heading, the state, the facts, the stored ticks editable, the stored check with no request, the bars and the table", async () => {
    await opened();
    expect(screen.getByRole("heading", { level: 3, name: "Saved proposal: Q1 plan" })).toBeInTheDocument();
    expect(document.querySelector('[data-state="CURRENT"]')).toHaveTextContent("Current");
    expect(screen.getByText(/Saved by/)).toHaveTextContent("Saved by Ada on 2042-01-05 09:30 · as of " + TODAY);
    expect(screen.getByText("The plan still matches this proposal.")).toBeInTheDocument();
    expect(ticked(["a1", "a2", "b1", "g1"])).toEqual([true, false, true, true]);
    expect(screen.getByRole("button", { name: "Accept selected (3)" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Close" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Save proposal" })).toBeNull();
    // the work stream and its two programs; the projects are folded
    expect(proposalBars()).toBe(3);
    expect(screen.getByRole("table", { name: "Projects whose dates would move" })).toBeInTheDocument();
    // the stored ticks are the stored check's: no live check is asked
    expect(posts(CHECK_URL)).toEqual([]);
    expect(screen.getAllByRole("status").map((region) => region.textContent).join(" ")).toContain("Saved proposal “Q1 plan” opened.");
    expect(where()).toBe("?mode=overview&proposal=5");
  });

  test("a changed tick asks the server's live check; the stored ticks are the stored check again with no further request", async () => {
    const user = userEvent.setup();
    await opened();
    await user.click(screen.getByRole("checkbox", { name: "Accept g1" }));
    await waitFor(() => expect(posts(CHECK_URL)).toHaveLength(1));
    expect(posts(CHECK_URL)[0]).toMatchObject({ teamIds: [1, 2, 3] });
    await user.click(screen.getByRole("checkbox", { name: "Accept g1" }));
    await settle();
    expect(posts(CHECK_URL)).toHaveLength(1);
  });

  test("Accept posts the STORED revision, scope token and teams with the ticked moves, naming the ticked teams; the run closes, the outcome is said and the parameter leaves the address", async () => {
    const user = userEvent.setup();
    await opened();
    await user.click(screen.getByRole("checkbox", { name: "Accept g1" }));
    await user.click(screen.getByRole("button", { name: "Accept selected (2)" }));
    await waitFor(() => expect(posts(ACCEPT_URL)).toHaveLength(1));
    const [body] = posts(ACCEPT_URL);
    expect(body).toMatchObject({ expectedRevision: 12, scopeHash: RUN.scopeHash, teamIds: [1, 2, 3], acceptTeamIds: [1, 2] });
    expect((body.items as { milestoneId: number }[]).map((item) => item.milestoneId)).toEqual([11, 21]);
    await waitFor(() => expect(screen.queryByRole("heading", { name: "Saved proposal: Q1 plan" })).toBeNull());
    await waitFor(() => expect(where()).toBe("?mode=overview"));
    expect(screen.getAllByText("3 scheduled").length).toBeGreaterThan(0);
  });

  test("the manager of one run team: only that team's stored ticks stay tickable and the accept names that team alone", async () => {
    rights = [TEAMS[1]];
    record = { ...CURRENT, selectedMilestoneIds: [11, 12, 21, 31], selectedCount: 4, check: null };
    const user = userEvent.setup();
    await opened();
    expect(screen.getByRole("button", { name: "Accept selected (1)" })).toBeEnabled();
    await user.click(screen.getByRole("button", { name: "Accept selected (1)" }));
    await waitFor(() => expect(posts(ACCEPT_URL)).toHaveLength(1));
    expect(posts(ACCEPT_URL)[0]).toMatchObject({ teamIds: [1, 2, 3], acceptTeamIds: [2] });
  });

  test("a stale scope on the accept re-proposes the same teams: the fresh run keeps the ticks and says it is not the saved one; the saved heading stays", async () => {
    acceptAnswer = jsonResponse(409, STALE_SCOPE);
    const user = userEvent.setup();
    await opened();
    await user.click(screen.getByRole("button", { name: "Accept selected (3)" }));
    await waitFor(() => expect(posts(RUN_URL)).toHaveLength(1));
    expect(posts(RUN_URL)[0]).toMatchObject({ teamIds: [1, 2, 3] });
    expect(await screen.findByText(/This is a fresh run for the same teams, not the saved proposal/)).toBeInTheDocument();
    expect(ticked(["a1", "a2", "b1", "g1"])).toEqual([true, false, true, true]);
    expect(where()).toBe("?mode=overview&proposal=5");
    // it is the viewer's own run now: Save is offered, and Close says nothing is thrown away only for the saved one
    expect(screen.getByRole("button", { name: "Save proposal" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Discard" })).toBeInTheDocument();
  });

  test("Propose again asks for the stored teams with the ticks kept; Discard of that fresh run ends it and the parameter", async () => {
    const user = userEvent.setup();
    await opened();
    await user.click(screen.getByRole("button", { name: "Propose again" }));
    await waitFor(() => expect(posts(RUN_URL)).toHaveLength(1));
    expect(await screen.findByText(/This is a fresh run for the same teams/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Discard" }));
    await waitFor(() => expect(screen.queryByRole("heading", { name: /^Saved proposal:/ })).toBeNull());
    await waitFor(() => expect(where()).toBe("?mode=overview"));
    expect(proposalBars()).toBe(0);
  });

  test("Close ends the run and takes the parameter out of the address, nothing is written; the focus returns to Propose", async () => {
    const user = userEvent.setup();
    await opened();
    await user.click(screen.getByRole("button", { name: "Close" }));
    await waitFor(() => expect(where()).toBe("?mode=overview"));
    expect(screen.queryByRole("heading", { name: "Saved proposal: Q1 plan" })).toBeNull();
    expect(proposalBars()).toBe(0);
    expect(posts(ACCEPT_URL)).toEqual([]);
    await waitFor(() => expect(screen.getByRole("button", { name: "Propose schedule" })).toHaveFocus());
    // it opens once: the closed run does not come back
    await settle();
    expect(screen.queryByRole("heading", { name: "Saved proposal: Q1 plan" })).toBeNull();
  });
});

describe("a saved proposal the viewer may only read", () => {
  test("a plan that changed: the Changed badge with its words, the stored ticks read-only, no Accept and no Save, the names are not links; Propose again opens a fresh run", async () => {
    record = CHANGED;
    const user = userEvent.setup();
    await opened();
    expect(document.querySelector('[data-state="CHANGED"]')).toHaveTextContent("Changed");
    expect(screen.getByText(/The plan changed after it was saved/)).toBeInTheDocument();
    expect(ticked(["a1", "a2", "b1", "g1"])).toEqual([true, false, true, true]);
    expect(screen.getByRole("checkbox", { name: "Accept a1" })).toBeDisabled();
    expect(screen.queryByRole("button", { name: /Accept selected/ })).toBeNull();
    expect(screen.queryByRole("button", { name: "Save proposal" })).toBeNull();
    expect(posts(CHECK_URL)).toEqual([]);
    await user.click(screen.getByRole("button", { name: "Propose again" }));
    await waitFor(() => expect(posts(RUN_URL)).toHaveLength(1));
    expect(await screen.findByText(/This is a fresh run for the same teams/)).toBeInTheDocument();
    expect(screen.getByText(/The plan of the chosen teams changed since the proposal/)).toBeInTheDocument();
  });

  test("a CURRENT proposal computed for an earlier day is not acceptable: the ticks are read-only and a note names the day", async () => {
    record = { ...CURRENT, asOf: "2020-01-06", proposal: { ...RUN, asOf: "2020-01-06" } };
    await opened();
    expect(screen.getByText("Computed for 2020-01-06; propose again for today.")).toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: "Accept a1" })).toBeDisabled();
    expect(screen.queryByRole("button", { name: /Accept selected/ })).toBeNull();
  });

  test("a viewer whose record says can.accept is false (or who manages no team) reads the stored ticks, with the note and no Accept", async () => {
    record = { ...CURRENT, can: { accept: false, delete: false } };
    rights = [];
    await opened();
    expect(screen.getByText(/You can read it; only an administrator or the manager of one of its teams/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Accept selected/ })).toBeNull();
    expect(screen.queryByRole("button", { name: "Save proposal" })).toBeNull();
    expect(screen.getByRole("button", { name: "Close" })).toBeInTheDocument();
    expect(posts(CHECK_URL)).toEqual([]);
  });
});

describe("the record changing under an open run", () => {
  const freshClient = () => new QueryClient({ defaultOptions: { queries: { retry: false } } });

  test("a refetch that turns the open CURRENT record CHANGED takes the Accept away and reads the stored ticks only", async () => {
    const queryClient = freshClient();
    await opened(undefined, queryClient);
    expect(screen.getByRole("button", { name: "Accept selected (3)" })).toBeEnabled();
    record = CHANGED;
    await act(() => queryClient.refetchQueries({ queryKey: savedProposalKey(5) }));
    await waitFor(() => expect(screen.queryByRole("button", { name: /Accept selected/ })).toBeNull());
    expect(document.querySelector('[data-state="CHANGED"]')).toHaveTextContent("Changed");
    expect(screen.getByRole("checkbox", { name: "Accept a1" })).toBeDisabled();
    expect(screen.getByRole("heading", { name: "Saved proposal: Q1 plan" })).toBeInTheDocument();
  });

  test("a 404 on a refetch while the run is open closes it, says the proposal is gone and drops the parameter", async () => {
    const queryClient = freshClient();
    await opened(undefined, queryClient);
    record = jsonResponse(404, { title: "Not found", status: 404 });
    await act(() => queryClient.refetchQueries({ queryKey: savedProposalKey(5) }));
    // the visible note and the polite region's sentence
    expect((await screen.findAllByText("This saved proposal does not exist — it may have been deleted.")).length).toBeGreaterThan(0);
    await waitFor(() => expect(screen.queryByRole("heading", { name: "Saved proposal: Q1 plan" })).toBeNull());
    await waitFor(() => expect(where()).toBe("?mode=overview"));
    expect(proposalBars()).toBe(0);
  });

  test("an accept refused as stale (the plan's revision moved) ends the run and the parameter leaves the address", async () => {
    acceptAnswer = jsonResponse(409, STALE_REVISION);
    const user = userEvent.setup();
    await opened();
    await user.click(screen.getByRole("button", { name: "Accept selected (3)" }));
    await waitFor(() => expect(posts(ACCEPT_URL)).toHaveLength(1));
    await waitFor(() => expect(where()).toBe("?mode=overview"));
    expect(screen.queryByRole("heading", { name: "Saved proposal: Q1 plan" })).toBeNull();
    expect(screen.getAllByText(/The plan changed in the meantime/).length).toBeGreaterThan(0);
  });

  test("Back out of the saved address closes the run it opened", async () => {
    localStorage.setItem(OPEN, "true");
    const user = userEvent.setup();
    renderWithProviders(
      <>
        <Programs />
        <Where />
      </>,
      { route: "/roadmap?mode=overview" },
    );
    await user.click(await screen.findByRole("link", { name: "Open Q1 plan" }));
    await screen.findByRole("heading", { name: "Saved proposal: Q1 plan" });
    expect(where()).toBe("?mode=overview&proposal=5");
    await user.click(screen.getByRole("button", { name: "history back" }));
    await waitFor(() => expect(screen.queryByRole("heading", { name: "Saved proposal: Q1 plan" })).toBeNull());
    expect(where()).toBe("?mode=overview");
    expect(proposalBars()).toBe(0);
  });

  test("deleting the open proposal from the list closes its run and takes the parameter out of the address", async () => {
    localStorage.setItem(OPEN, "true");
    const user = userEvent.setup();
    await opened();
    await user.click(await screen.findByRole("button", { name: "Delete Q1 plan" }));
    await user.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(where()).toBe("?mode=overview"));
    await waitFor(() => expect(screen.queryByRole("heading", { name: "Saved proposal: Q1 plan" })).toBeNull());
    expect(proposalBars()).toBe(0);
    // the cached copy is gone: the proposal does not come back
    await settle();
    expect(screen.queryByRole("heading", { name: "Saved proposal: Q1 plan" })).toBeNull();
  });
});

describe("a saved run against the current pick and address", () => {
  test("projects the run moves that the pick hides are counted in a note whose button shows every program", async () => {
    const user = userEvent.setup();
    await opened("/roadmap?mode=overview&programId=11&proposal=5");
    expect(screen.getByText("2 of the projects this proposal moves are outside the current pick")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Show every program" }));
    await waitFor(() => expect(where()).toBe("?mode=overview&proposal=5"));
    expect(screen.queryByText(/outside the current pick/)).toBeNull();
    expect(screen.queryByRole("button", { name: "Show every program" })).toBeNull();
  });

  test("no note when the whole run is inside the pick", async () => {
    await opened();
    expect(screen.queryByText(/outside the current pick/)).toBeNull();
  });

  test("Propose stays off while the named record is still being read", async () => {
    let release = () => {};
    hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    renderWithProviders(<Programs />, { route: "/roadmap?mode=overview&proposal=5" });
    expect(await screen.findByText("Opening the saved proposal…")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Propose schedule" })).toBeDisabled();
    release();
    await screen.findByRole("heading", { name: "Saved proposal: Q1 plan" });
  });
});

// A notice is said twice: the visible note, and the page's polite status region one tick later (useLiveText). Matching the note alone keeps these
// assertions from racing that tick, which made "Dismiss clears the note" fail in a shuffled CI run.
const NOTE_ONLY = { ignore: 'script, style, [role="status"]' };

describe("a saved proposal that does not open", () => {
  test("an overview with no work streams still says a gone proposal does not exist and drops the parameter", async () => {
    planView = viewOf({ workStreams: [] });
    record = jsonResponse(404, { title: "Not found", status: 404 });
    renderWithProviders(
      <>
        <Programs />
        <Where />
      </>,
      { route: "/roadmap?mode=overview&proposal=2147483000" },
    );
    // a visible note (never role="alert"), said once more in the polite status region
    expect((await screen.findAllByRole("note")).map((note) => note.textContent)).toContain("This saved proposal does not exist — it may have been deleted.");
    await waitFor(() => expect(where()).toBe("?mode=overview"));
    await waitFor(() => expect(screen.getAllByRole("status").map((region) => region.textContent).join(" ")).toContain("This saved proposal does not exist"));
    expect(screen.getByText("No work streams yet")).toBeInTheDocument();
  });

  test("one saved by an earlier version says so, shows no run and leaves the address", async () => {
    record = { ...CURRENT, state: "UNREADABLE", proposal: null, check: null, can: { accept: false, delete: true } };
    renderWithProviders(
      <>
        <Programs />
        <Where />
      </>,
      { route: "/roadmap?mode=overview&proposal=5" },
    );
    expect(await screen.findByText("“Q1 plan” was saved in an earlier version of Astrolabe and can no longer be opened.", NOTE_ONLY)).toBeInTheDocument();
    await waitFor(() => expect(where()).toBe("?mode=overview"));
    expect(screen.queryByRole("heading", { name: /^Saved proposal:/ })).toBeNull();
    expect(proposalBars()).toBe(0);
  });

  test("an unknown id (a 404) says it does not exist, drops the parameter and keeps no copy; a malformed id asks nothing", async () => {
    record = jsonResponse(404, { title: "Not found", status: 404 });
    renderWithProviders(
      <>
        <Programs />
        <Where />
      </>,
      { route: "/roadmap?mode=overview&proposal=5" },
    );
    expect(await screen.findByText("This saved proposal does not exist — it may have been deleted.", NOTE_ONLY)).toBeInTheDocument();
    await waitFor(() => expect(where()).toBe("?mode=overview"));
    expect(screen.queryByRole("heading", { name: /^Saved proposal:/ })).toBeNull();
  });

  test("a malformed id says the same and reads nothing", async () => {
    renderWithProviders(
      <>
        <Programs />
        <Where />
      </>,
      { route: "/roadmap?mode=overview&proposal=abc" },
    );
    expect(await screen.findByText("This saved proposal does not exist — it may have been deleted.", NOTE_ONLY)).toBeInTheDocument();
    await waitFor(() => expect(where()).toBe("?mode=overview"));
    expect(recordReads()).toBe(0);
  });

  test("another failure is worded by its status; Dismiss clears the note", async () => {
    record = jsonResponse(500, { title: "Boom", status: 500 });
    const user = userEvent.setup();
    renderWithProviders(
      <>
        <Programs />
        <Where />
      </>,
      { route: "/roadmap?mode=overview&proposal=5" },
    );
    const note = await screen.findByText("Load failed (500)", NOTE_ONLY);
    expect(note).toBeInTheDocument();
    // The parameter leaves in a router transition, and the verdict re-asserts the note until it has: Dismiss is clicked on the settled address, as a viewer would.
    await waitFor(() => expect(where()).toBe("?mode=overview"));
    await user.click(screen.getByRole("button", { name: "Dismiss this notice" }));
    expect(screen.queryByText("Load failed (500)", NOTE_ONLY)).toBeNull();
  });
});

describe("opening from the list", () => {
  test("a name in the open Saved proposals list opens that run on the current address, keeping the pick; another name replaces it", async () => {
    localStorage.setItem(OPEN, "true");
    const second = { ...SAVED, id: 6, name: "Q2 plan" };
    mockFetch = routeFetch({
      "GET /api/v1/views/programs": () => viewOf(),
      "GET /api/v1/public-holidays": { items: [] },
      "GET /api/v1/baselines": { items: [], can: { manage: false } },
      "GET /api/v1/schedule-proposals/teams": () => ({ items: rights, truncated: false }),
      [`GET ${SAVED_URL}`]: { items: [SAVED, second] },
      [`GET ${SAVED_URL}/:id`]: (call) => (call.params.id === "5" ? CURRENT : { ...CURRENT, id: 6, name: "Q2 plan" }),
      [`POST ${CHECK_URL}`]: { teams: STORED_CHECK.teams },
    });
    vi.stubGlobal("fetch", mockFetch);
    const user = userEvent.setup();
    renderWithProviders(
      <>
        <Programs />
        <Where />
      </>,
      { route: "/roadmap?mode=overview&programId=10" },
    );
    await user.click(await screen.findByRole("link", { name: "Open Q1 plan" }));
    await screen.findByRole("heading", { name: "Saved proposal: Q1 plan" });
    expect(where()).toBe("?mode=overview&programId=10&proposal=5");
    await user.click(screen.getByRole("link", { name: "Open Q2 plan" }));
    await screen.findByRole("heading", { name: "Saved proposal: Q2 plan" });
    expect(screen.queryByRole("heading", { name: "Saved proposal: Q1 plan" })).toBeNull();
    expect(where()).toBe("?mode=overview&programId=10&proposal=6");
    await user.click(screen.getByRole("button", { name: "Close" }));
    await waitFor(() => expect(where()).toBe("?mode=overview&programId=10"));
    const list = screen.getByRole("table", { name: "Saved proposals" });
    expect(within(list).getAllByRole("link")).toHaveLength(2);
  });
});
