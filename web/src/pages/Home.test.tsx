import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { renderWithProviders, screen, waitFor } from "../test/render";
import { headingOutline } from "../test/headings";
import { jsonResponse } from "../test/http";
import Home from "./Home";

const JIRA_URL = "/api/v1/views/deviations?acknowledged=true";
const FLOW_URL = "/api/v1/views/capacity-deviations?acknowledged=true";

/** The two views as the server answers `acknowledged=true`: the OPEN totals, the acknowledged items only (none here), the connections listed. */
function jiraView(warnings: number, infos: number, connections = 1) {
  return { revision: 1, asOf: "2026-11-10", connections: Array.from({ length: connections }, (_, id) => ({ id: id + 1, name: "Jira" })), totals: { warnings, infos, bindings: 0, gone: 0, acknowledged: 0 }, items: [], truncated: false };
}
function flowView(warnings: number, infos: number, connections = 1) {
  return { asOf: "2026-11-10", connections: Array.from({ length: connections }, (_, id) => ({ id: id + 1, name: "Flow" })), totals: { warnings, infos, gone: 0, acknowledged: 0, teams: 0 }, items: [], truncated: false };
}

function stubViews(answers: { jira: () => Response; flow: () => Response }) {
  const fetchMock = vi.fn((input: RequestInfo | URL) => {
    const url = String(input);
    if (url === JIRA_URL) return Promise.resolve(answers.jira());
    if (url === FLOW_URL) return Promise.resolve(answers.flow());
    return Promise.reject(new Error(`unexpected ${url}`));
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("Home", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  test("is a landing: the intro, three cards with their own links, and both counts asked with acknowledged=true", async () => {
    const fetchMock = stubViews({ jira: () => jsonResponse(200, jiraView(3, 0)), flow: () => jsonResponse(200, flowView(0, 2)) });
    renderWithProviders(<Home />);
    expect(screen.getByRole("heading", { level: 2, name: "Astrolabe" })).toBeInTheDocument();
    expect(screen.getByText(/see where the plan differs from Jira and from Flow/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Open the plan" })).toHaveAttribute("href", "/plan");
    expect(screen.getByRole("link", { name: "Open the roadmap" })).toHaveAttribute("href", "/roadmap");
    expect(screen.getByRole("link", { name: "Open the deviations" })).toHaveAttribute("href", "/deviations");
    expect(headingOutline()).toEqual([
      [2, "Astrolabe"],
      [3, "Plan"],
      [3, "Roadmap"],
      [3, "Deviations"],
    ]);
    await waitFor(() => expect(screen.getByText("Open differences from Jira:")).toBeInTheDocument());
    expect(fetchMock.mock.calls.map(([url]) => String(url)).sort()).toEqual([FLOW_URL, JIRA_URL].sort());
  });

  test("shows the positive open counts of each source and omits a zero badge", async () => {
    stubViews({ jira: () => jsonResponse(200, jiraView(3, 0)), flow: () => jsonResponse(200, flowView(1, 2)) });
    renderWithProviders(<Home />);
    expect(await screen.findByText("3 warnings")).toBeInTheDocument();
    expect(screen.getByText("Open differences from Jira:")).toBeInTheDocument();
    expect(screen.getByText("Open capacity differences from Flow:")).toBeInTheDocument();
    expect(screen.getByText("1 warning")).toBeInTheDocument();
    expect(screen.getByText("2 infos")).toBeInTheDocument();
    // Jira has no open info: no "0 infos" badge, only Flow's "2 infos" exists.
    expect(screen.getAllByText(/infos?$/)).toHaveLength(1);
  });

  test("says nothing at zero and nothing without a connection (no 'nothing open' claim)", async () => {
    const fetchMock = stubViews({ jira: () => jsonResponse(200, jiraView(0, 0)), flow: () => jsonResponse(200, flowView(4, 4, 0)) });
    renderWithProviders(<Home />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    // Both answers have settled (a query's data is published a tick after the fetch call).
    await waitFor(() => expect(screen.getByRole("link", { name: "Open the deviations" })).toBeInTheDocument());
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(screen.queryByText("Open differences from Jira:")).not.toBeInTheDocument();
    expect(screen.queryByText("Open capacity differences from Flow:")).not.toBeInTheDocument();
    expect(screen.queryByText(/warning|info/)).not.toBeInTheDocument();
    expect(screen.queryByText(/nothing|no open/i)).not.toBeInTheDocument();
  });

  test("a failed read is an inline alert in the Deviations card; the links stay, the other source still shows", async () => {
    stubViews({ jira: () => jsonResponse(500, { title: "Boom", status: 500 }), flow: () => jsonResponse(200, flowView(2, 0)) });
    renderWithProviders(<Home />);
    expect(await screen.findByText("Could not read the open deviations")).toBeInTheDocument();
    expect(screen.getByRole("alert")).toBeInTheDocument();
    expect(await screen.findByText("2 warnings")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Open the plan" })).toHaveAttribute("href", "/plan");
    expect(screen.getByRole("link", { name: "Open the deviations" })).toHaveAttribute("href", "/deviations");
    expect(headingOutline()).toEqual([
      [2, "Astrolabe"],
      [3, "Plan"],
      [3, "Roadmap"],
      [3, "Deviations"],
    ]);
  });
});
