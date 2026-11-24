import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import userEvent from "@testing-library/user-event";
import { Route, Routes } from "react-router-dom";
import { QueryClient } from "@tanstack/react-query";
import { act, screen, waitFor, within } from "@testing-library/react";
import SavedScheduleProposal from "./SavedScheduleProposal";
import { SAVED_PROPOSALS_KEY, savedProposalKey, type SavedProposalRecord } from "../api/savedProposals";
import type { CrossTeamProposal } from "../api/scheduleProposals";
import { ACCEPT_URL, block, CHECK_URL, ids, move, RUN, RUN_URL, SAVED_RECORD, SAVED_URL, STALE_REVISION, STALE_SCOPE, violatedLink, week } from "../test/crossTeamRun";
import { headingOutline } from "../test/headings";
import { jsonResponse, routeFetch } from "../test/http";
import { renderWithProviders } from "../test/render";

// A saved cross-team proposal's page: the stored run and check as the server kept them, the state, who may tick and accept, Propose again.

let record: SavedProposalRecord | Response;
let acceptAnswer: Response;
let runAnswer: Response;
let mockFetch: ReturnType<typeof routeFetch>;

/** The stored check of y1's team: the one thing that tells the stored check from the run's own verdicts (y1 shows a conflict). */
const STORED_CHECK = { teams: [{ teamId: 1, weeks: [week("2042-01-05", 2)], weeksTruncated: false, dependencies: [] }, { teamId: 2, weeks: [], weeksTruncated: false, dependencies: [violatedLink()] }] };
const CURRENT: SavedProposalRecord = { ...SAVED_RECORD, check: STORED_CHECK };
const CHANGED: SavedProposalRecord = { ...CURRENT, state: "CHANGED", can: { accept: false, delete: true } };

const posts = (url: string) => mockFetch.mock.calls.filter(([u, init]) => String(u) === url && (init as RequestInit | undefined)?.method === "POST").map(([, init]) => JSON.parse((init as RequestInit).body as string));
const reads = () => mockFetch.mock.calls.filter(([u, init]) => String(u) === `${SAVED_URL}/5` && (init as RequestInit | undefined)?.method === undefined).length;
// A fake clock (real time still flows for waitFor): the 300 ms debounce of the live check is advanced by hand.
const settle = () => act(() => vi.advanceTimersByTimeAsync(450));
const badge = () => document.querySelector("[data-state]");
const rowOf = (name: string) => screen.getByRole("checkbox", { name: `Accept ${name}` }).closest("tr") as HTMLElement;

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  vi.setSystemTime(new Date(2042, 0, 5, 12, 0, 0)); // the browser's today is the run's `asOf`
  record = CURRENT;
  acceptAnswer = jsonResponse(200, { revision: 13, accepted: [11, 21], skipped: [] });
  runAnswer = jsonResponse(200, RUN);
  mockFetch = routeFetch({
    [`GET ${SAVED_URL}/:id`]: () => record,
    [`POST ${RUN_URL}`]: () => runAnswer,
    [`POST ${ACCEPT_URL}`]: () => acceptAnswer,
    [`POST ${CHECK_URL}`]: () => ({ teams: [{ teamId: 1, weeks: [week("2042-01-05", 4)], weeksTruncated: false, dependencies: [] }, { teamId: 2, weeks: [], weeksTruncated: false, dependencies: [] }] }),
  });
  vi.stubGlobal("fetch", mockFetch);
  localStorage.setItem("astrolabe.auth.token", "fake-token");
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  localStorage.clear();
});

const renderPage = (id = "5", queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })) =>
  renderWithProviders(
    <Routes>
      <Route path="/schedule-proposals/saved/:id" element={<SavedScheduleProposal />} />
    </Routes>,
    { route: `/schedule-proposals/saved/${id}`, queryClient },
  );
/** What a focus or window refetch of the saved record does. */
const refetch = (queryClient: QueryClient) => act(() => queryClient.invalidateQueries({ queryKey: [...SAVED_PROPOSALS_KEY] }));

describe("a saved proposal the viewer may accept", () => {
  test("opens as the run: h2 the name, the state, the facts, the stored ticks editable, the stored check overlaid with no request", async () => {
    renderPage();
    expect(await screen.findByRole("heading", { level: 2, name: "Q1 plan" })).toBeInTheDocument();
    await screen.findByRole("button", { name: "Accept selected across teams (2)" });
    expect(headingOutline()).toEqual([[2, "Q1 plan"], [3, "Platform"], [4, "Proposed load"], [3, "Payments"], [4, "Proposed load"]]);
    expect(badge()).toHaveTextContent("Current");
    expect(screen.getByText("The plan still matches this proposal.")).toBeInTheDocument();
    expect(screen.getByText("Saved by Ada on 2042-01-05 09:30 · as of 2042-01-05 · teams: Platform, Payments · 2 of 3 moves ticked · plan revision 12")).toBeInTheDocument();
    expect(screen.getByText("Placed in 1 pass · settled")).toBeInTheDocument();
    for (const [name, checked] of [["x1", true], ["x2", false], ["y1", true]] as const) {
      const box = screen.getByRole("checkbox", { name: `Accept ${name}` });
      expect(box).toBeEnabled();
      if (checked) expect(box).toBeChecked();
      else expect(box).not.toBeChecked();
    }
    // the stored check's verdict (y1 conflicts) is the run's own table's, not the run's own dependencies (empty)
    expect(within(rowOf("y1")).getByText("Conflict")).toBeInTheDocument();
    await settle();
    expect(posts(CHECK_URL)).toEqual([]);
    expect(screen.queryByText("Checking the ticked moves…")).toBeNull();
    expect(screen.queryByRole("button", { name: "Discard" })).toBeNull();
    expect(screen.queryByText(/Computed for/)).toBeNull();
  });

  test("a changed selection asks the server's live check, and the stored ticks are the stored check again with no further request", async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByRole("button", { name: "Accept selected across teams (2)" });
    await user.click(screen.getByRole("checkbox", { name: "Accept x1" }));
    await waitFor(() => expect(posts(CHECK_URL)).toHaveLength(1));
    expect(ids(posts(CHECK_URL)[0])).toEqual([21]);
    await waitFor(() => expect(within(rowOf("y1")).queryByText("Conflict")).toBeNull());
    await user.click(screen.getByRole("checkbox", { name: "Accept x1" }));
    await waitFor(() => expect(within(rowOf("y1")).getByText("Conflict")).toBeInTheDocument());
    await settle();
    expect(posts(CHECK_URL)).toHaveLength(1);
  });

  test("Accept posts the STORED revision, scope token, teams and the ticked moves to the unchanged accept; the page then reads the refreshed state read-only", async () => {
    const user = userEvent.setup();
    renderPage();
    const accept = await screen.findByRole("button", { name: "Accept selected across teams (2)" });
    record = CHANGED; // what the refetch after the accept reads
    await user.click(accept);
    await waitFor(() => expect(posts(ACCEPT_URL)).toHaveLength(1));
    expect(posts(ACCEPT_URL)[0]).toMatchObject({ expectedRevision: 12, scopeHash: RUN.scopeHash, teamIds: [1, 2] });
    expect(ids(posts(ACCEPT_URL)[0])).toEqual([11, 21]);
    expect(await screen.findByText("2 scheduled")).toBeInTheDocument();
    await waitFor(() => expect(badge()).toHaveTextContent("Changed"));
    expect(reads()).toBe(2);
    expect(screen.queryByRole("button", { name: /Accept selected across teams/ })).toBeNull();
    expect(screen.getByRole("checkbox", { name: "Accept x1" })).toBeDisabled();
    expect(screen.getByRole("checkbox", { name: "Accept x1" })).toBeChecked();
    expect(posts(RUN_URL)).toEqual([]);
  });

  test("a stale scope on the accept re-proposes the same teams: the page then holds a fresh run, ticks kept, and says it is not the saved one", async () => {
    acceptAnswer = jsonResponse(409, STALE_SCOPE);
    const fresh: CrossTeamProposal = { ...RUN, revision: 14, scopeHash: "c".repeat(64), teams: [block(1, "Platform", [move(11, "x1", "2042-01-07", "2042-01-09"), move(13, "x3", "2042-01-12", "2042-01-12")]), block(2, "Payments", [move(21, "y1", "2042-01-13", "2042-01-15")])] };
    const user = userEvent.setup();
    renderPage();
    const accept = await screen.findByRole("button", { name: "Accept selected across teams (2)" });
    runAnswer = jsonResponse(200, fresh);
    await user.click(accept);
    expect(await screen.findByText(/The plan of the chosen teams changed since the proposal: here is a fresh one/)).toBeInTheDocument();
    await screen.findByRole("checkbox", { name: "Accept x3" });
    expect(screen.getByRole("checkbox", { name: "Accept x1" })).toBeChecked();
    expect(screen.getByRole("checkbox", { name: "Accept x3" })).not.toBeChecked();
    expect(screen.getByText(/This is a fresh run for the same teams, not the saved proposal/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Discard" })).toBeEnabled();
  });

  test("Propose again asks for the stored teams with the CURRENT ticks kept; Discard of that fresh run returns to the saved one, editable again", async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByRole("button", { name: "Accept selected across teams (2)" });
    await user.click(screen.getByRole("checkbox", { name: "Accept x2" }));
    runAnswer = jsonResponse(200, { ...RUN, revision: 14, scopeHash: "d".repeat(64) });
    await user.click(screen.getByRole("button", { name: "Propose again" }));
    await screen.findByText(/This is a fresh run for the same teams/);
    expect(posts(RUN_URL)).toEqual([{ asOf: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/), teamIds: [1, 2] }]);
    expect(screen.getByRole("button", { name: "Accept selected across teams (3)" })).toBeEnabled();
    await user.click(screen.getByRole("button", { name: "Discard" }));
    await waitFor(() => expect(screen.queryByText(/This is a fresh run/)).toBeNull());
    // the Discard button is gone with the fresh run: the focus goes to Propose again, not to the body
    await waitFor(() => expect(screen.getByRole("button", { name: "Propose again" })).toHaveFocus());
    expect(await screen.findByRole("button", { name: "Accept selected across teams (2)" })).toBeEnabled();
    expect(screen.getByRole("checkbox", { name: "Accept x2" })).not.toBeChecked();
    expect(screen.getByText("The plan still matches this proposal.")).toBeInTheDocument();
  });

  test("a 403 on the accept stays inline above the buttons", async () => {
    acceptAnswer = jsonResponse(403, { title: "Forbidden", status: 403 });
    const user = userEvent.setup();
    renderPage();
    await user.click(await screen.findByRole("button", { name: "Accept selected across teams (2)" }));
    expect(await screen.findByText("Only a manager of every listed team or an administrator can propose or accept a schedule across teams")).toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: "Accept x1" })).toBeEnabled();
  });
});

describe("a saved proposal that changes or goes away under the page", () => {
  test("a refetch that turns the record CHANGED takes the live Accept away: read-only ticks, the state said", async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    renderPage("5", client);
    await screen.findByRole("button", { name: "Accept selected across teams (2)" });
    record = CHANGED;
    await refetch(client);
    await waitFor(() => expect(badge()).toHaveTextContent("Changed"));
    expect(screen.queryByRole("button", { name: /Accept selected across teams/ })).toBeNull();
    expect(screen.getByRole("checkbox", { name: "Accept x1" })).toBeDisabled();
    expect(screen.getByRole("checkbox", { name: "Accept x1" })).toBeChecked();
    expect(screen.getByText(/can no longer be accepted/)).toBeInTheDocument();
  });

  test("a 404 refetch (deleted, or pruned by the 21st save) shows not-found over the copy kept before: no run, no Accept, and the copy is dropped", async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    renderPage("5", client);
    await screen.findByRole("button", { name: "Accept selected across teams (2)" });
    record = jsonResponse(404, { title: "Not Found", status: 404 });
    await refetch(client);
    expect(await screen.findByText("This saved proposal does not exist — it may have been deleted.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Accept selected across teams/ })).toBeNull();
    expect(screen.queryByRole("checkbox", { name: "Accept x1" })).toBeNull();
    await waitFor(() => expect(client.getQueryData(savedProposalKey(5))).toBeUndefined());
  });

  test("a stale revision on the accept closes the run with the note and reads the record again (it is CHANGED now)", async () => {
    acceptAnswer = jsonResponse(409, STALE_REVISION);
    const user = userEvent.setup();
    renderPage();
    const accept = await screen.findByRole("button", { name: "Accept selected across teams (2)" });
    record = CHANGED;
    await user.click(accept);
    expect(await screen.findByText("The plan changed in the meantime — nothing was saved. Propose again.")).toBeInTheDocument();
    await waitFor(() => expect(badge()).toHaveTextContent("Changed"));
    expect(reads()).toBe(2);
    expect(screen.queryByRole("button", { name: /Accept selected across teams/ })).toBeNull();
    expect(screen.getByRole("checkbox", { name: "Accept x1" })).toBeDisabled();
  });
});

describe("a saved proposal computed for an earlier day", () => {
  test("reads CURRENT but is not acceptable: ticks read-only, no Accept, the stored check still overlaid, a note naming the day; Propose again is the way on", async () => {
    record = { ...CURRENT, asOf: "2042-01-04", proposal: { ...RUN, asOf: "2042-01-04" } };
    const user = userEvent.setup();
    renderPage();
    await screen.findByRole("checkbox", { name: "Accept x1" });
    expect(badge()).toHaveTextContent("Current");
    expect(screen.getByText("Computed for 2042-01-04; propose again for today.")).toBeInTheDocument();
    for (const name of ["x1", "x2", "y1"]) expect(screen.getByRole("checkbox", { name: `Accept ${name}` })).toBeDisabled();
    expect(screen.getByRole("checkbox", { name: "Accept x1" })).toBeChecked();
    expect(within(rowOf("y1")).getByText("Conflict")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Accept selected across teams/ })).toBeNull();
    await settle();
    expect(posts(CHECK_URL)).toEqual([]);
    await user.click(screen.getByRole("button", { name: "Propose again" }));
    expect(await screen.findByRole("button", { name: "Accept selected across teams (2)" })).toBeEnabled();
    expect(posts(RUN_URL)[0]).toMatchObject({ asOf: "2042-01-05", teamIds: [1, 2] });
    expect(screen.queryByText(/Computed for/)).toBeNull();
    // the plan did not change: a neutral note, not "the plan changed since the proposal"
    expect(screen.getByText(/This is a fresh run for the same teams/)).toBeInTheDocument();
    expect(screen.queryByText(/changed since the proposal/)).toBeNull();
    expect(screen.getByRole("checkbox", { name: "Accept x1" })).toBeChecked();
    expect(screen.getByRole("checkbox", { name: "Accept x2" })).not.toBeChecked();
  });

  test("without the right to run the teams there is the note and no way on", async () => {
    record = { ...CURRENT, asOf: "2042-01-04", proposal: { ...RUN, asOf: "2042-01-04" }, can: { accept: false, delete: false } };
    renderPage();
    await screen.findByRole("checkbox", { name: "Accept x1" });
    expect(screen.getByText("Computed for 2042-01-04; propose again for today.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Propose again" })).toBeNull();
  });
});

describe("a saved proposal the viewer may only read", () => {
  test("the ticks are the stored ones and read-only, the stored check overlaid, no Accept; a viewer who may not run the teams has no Propose again either", async () => {
    record = { ...CURRENT, can: { accept: false, delete: false } };
    renderPage();
    await screen.findByRole("heading", { level: 2, name: "Q1 plan" });
    await screen.findByRole("checkbox", { name: "Accept x1" });
    expect(badge()).toHaveTextContent("Current");
    expect(screen.getByText(/only an administrator or the manager of every team in it can change the ticks and accept it/)).toBeInTheDocument();
    for (const name of ["x1", "x2", "y1"]) expect(screen.getByRole("checkbox", { name: `Accept ${name}` })).toBeDisabled();
    expect(screen.getByRole("checkbox", { name: "Accept x1" })).toBeChecked();
    expect(screen.getByRole("checkbox", { name: "Accept x2" })).not.toBeChecked();
    expect(within(rowOf("y1")).getByText("Conflict")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Accept selected across teams/ })).toBeNull();
    expect(screen.queryByRole("button", { name: "Propose again" })).toBeNull();
    await settle();
    expect(posts(CHECK_URL)).toEqual([]);
    expect(posts(RUN_URL)).toEqual([]);
  });

  test("a stored run with every move ticked shows the run's own verdicts: no stored check, no request", async () => {
    record = { ...CURRENT, selectedMilestoneIds: [11, 12, 21], selectedCount: 3, check: null, can: { accept: false, delete: false } };
    renderPage();
    await screen.findByRole("checkbox", { name: "Accept x2" });
    expect(screen.getByRole("checkbox", { name: "Accept x2" })).toBeChecked();
    expect(within(rowOf("y1")).queryByText("Conflict")).toBeNull();
    await settle();
    expect(posts(CHECK_URL)).toEqual([]);
  });
});

describe("a saved proposal whose plan changed", () => {
  test("a neutral Changed badge with its words, the stored run read-only, no Accept; Propose again opens a fresh run with the stored ticks", async () => {
    record = CHANGED;
    runAnswer = jsonResponse(200, { ...RUN, revision: 14, scopeHash: "d".repeat(64) });
    const user = userEvent.setup();
    renderPage();
    await screen.findByRole("checkbox", { name: "Accept x1" });
    expect(badge()).toHaveTextContent("Changed");
    expect(screen.getByText(/can no longer be accepted/)).toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: "Accept x1" })).toBeDisabled();
    expect(screen.queryByRole("button", { name: /Accept selected across teams/ })).toBeNull();
    await user.click(screen.getByRole("button", { name: "Propose again" }));
    expect(await screen.findByRole("button", { name: "Accept selected across teams (2)" })).toBeEnabled();
    expect(posts(RUN_URL)[0]).toMatchObject({ teamIds: [1, 2] });
    expect(screen.getByText(/The plan of the chosen teams changed since the proposal: here is a fresh one/)).toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: "Accept x1" })).toBeChecked();
    expect(screen.getByRole("checkbox", { name: "Accept x2" })).not.toBeChecked();
    // Discard returns to the saved, read-only run: nothing reopens it for acceptance
    await user.click(screen.getByRole("button", { name: "Discard" }));
    await waitFor(() => expect(screen.queryByRole("button", { name: /Accept selected across teams/ })).toBeNull());
    expect(screen.getByRole("checkbox", { name: "Accept x1" })).toBeDisabled();
  });
});

describe("a saved proposal that can no longer be read", () => {
  test("says so, shows no run, and Propose again keeps the stored ticks", async () => {
    record = { ...CURRENT, state: "UNREADABLE", proposal: null, check: null, can: { accept: false, delete: true } };
    const user = userEvent.setup();
    renderPage();
    await screen.findByText(/saved by an older version/);
    expect(badge()).toHaveTextContent("Unreadable");
    expect(screen.getByText(/saved by an older version of Astrolabe and cannot be shown/)).toBeInTheDocument();
    expect(headingOutline()).toEqual([[2, "Q1 plan"]]);
    expect(screen.queryByRole("table")).toBeNull();
    await user.click(screen.getByRole("button", { name: "Propose again" }));
    await screen.findByRole("button", { name: "Accept selected across teams (2)" });
    expect(posts(RUN_URL)).toHaveLength(1);
    expect(screen.getByRole("checkbox", { name: "Accept y1" })).toBeChecked();
    expect(screen.getByRole("checkbox", { name: "Accept x2" })).not.toBeChecked();
  });
});

describe("loading", () => {
  test("an unknown id is the not-found message with the way back, no run", async () => {
    record = jsonResponse(404, { title: "Not Found", status: 404 });
    renderPage();
    expect(await screen.findByText("This saved proposal does not exist — it may have been deleted.")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Back to schedule proposals" })).toHaveAttribute("href", "/schedule-proposals");
    expect(screen.getByRole("heading", { level: 2, name: "Saved proposal" })).toBeInTheDocument();
  });

  test("a malformed id asks nothing", async () => {
    renderPage("abc");
    expect(await screen.findByText("This saved proposal does not exist — it may have been deleted.")).toBeInTheDocument();
    expect(mockFetch).not.toHaveBeenCalled();
  });

  test("another failure is worded by its status", async () => {
    record = jsonResponse(500, { title: "Boom", status: 500 });
    renderPage();
    expect(await screen.findByText("Load failed (500)")).toBeInTheDocument();
  });
});
