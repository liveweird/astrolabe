import { afterEach, beforeEach, expect, test, vi } from "vitest";
import userEvent from "@testing-library/user-event";
import { act, screen, waitFor } from "@testing-library/react";
import Roadmap from "./Roadmap";
import type { RoadmapActions } from "../components/RoadmapTimeline";
import { routeFetch } from "../test/http";
import { DASHBOARDS, INVOICES, RUN, TEAMS, TEAM_LIST } from "../test/overviewRun";
import { renderWithProviders } from "../test/render";
import { roadmapView } from "../test/roadmapView";

// The row menu hides the ranking and window items while a proposal is open, so the page's guard on the actions behind them cannot be reached through the DOM: the timeline is
// replaced here by a probe that hands the test the page's `actions`, and each one is called as a stale menu or a keyboard path would call it.

let actions: RoadmapActions | null = null;
vi.mock("../components/RoadmapTimeline", () => ({
  default: (props: { actions: RoadmapActions }) => {
    actions = props.actions;
    return null;
  },
}));

let mockFetch: ReturnType<typeof routeFetch>;

beforeEach(() => {
  actions = null;
  const view = roadmapView({ revision: 7, can: { editRank: true }, teams: TEAMS, ranked: [{ position: 1, project: { ...INVOICES, rankPosition: 1 } }], unranked: [DASHBOARDS] });
  mockFetch = routeFetch({
    "GET /api/v1/teams": TEAM_LIST,
    "GET /api/v1/views/roadmap": view,
    "GET /api/v1/public-holidays": { items: [] },
    "GET /api/v1/baselines": { items: [], can: { manage: false } },
    "GET /api/v1/schedule-proposals/teams": { items: TEAMS, truncated: false },
    "POST /api/v1/schedule-proposals": RUN,
    "POST /api/v1/schedule-proposals/check": { teams: [] },
  });
  vi.stubGlobal("fetch", mockFetch);
  localStorage.setItem("astrolabe.auth.token", "fake-token");
});

afterEach(() => {
  vi.unstubAllGlobals();
  localStorage.clear();
});

const writes = () => mockFetch.mock.calls.filter(([, init]) => ["PUT", "DELETE"].includes((init as RequestInit | undefined)?.method ?? "GET"));

test("while a proposal is open every ranking and window action is refused out loud and writes nothing", async () => {
  const user = userEvent.setup();
  renderWithProviders(<Roadmap />, { route: "/roadmap?mode=prioritization" });
  const propose = await screen.findByRole("button", { name: "Propose schedule" });
  await waitFor(() => expect(propose).toBeEnabled());
  await user.click(propose);
  await screen.findByRole("heading", { name: "Schedule proposal" });
  const open = () => {
    if (actions === null) throw new Error("the timeline was not rendered");
    return actions;
  };
  act(() => open().move(INVOICES, 1));
  act(() => open().moveTo(INVOICES, "top"));
  act(() => open().rank(DASHBOARDS));
  act(() => open().unrank(INVOICES));
  act(() => open().window.clear(INVOICES));
  expect(screen.getAllByRole("status").map((region) => region.textContent).join(" | ")).toContain("A proposal is open, so the schedule is read-only");
  expect(screen.getAllByRole("note").map((note) => note.textContent).join("|")).toContain("A proposal is open, so the schedule is read-only");
  expect(writes()).toEqual([]);
});
