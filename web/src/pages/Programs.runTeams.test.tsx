import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import userEvent from "@testing-library/user-event";
import { screen, waitFor, within } from "@testing-library/react";
import Programs from "./Programs";
import { CHECK_URL, RUN_URL, SAVED, SAVED_RECORD, SAVED_URL, TEAMS_URL } from "../test/crossTeamRun";
import { routeFetch } from "../test/http";
import { RUN, TEAMS, TEAM_LIST, viewOf } from "../test/overviewRun";
import { renderWithProviders } from "../test/render";
import { localIsoDate } from "../utils/isoDate";

// The Roadmap overview's team picker (1.38): the run is asked over the page's own set until the viewer picks any other active team; an untouched picker asks exactly what the page always asked,
// a changed one has a reset, the picker is off while a run is requested or open, and an empty or oversized set keeps Propose off with its reason.

let rights: { id: number; name: string }[];
let runAnswer: () => unknown;
let mockFetch: ReturnType<typeof routeFetch>;

beforeEach(() => {
  rights = TEAMS;
  runAnswer = () => RUN;
  mockFetch = routeFetch({
    "GET /api/v1/teams": TEAM_LIST,
    "GET /api/v1/views/programs": () => viewOf(),
    "GET /api/v1/public-holidays": { items: [] },
    "GET /api/v1/baselines": { items: [], can: { manage: false } },
    [`GET ${SAVED_URL}`]: { items: [] },
    [`GET ${SAVED_URL}/:id`]: () => ({ ...SAVED_RECORD, id: SAVED.id, proposal: { ...RUN, teams: RUN.teams.slice(1) }, selectedMilestoneIds: [21, 31] }),
    [`GET ${TEAMS_URL}`]: () => ({ items: rights, truncated: false }),
    [`POST ${RUN_URL}`]: () => runAnswer(),
    [`POST ${CHECK_URL}`]: { teams: [] },
  });
  vi.stubGlobal("fetch", mockFetch);
  localStorage.setItem("astrolabe.auth.token", "fake-token");
});

afterEach(() => {
  vi.unstubAllGlobals();
  localStorage.clear();
});

const posted = () => mockFetch.mock.calls.filter(([u, init]) => String(u) === RUN_URL && (init as RequestInit | undefined)?.method === "POST").map(([, init]) => JSON.parse((init as RequestInit).body as string) as Record<string, unknown>);
const proposeButton = () => screen.getByRole("button", { name: "Propose schedule" });
const picker = () => screen.getByRole("combobox", { name: "Teams in the run" });
const pills = () => [...document.querySelectorAll(".mantine-MultiSelect-pill")].map((pill) => pill.textContent);
const resetButton = () => screen.queryByRole("button", { name: "Use this page's teams" });

async function opened(route = "/roadmap?mode=overview") {
  renderWithProviders(<Programs />, { route });
  await screen.findByRole("grid", { name: "Programs timeline" });
  await waitFor(() => expect(proposeButton()).toBeEnabled());
  await waitFor(() => expect(pills().length).toBeGreaterThan(0));
}
async function toggle(user: ReturnType<typeof userEvent.setup>, team: string) {
  await user.click(picker());
  await user.click(await screen.findByRole("option", { name: team }));
}

describe("the run's team picker on the overview", () => {
  test("starts from the page's teams, has no reset, and an untouched picker asks for exactly the page's set", async () => {
    const user = userEvent.setup();
    await opened();
    expect(pills()).toEqual(["Alpha", "Beta", "Gamma"]);
    expect(resetButton()).toBeNull();
    await user.click(proposeButton());
    await screen.findByRole("heading", { name: "Schedule proposal" });
    expect(posted()).toEqual([{ asOf: localIsoDate(), teamIds: [1, 2, 3] }]);
  });

  test("follows the program pick while untouched", async () => {
    await opened("/roadmap?mode=overview&programId=10");
    expect(pills()).toEqual(["Alpha", "Beta"]);
  });

  test("any active team can be added, even one no project of the plan uses; the row says so", async () => {
    const user = userEvent.setup();
    await opened();
    await toggle(user, "Delta");
    await waitFor(() => expect(pills()).toEqual(["Alpha", "Beta", "Gamma", "Delta"]));
    expect(screen.getByText("Proposes dates for the 4 teams you chose. Nothing changes until you accept.")).toBeInTheDocument();
    await user.click(proposeButton());
    await screen.findByRole("heading", { name: "Schedule proposal" });
    expect(posted()).toEqual([{ asOf: localIsoDate(), teamIds: [1, 2, 3, 4] }]);
  });

  test("a narrowed set is asked as chosen; the reset appears and puts the page's set back", async () => {
    const user = userEvent.setup();
    await opened();
    await toggle(user, "Beta");
    await waitFor(() => expect(pills()).toEqual(["Alpha", "Gamma"]));
    await user.click(screen.getByRole("button", { name: "Use this page's teams" }));
    await waitFor(() => expect(pills()).toEqual(["Alpha", "Beta", "Gamma"]));
    expect(resetButton()).toBeNull();
    await user.click(proposeButton());
    await screen.findByRole("heading", { name: "Schedule proposal" });
    expect(posted()).toEqual([{ asOf: localIsoDate(), teamIds: [1, 2, 3] }]);
  });

  test("choosing the page's set again by hand is no change (no reset)", async () => {
    const user = userEvent.setup();
    await opened();
    await toggle(user, "Beta");
    await waitFor(() => expect(resetButton()).not.toBeNull());
    await toggle(user, "Beta");
    await waitFor(() => expect(resetButton()).toBeNull());
  });

  test("an empty choice keeps Propose off and says to choose a team", async () => {
    const user = userEvent.setup();
    await opened();
    await user.click(screen.getByLabelText("Clear the chosen teams"));
    expect(await screen.findByText("Choose at least one team.")).toBeInTheDocument();
    expect(proposeButton()).toBeDisabled();
    expect(proposeButton()).toHaveAccessibleDescription("Choose at least one team.");
    await user.click(proposeButton());
    expect(posted()).toEqual([]);
  });

  test("the picker is not drawn while a run is open (its sections name the teams); Discard gives it back with the choice kept", async () => {
    const user = userEvent.setup();
    await opened();
    await toggle(user, "Beta");
    await waitFor(() => expect(pills()).toEqual(["Alpha", "Gamma"]));
    await user.click(proposeButton());
    await screen.findByRole("heading", { name: "Schedule proposal" });
    expect(screen.queryByRole("combobox", { name: "Teams in the run" })).toBeNull();
    expect(resetButton()).toBeNull();
    await user.click(screen.getByRole("button", { name: "Discard" }));
    await waitFor(() => expect(picker()).toBeEnabled());
    expect(pills()).toEqual(["Alpha", "Gamma"]);
  });

  test("a chosen team set's run says how many projects it moves outside the program pick; the default run stays silent", async () => {
    const user = userEvent.setup();
    await opened("/roadmap?mode=overview&programId=10");
    await user.click(proposeButton());
    await screen.findByRole("heading", { name: "Schedule proposal" });
    expect(screen.queryByText(/outside the current pick/)).toBeNull();
    await user.click(screen.getByRole("button", { name: "Discard" }));
    await waitFor(() => expect(picker()).toBeEnabled());
    await toggle(user, "Delta");
    await waitFor(() => expect(pills()).toEqual(["Alpha", "Beta", "Delta"]));
    await user.click(proposeButton());
    await screen.findByRole("heading", { name: "Schedule proposal" });
    const note = screen.getByText("1 of the projects this proposal moves is outside the current pick");
    expect(within(note.parentElement as HTMLElement).getByRole("button", { name: "Show every program" })).toBeInTheDocument();
  });

  test("a pick change under an open run leaves no stale picker: it stays away, and comes back with the page's new set after Discard", async () => {
    const user = userEvent.setup();
    await opened("/roadmap?mode=overview&programId=10");
    await toggle(user, "Delta");
    await user.click(proposeButton());
    await screen.findByRole("heading", { name: "Schedule proposal" });
    await user.click(screen.getByRole("button", { name: "Show every program" }));
    expect(screen.queryByRole("combobox", { name: "Teams in the run" })).toBeNull();
    await user.click(screen.getByRole("button", { name: "Discard" }));
    await waitFor(() => expect(picker()).toBeEnabled());
    expect(pills()).toEqual(["Alpha", "Beta", "Delta"]);
  });

  test("a saved proposal's run draws no picker either", async () => {
    renderWithProviders(<Programs />, { route: `/roadmap?mode=overview&proposal=${SAVED.id}` });
    await screen.findByRole("heading", { name: /^Saved proposal:/ });
    expect(screen.queryByRole("combobox", { name: "Teams in the run" })).toBeNull();
    expect(resetButton()).toBeNull();
  });

  test("a manager who picks only their own team gets Save; with the page's set they do not", async () => {
    rights = [TEAMS[0]];
    const user = userEvent.setup();
    await opened();
    await user.click(proposeButton());
    await screen.findByRole("heading", { name: "Schedule proposal" });
    expect(screen.queryByRole("button", { name: "Save proposal" })).toBeNull();
    await user.click(screen.getByRole("button", { name: "Discard" }));
    await waitFor(() => expect(picker()).toBeEnabled());
    await user.click(screen.getByLabelText("Clear the chosen teams"));
    await toggle(user, "Alpha");
    await waitFor(() => expect(pills()).toEqual(["Alpha"]));
    runAnswer = () => ({ ...RUN, teams: [RUN.teams[0]] });
    await user.click(proposeButton());
    await screen.findByRole("heading", { name: "Schedule proposal" });
    expect(posted()[1]).toEqual({ asOf: localIsoDate(), teamIds: [1] });
    expect(screen.getByRole("button", { name: "Save proposal" })).toBeEnabled();
  });
});
