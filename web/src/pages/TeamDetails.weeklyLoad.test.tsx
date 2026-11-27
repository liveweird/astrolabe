import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import userEvent from "@testing-library/user-event";
import { screen, waitFor, within } from "@testing-library/react";
import { Route, Routes, useLocation } from "react-router-dom";
import TeamDetails from "./TeamDetails";
import type { TeamView } from "../api/teams";
import { READ_ONLY_PANEL } from "../test/flow";
import { jsonResponse } from "../test/http";
import { renderWithProviders } from "../test/render";

// The weekly load table's address (1.36, `?load=overloaded|wip|nocapacity|weeks`, the Teams table's week badges): once the view has been read AND the Flow section above the
// table has answered (it grows when it does), the table opens for this visit, is scrolled to, takes the focus once, marks the first week of the badge's kind and the parameter
// leaves the address; a read still running or failed does nothing. The hook's own cases: hooks/useWeeklyLoadArrival.test.tsx.

const TEAM_VIEW: TeamView = {
  jiraSites: [],
  revision: 10,
  team: { id: 1, name: "Payments", description: null, managerPersonId: 12, managerName: "Cara New", colour: "INDIGO", createdAt: 1, updatedAt: 2, can: { schedule: false, editCapacity: false, editOrder: false }, flags: [] },
  order: { custom: false, revision: 4, milestoneIds: [] },
  capacity: { periods: [] },
  weeks: [
    { weekStart: "2027-02-01", load: 14, capacity: 10, overloaded: true, overloadMd: 4, maxWip: 1, wipExceeded: false },
    { weekStart: "2027-02-08", load: 6, capacity: 10, overloaded: false, overloadMd: null, maxWip: 1, wipExceeded: false },
    { weekStart: "2027-02-15", load: 6, capacity: 10, overloaded: false, overloadMd: null, maxWip: 3, wipExceeded: true },
  ],
  weeksTruncated: false,
  scheduled: [],
  unscheduled: [],
  dependencies: [],
  idleGaps: [],
};

let answer: () => Response | Promise<Response>;
let flowAnswer: () => Response | Promise<Response>;

function Where() {
  const location = useLocation();
  return <p data-testid="where">{location.pathname + location.search}</p>;
}

const renderPage = (route: string) =>
  renderWithProviders(
    <main id="main-content" tabIndex={-1}>
      <Routes>
        <Route
          path="/teams/:id"
          element={
            <>
              <TeamDetails />
              <Where />
            </>
          }
        />
      </Routes>
    </main>,
    { route },
  );

/** Everything the browser remembers, key by key. */
const stored = () => Object.fromEntries(Array.from({ length: localStorage.length }, (_, index) => localStorage.key(index)!).map((key) => [key, localStorage.getItem(key)]));
const showButton = () => screen.findByRole("button", { name: "Show the weekly figures" });
const region = () => screen.findByRole("region", { name: "Weekly load of the team" });

describe("the team page: ?load=weeks opens and focuses the weekly load table", () => {
  beforeEach(() => {
    answer = () => jsonResponse(200, TEAM_VIEW);
    flowAnswer = () => jsonResponse(200, READ_ONLY_PANEL);
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string) => {
        if (url === "/api/v1/views/team/1") return Promise.resolve(answer());
        if (url === "/api/v1/public-holidays") return Promise.resolve(jsonResponse(200, { items: [] }));
        if (url === "/api/v1/teams/1/flow") return Promise.resolve(flowAnswer());
        return Promise.resolve(jsonResponse(404, { title: "Not Found", status: 404 }));
      }),
    );
    localStorage.setItem("astrolabe.auth.token", "fake-token");
    localStorage.setItem("astrolabe.auth.roles", JSON.stringify(["USER"]));
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    localStorage.clear();
  });

  test("the table opens, takes the focus and the parameter leaves the address by replace, the others kept; nothing is written to the browser's memory", async () => {
    const before = stored();
    renderPage("/teams/1?load=weeks&x=1");
    const table = await screen.findByRole("table", { name: "Weekly load of the team" });
    expect(within(table).getAllByRole("row")).toHaveLength(4);
    expect(screen.getByRole("button", { name: "Hide the weekly figures" })).toHaveAttribute("aria-expanded", "true");
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("region", { name: "Weekly load of the team" })));
    await waitFor(() => expect(screen.getByTestId("where")).toHaveTextContent(/^\/teams\/1\?x=1$/));
    // The session layer stamps its own identity; nothing else is new (the table's state is the page's, never remembered).
    expect(Object.keys(stored()).filter((key) => !(key in before) && key !== "astrolabe.auth.sessionIdentity")).toEqual([]);
    expect(stored()["astrolabe.lang"]).toBe(before["astrolabe.lang"]);
  });

  test("without the parameter the table stays closed and nothing takes the focus", async () => {
    renderPage("/teams/1");
    await showButton();
    expect(screen.queryByRole("table", { name: "Weekly load of the team" })).toBeNull();
    expect(screen.getByTestId("where")).toHaveTextContent(/^\/teams\/1$/);
    expect(document.activeElement).toBe(document.body);
  });

  test("an unknown value of the parameter opens nothing and is left alone", async () => {
    renderPage("/teams/1?load=other");
    await showButton();
    expect(screen.queryByRole("table", { name: "Weekly load of the team" })).toBeNull();
    expect(screen.getByTestId("where")).toHaveTextContent("/teams/1?load=other");
  });

  test("the open table is the user's: closing it keeps it closed, and the focus is not taken again", async () => {
    const user = userEvent.setup();
    renderPage("/teams/1?load=weeks");
    await region();
    await waitFor(() => expect(screen.getByTestId("where")).toHaveTextContent(/^\/teams\/1$/));
    await user.click(screen.getByRole("button", { name: "Hide the weekly figures" }));
    expect(screen.queryByRole("table", { name: "Weekly load of the team" })).toBeNull();
    await user.click(await showButton());
    expect(await region()).not.toBe(document.activeElement);
  });

  test("a read still running does nothing: the table opens, with the focus, when the answer arrives", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    answer = () => gate.then(() => jsonResponse(200, TEAM_VIEW));
    renderPage("/teams/1?load=weeks");
    await waitFor(() => expect(vi.mocked(fetch).mock.calls.some(([url]) => url === "/api/v1/views/team/1")).toBe(true));
    expect(screen.queryByRole("region", { name: "Weekly load of the team" })).toBeNull();
    expect(screen.getByTestId("where")).toHaveTextContent("/teams/1?load=weeks");
    release();
    await screen.findByRole("table", { name: "Weekly load of the team" });
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("region", { name: "Weekly load of the team" })));
    await waitFor(() => expect(screen.getByTestId("where")).toHaveTextContent(/^\/teams\/1$/));
  });

  test("a failed read does nothing: no table, the address kept", async () => {
    answer = () => jsonResponse(500, { title: "Boom", status: 500 });
    renderPage("/teams/1?load=weeks");
    await waitFor(() => expect(screen.getByRole("link", { name: /Back to/ })).toBeInTheDocument());
    expect(screen.queryByRole("table", { name: "Weekly load of the team" })).toBeNull();
    expect(screen.getByTestId("where")).toHaveTextContent("/teams/1?load=weeks");
  });

  test("a team with no week listed focuses the section's heading and still drops the parameter", async () => {
    answer = () => jsonResponse(200, { ...TEAM_VIEW, weeks: [] });
    renderPage("/teams/1?load=weeks");
    const heading = await screen.findByRole("heading", { level: 3, name: "Weekly load" });
    await waitFor(() => expect(document.activeElement).toBe(heading));
    await waitFor(() => expect(screen.getByTestId("where")).toHaveTextContent(/^\/teams\/1$/));
  });

  test.each([
    ["overloaded", "2027-02-01"],
    ["wip", "2027-02-15"],
  ])("?load=%s marks the first such week (aria-current) and nothing else", async (word, monday) => {
    renderPage(`/teams/1?load=${word}`);
    const table = await screen.findByRole("table", { name: "Weekly load of the team" });
    await waitFor(() => expect(screen.getByTestId("where")).toHaveTextContent(/^\/teams\/1$/));
    const marked = within(table).getAllByRole("row").filter((row) => row.getAttribute("aria-current") === "true");
    expect(marked).toHaveLength(1);
    expect(marked[0]).toHaveTextContent(monday);
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("region", { name: "Weekly load of the team" })));
  });

  test("?load=weeks opens the table and marks no week", async () => {
    renderPage("/teams/1?load=weeks");
    const table = await screen.findByRole("table", { name: "Weekly load of the team" });
    expect(within(table).queryAllByRole("row").filter((row) => row.hasAttribute("aria-current"))).toHaveLength(0);
  });

  describe("the Flow section above the table", () => {
    const original = Element.prototype.scrollIntoView;
    afterEach(() => {
      Element.prototype.scrollIntoView = original;
    });

    test("the landing waits for its answer: the section grows when it lands, so the table is scrolled to only after, then", async () => {
      const scrolled = vi.fn();
      Element.prototype.scrollIntoView = scrolled;
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      flowAnswer = () => gate.then(() => jsonResponse(200, READ_ONLY_PANEL));
      renderPage("/teams/1?load=overloaded");
      // the team view is here (its heading shows), the Flow panel is not
      await screen.findByRole("heading", { level: 2, name: "Payments" });
      await screen.findByRole("button", { name: "Show the weekly figures" });
      expect(scrolled).not.toHaveBeenCalled();
      expect(screen.queryByRole("table", { name: "Weekly load of the team" })).toBeNull();
      expect(screen.getByTestId("where")).toHaveTextContent("/teams/1?load=overloaded");
      release();
      await screen.findByRole("table", { name: "Weekly load of the team" });
      // the region is scrolled to, then the marked row is brought in (a viewport shorter than the region)
      await waitFor(() => expect(scrolled).toHaveBeenCalledTimes(2));
      expect(scrolled.mock.contexts[0]).toBe(screen.getByRole("region", { name: "Weekly load of the team" }));
      expect(scrolled.mock.contexts[1]).toBe(screen.getByRole("row", { name: /2027-02-01/ }));
      expect(scrolled).toHaveBeenLastCalledWith({ block: "nearest" });
      expect(document.activeElement).toBe(screen.getByRole("region", { name: "Weekly load of the team" }));
      await waitFor(() => expect(screen.getByTestId("where")).toHaveTextContent(/^\/teams\/1$/));
    });

    test("a Flow panel that fails to load still lets the landing happen (the section's layout is final)", async () => {
      flowAnswer = () => jsonResponse(500, { title: "Boom", status: 500 });
      renderPage("/teams/1?load=wip");
      await screen.findByRole("table", { name: "Weekly load of the team" });
      await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("region", { name: "Weekly load of the team" })));
    });
  });
});
