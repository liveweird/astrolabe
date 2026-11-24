import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import userEvent from "@testing-library/user-event";
import { screen, waitFor, within } from "@testing-library/react";
import ScheduleProposals from "./ScheduleProposals";
import { RUN, RUN_URL, SAVED, SAVED_URL, STALE_SCOPE, TEAMS_URL } from "../test/crossTeamRun";
import { jsonResponse, routeFetch } from "../test/http";
import { renderWithProviders } from "../test/render";

// "Save proposal" on the cross-team page and its "Saved proposals" section: the run is kept by the server, the list follows.

let saved: unknown[];
let saveAnswer: Response;
let teams: unknown[];
let mockFetch: ReturnType<typeof routeFetch>;

const posts = (url: string) => mockFetch.mock.calls.filter(([u, init]) => String(u) === url && (init as RequestInit | undefined)?.method === "POST").map(([, init]) => JSON.parse((init as RequestInit).body as string));

beforeEach(() => {
  saved = [];
  teams = [{ id: 1, name: "Platform" }, { id: 2, name: "Payments" }];
  saveAnswer = jsonResponse(201, SAVED);
  mockFetch = routeFetch({
    [`GET ${TEAMS_URL}`]: () => ({ items: teams }),
    [`GET ${SAVED_URL}`]: () => ({ items: saved }),
    [`POST ${SAVED_URL}`]: () => {
      if (saveAnswer.status === 201) saved = [SAVED];
      return saveAnswer;
    },
    [`POST ${RUN_URL}`]: RUN,
  });
  vi.stubGlobal("fetch", mockFetch);
  localStorage.setItem("astrolabe.auth.token", "fake-token");
});

afterEach(() => {
  vi.unstubAllGlobals();
  localStorage.clear();
});

async function openRun(user: ReturnType<typeof userEvent.setup>) {
  renderWithProviders(<ScheduleProposals />);
  await screen.findByRole("combobox", { name: "Teams" });
  for (const name of ["Platform", "Payments"]) {
    await user.click(screen.getByRole("combobox", { name: "Teams" }));
    await user.click(await screen.findByRole("option", { name }));
  }
  await user.click(screen.getByRole("button", { name: "Propose" }));
  await screen.findByRole("button", { name: "Discard" });
}

describe("Save proposal", () => {
  test("is offered with the open run only, and off while nothing is ticked", async () => {
    const user = userEvent.setup();
    renderWithProviders(<ScheduleProposals />);
    await screen.findByRole("combobox", { name: "Teams" });
    expect(screen.queryByRole("button", { name: "Save proposal" })).toBeNull();
    await user.click(screen.getByRole("combobox", { name: "Teams" }));
    await user.click(await screen.findByRole("option", { name: "Platform" }));
    await user.click(screen.getByRole("button", { name: "Propose" }));
    await screen.findByRole("button", { name: "Discard" });
    expect(screen.getByRole("button", { name: "Save proposal" })).toBeEnabled();
    for (const name of ["x1", "x2"]) await user.click(screen.getByRole("checkbox", { name: `Accept ${name}` }));
    await user.click(screen.getByRole("checkbox", { name: "Accept y1" }));
    expect(screen.getByRole("button", { name: "Save proposal" })).toBeDisabled();
  });

  test("closing the dialog (Cancel, or a save) gives the focus back to Save proposal", async () => {
    const user = userEvent.setup();
    await openRun(user);
    await user.click(screen.getByRole("button", { name: "Save proposal" }));
    await user.click(within(await screen.findByRole("dialog", { name: "Save proposal" })).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await waitFor(() => expect(screen.getByRole("button", { name: "Save proposal" })).toHaveFocus());
  });

  test("a name saves the run with the ticked moves, closes the dialog, announces it and the Saved proposals table lists it", async () => {
    const user = userEvent.setup();
    await openRun(user);
    await user.click(screen.getByRole("checkbox", { name: "Accept x2" }));
    await user.click(screen.getByRole("button", { name: "Save proposal" }));
    const dialog = await screen.findByRole("dialog", { name: "Save proposal" });
    await user.type(within(dialog).getByRole("textbox", { name: "Name" }), "Q1 plan");
    await user.click(within(dialog).getByRole("button", { name: "Save proposal" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(posts(SAVED_URL)).toEqual([{ name: "Q1 plan", asOf: "2042-01-05", teamIds: [1, 2], expectedRevision: 12, scopeHash: RUN.scopeHash, selectedMilestoneIds: [11, 21] }]);
    expect(await screen.findByRole("link", { name: "Open Q1 plan" })).toHaveAttribute("href", "/schedule-proposals/saved/5");
    expect(screen.getAllByRole("status").map((region) => region.textContent).join(" ")).toContain("Proposal saved");
    // the run stays open: saving is not accepting
    expect(screen.getByRole("button", { name: "Accept selected across teams (2)" })).toBeEnabled();
  });

  test("a stale-scope 409 says so in the dialog and Propose again re-runs the same teams with the ticks kept", async () => {
    saveAnswer = jsonResponse(409, STALE_SCOPE);
    const user = userEvent.setup();
    await openRun(user);
    await user.click(screen.getByRole("checkbox", { name: "Accept x2" }));
    await user.click(screen.getByRole("button", { name: "Save proposal" }));
    const dialog = await screen.findByRole("dialog", { name: "Save proposal" });
    await user.type(within(dialog).getByRole("textbox", { name: "Name" }), "Q1 plan");
    await user.click(within(dialog).getByRole("button", { name: "Save proposal" }));
    expect(await within(dialog).findByText(/it was not saved/)).toBeInTheDocument();
    await user.click(within(dialog).getByRole("button", { name: "Propose again" }));
    await waitFor(() => expect(posts(RUN_URL)).toHaveLength(2));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(posts(RUN_URL)[1]).toMatchObject({ teamIds: [1, 2] });
    expect(await screen.findByText(/The plan of the chosen teams changed since the proposal: here is a fresh one/)).toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: "Accept x1" })).toBeChecked();
    expect(screen.getByRole("checkbox", { name: "Accept x2" })).not.toBeChecked();
    expect(saved).toEqual([]);
  });
});

describe("the Saved proposals section", () => {
  test("is read by everyone: a caller who manages no team still sees it", async () => {
    teams = [];
    saved = [SAVED];
    renderWithProviders(<ScheduleProposals />);
    expect(await screen.findByText("You manage no team")).toBeInTheDocument();
    expect(await screen.findByRole("link", { name: "Open Q1 plan" })).toBeInTheDocument();
  });
});
