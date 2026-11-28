import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import userEvent from "@testing-library/user-event";
import { screen, waitFor, within } from "@testing-library/react";
import Programs from "./Programs";
import { CHECK_URL, RUN_URL, SAVED, SAVED_URL, STALE_SCOPE, TEAMS_URL } from "../test/crossTeamRun";
import { jsonResponse, routeFetch } from "../test/http";
import { RUN, TEAMS, TEAM_LIST, viewOf } from "../test/overviewRun";
import { renderWithProviders } from "../test/render";

// "Save proposal" on the Roadmap overview's run and the "Saved proposals" panel under its timeline: the run is kept by the server, the list follows.

let saved: unknown[];
let saveAnswer: Response;
let teams: unknown[];
let mockFetch: ReturnType<typeof routeFetch>;

const posts = (url: string) => mockFetch.mock.calls.filter(([u, init]) => String(u) === url && (init as RequestInit | undefined)?.method === "POST").map(([, init]) => JSON.parse((init as RequestInit).body as string));

beforeEach(() => {
  saved = [];
  teams = TEAMS;
  saveAnswer = jsonResponse(201, SAVED);
  mockFetch = routeFetch({
    "GET /api/v1/teams": TEAM_LIST,
    "GET /api/v1/views/programs": () => viewOf(),
    "GET /api/v1/public-holidays": { items: [] },
    "GET /api/v1/baselines": { items: [], can: { manage: false } },
    [`GET ${TEAMS_URL}`]: () => ({ items: teams, truncated: false }),
    [`GET ${SAVED_URL}`]: () => ({ items: saved }),
    [`POST ${SAVED_URL}`]: () => {
      if (saveAnswer.status === 201) saved = [SAVED];
      return saveAnswer;
    },
    [`POST ${RUN_URL}`]: RUN,
    // The open run is checked after a tick, which can land while a test is still arranging; an unrouted call fails the test.
    [`POST ${CHECK_URL}`]: { teams: [] },
  });
  vi.stubGlobal("fetch", mockFetch);
  localStorage.setItem("astrolabe.auth.token", "fake-token");
});

afterEach(() => {
  vi.unstubAllGlobals();
  localStorage.clear();
});

async function openRun(user: ReturnType<typeof userEvent.setup>) {
  renderWithProviders(<Programs />, { route: "/roadmap?mode=overview" });
  const propose = await screen.findByRole("button", { name: "Propose schedule" });
  await waitFor(() => expect(propose).toBeEnabled());
  await user.click(propose);
  await screen.findByRole("button", { name: "Discard" });
}

describe("Save proposal", () => {
  test("is offered with the open run only, and off while nothing is ticked", async () => {
    const user = userEvent.setup();
    await openRun(user);
    expect(screen.getByRole("button", { name: "Save proposal" })).toBeEnabled();
    for (const name of ["a1", "a2", "b1", "g1"]) await user.click(screen.getByRole("checkbox", { name: `Accept ${name}` }));
    expect(screen.getByRole("button", { name: "Save proposal" })).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "Discard" }));
    expect(screen.queryByRole("button", { name: "Save proposal" })).toBeNull();
  });

  test("closing the dialog (Cancel, or a save) gives the focus back to Save proposal", async () => {
    const user = userEvent.setup();
    await openRun(user);
    await user.click(screen.getByRole("button", { name: "Save proposal" }));
    await user.click(within(await screen.findByRole("dialog", { name: "Save proposal" })).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await waitFor(() => expect(screen.getByRole("button", { name: "Save proposal" })).toHaveFocus());
  });

  test("a name saves the run with the ticked moves, closes the dialog, announces it and the Saved proposals panel lists it; the run stays open", async () => {
    localStorage.setItem("astrolabe.viewSettings.roadmap.savedProposalsOpen", "true");
    const user = userEvent.setup();
    await openRun(user);
    await user.click(screen.getByRole("checkbox", { name: "Accept a2" }));
    await user.click(screen.getByRole("button", { name: "Save proposal" }));
    const dialog = await screen.findByRole("dialog", { name: "Save proposal" });
    await user.type(within(dialog).getByRole("textbox", { name: "Name" }), "Q1 plan");
    await user.click(within(dialog).getByRole("button", { name: "Save proposal" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(posts(SAVED_URL)).toEqual([{ name: "Q1 plan", asOf: RUN.asOf, teamIds: [1, 2, 3], expectedRevision: 12, scopeHash: RUN.scopeHash, selectedMilestoneIds: [11, 21, 31] }]);
    expect(await screen.findByRole("link", { name: "Open Q1 plan" })).toHaveAttribute("href", "/roadmap?mode=overview&proposal=5");
    expect(screen.getAllByRole("status").map((region) => region.textContent).join(" ")).toContain("Proposal saved");
    expect(screen.getByRole("heading", { level: 3, name: "Saved proposals (1)" })).toBeInTheDocument();
    // saving is not accepting: the run stays open
    expect(screen.getByRole("button", { name: "Accept selected (3)" })).toBeEnabled();
  });

  test("a stale-scope 409 says so in the dialog and Propose again re-runs the same teams with the ticks kept", async () => {
    saveAnswer = jsonResponse(409, STALE_SCOPE);
    const user = userEvent.setup();
    await openRun(user);
    await user.click(screen.getByRole("checkbox", { name: "Accept a2" }));
    await user.click(screen.getByRole("button", { name: "Save proposal" }));
    const dialog = await screen.findByRole("dialog", { name: "Save proposal" });
    await user.type(within(dialog).getByRole("textbox", { name: "Name" }), "Q1 plan");
    await user.click(within(dialog).getByRole("button", { name: "Save proposal" }));
    expect(await within(dialog).findByText(/it was not saved/)).toBeInTheDocument();
    await user.click(within(dialog).getByRole("button", { name: "Propose again" }));
    await waitFor(() => expect(posts(RUN_URL)).toHaveLength(2));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(posts(RUN_URL)[1]).toMatchObject({ teamIds: [1, 2, 3] });
    expect(await screen.findByText(/The plan of the chosen teams changed since the proposal: here is a fresh one/)).toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: "Accept a1" })).toBeChecked();
    expect(screen.getByRole("checkbox", { name: "Accept a2" })).not.toBeChecked();
    expect(saved).toEqual([]);
  });
});

describe("the Saved proposals panel", () => {
  test("is read by everyone: a viewer who manages no team still sees it and its count, hidden until asked for", async () => {
    teams = [];
    saved = [SAVED];
    const user = userEvent.setup();
    renderWithProviders(<Programs />, { route: "/roadmap?mode=overview" });
    expect(await screen.findByRole("heading", { level: 3, name: "Saved proposals (1)" })).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Open Q1 plan" })).toBeNull();
    await user.click(screen.getByRole("button", { name: "Show the saved proposals" }));
    expect(await screen.findByRole("link", { name: "Open Q1 plan" })).toBeInTheDocument();
  });
});
