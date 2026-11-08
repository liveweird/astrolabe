import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import userEvent from "@testing-library/user-event";
import { screen, within } from "@testing-library/react";
import { Route, Routes } from "react-router-dom";
import TeamDetails from "./TeamDetails";
import type { CapacityPeriod, TeamView } from "../api/teams";
import { APPLIED, PREVIEW, UNLINKED_PANEL, linkedPanel } from "../test/flow";
import { headingOutline } from "../test/headings";
import { jsonResponse } from "../test/http";
import { renderWithProviders } from "../test/render";

// The team page's Flow section (1.5): composed after Capacity, read from its OWN endpoint, and an import refreshes the team view (the capacity table
// and the weekly load) without a reload.

const FLOW_PERIOD: CapacityPeriod = { id: 40, teamId: 1, effectiveFrom: "2026-11-09", mdPerWeek: 20, wipLimit: null, createdAt: 1, updatedAt: 2, source: "FLOW", flowSprintName: "Sprint 101" };

const TEAM_VIEW: TeamView = {
  jiraSites: [],
  revision: 10,
  team: { id: 1, name: "Payments", description: null, managerPersonId: 12, managerName: "Cara New", createdAt: 1, updatedAt: 2, can: { schedule: true, editCapacity: true, editOrder: true } },
  order: { custom: false, revision: 4, milestoneIds: [] },
  capacity: { periods: [] },
  weeks: [{ weekStart: "2026-11-09", load: 0, capacity: null, overloaded: false, overloadMd: null, maxWip: 0, wipExceeded: false }],
  weeksTruncated: false,
  scheduled: [],
  unscheduled: [],
  dependencies: [],
  idleGaps: [],
};

type FetchMock = ReturnType<typeof vi.fn>;
let teamView: TeamView;

describe("the team page's Flow section", () => {
  let mockFetch: FetchMock;
  beforeEach(() => {
    teamView = TEAM_VIEW;
    mockFetch = vi.fn((url: string, init?: RequestInit) => {
      const key = `${init?.method ?? "GET"} ${url}`;
      if (key === "GET /api/v1/views/team/1") return Promise.resolve(jsonResponse(200, teamView));
      if (key === "GET /api/v1/public-holidays") return Promise.resolve(jsonResponse(200, { items: [] }));
      if (key === "GET /api/v1/teams/1/flow") return Promise.resolve(jsonResponse(200, linkedPanel()));
      if (key === "POST /api/v1/integrations/flow/team-bindings/5/capacity-preview") return Promise.resolve(jsonResponse(200, PREVIEW));
      if (key === "POST /api/v1/integrations/flow/team-bindings/5/capacity-import") {
        teamView = { ...TEAM_VIEW, capacity: { periods: [FLOW_PERIOD] }, weeks: [{ ...TEAM_VIEW.weeks[0], capacity: 20 }] };
        return Promise.resolve(jsonResponse(200, APPLIED));
      }
      return Promise.resolve(jsonResponse(404, { title: "Not Found", status: 404 }));
    });
    vi.stubGlobal("fetch", mockFetch);
    localStorage.setItem("astrolabe.auth.token", "fake-token");
    localStorage.setItem("astrolabe.auth.roles", JSON.stringify(["USER"]));
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    localStorage.clear();
  });
  const renderPage = () => renderWithProviders(<Routes><Route path="/teams/:id" element={<TeamDetails />} /></Routes>, { route: "/teams/1" });
  const reads = (key: string) => mockFetch.mock.calls.filter(([url, init]) => `${(init as RequestInit | undefined)?.method ?? "GET"} ${url}` === key).length;

  test("sits after the Capacity section as an h3 of its own, with the roster as an h4", async () => {
    renderPage();
    await screen.findByRole("table", { name: "Link to Flow" });
    const outline = headingOutline();
    expect(outline.filter(([level]) => level <= 3)).toEqual([[2, "Payments"], [3, "Capacity"], [3, "Flow"], [3, "Weekly load"]]);
    expect(outline).toContainEqual([4, "Roster"]);
  });

  test("an import refreshes the team view: the capacity table gains the Flow-badged row and the weekly load follows - the Flow panel is its own read", async () => {
    renderPage();
    expect(await screen.findByText("No capacity set")).toBeInTheDocument();
    expect(reads("GET /api/v1/views/team/1")).toBe(1);
    await userEvent.click(await screen.findByRole("button", { name: "Import capacity…" }));
    await screen.findByRole("table", { name: "Capacity import preview" });
    await userEvent.click(screen.getByRole("button", { name: "Import" }));
    await screen.findByText("1 created · 1 updated");
    const table = await screen.findByRole("table", { name: "Capacity periods of the team" });
    const row = within(table).getByRole("row", { name: /2026-11-09/ });
    expect(row).toHaveTextContent("Flow");
    expect(screen.queryByText("No capacity set")).not.toBeInTheDocument();
    expect(reads("GET /api/v1/views/team/1")).toBe(2);
    // The import changed team data only: the Flow panel is not read again.
    expect(reads("GET /api/v1/teams/1/flow")).toBe(1);
  });

  test("an unlinked team of a viewer who may not link it reads who can", async () => {
    mockFetch.mockImplementation((url: string) => {
      if (url === "/api/v1/views/team/1") return Promise.resolve(jsonResponse(200, { ...TEAM_VIEW, team: { ...TEAM_VIEW.team, can: { schedule: false, editCapacity: false, editOrder: false } } }));
      if (url === "/api/v1/public-holidays") return Promise.resolve(jsonResponse(200, { items: [] }));
      if (url === "/api/v1/teams/1/flow") return Promise.resolve(jsonResponse(200, { ...UNLINKED_PANEL, can: { link: false, unlink: false, importCapacity: false } }));
      return Promise.resolve(jsonResponse(404, { title: "Not Found", status: 404 }));
    });
    renderPage();
    expect(await screen.findByText("The team's manager or an administrator can link it to its Flow team.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Link to Flow team…" })).not.toBeInTheDocument();
  });
});
