import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import userEvent from "@testing-library/user-event";
import { screen, within } from "@testing-library/react";
import { useLocation } from "react-router-dom";
import Roadmap from "./Roadmap";
import type { PlanFlag, RoadmapProject, RoadmapView } from "../api/roadmap";
import i18n from "../i18n";
import { jsonResponse } from "../test/http";
import { renderWithProviders } from "../test/render";

// The 1.23 Flow capacity flag on the Roadmap page: the server raises one `FLOW_CAPACITY_MILESTONES` flag per project and team; the page counts it like any flag
// (the Flags cell, the facts line, the severity filter), words it through the team's name and, in the Flags section, links the team beside the sentence.

const flag = (severity: PlanFlag["severity"], teamId: number, count: number): PlanFlag => ({ kind: "FLOW_CAPACITY_MILESTONES", severity, teamId, count });

const project = (id: number, name: string, over: Partial<RoadmapProject> = {}): RoadmapProject => ({
  jira: null,
  id,
  name,
  programId: 10,
  programName: "Billing",
  workStreamId: 1,
  workStreamName: "Platform",
  ownerPersonId: 5,
  ownerName: "Ola Owner",
  targetStart: null,
  targetEnd: null,
  rankPosition: null,
  teamIds: [4],
  span: { start: "2026-03-09", end: "2026-04-10" },
  drift: null,
  flags: [],
  can: { editTargetWindow: false },
  ...over,
});

// Invoices: two milestones on Backend in a disputed sprint where the plan holds more (a warning); Taxes: one in a sprint where the plan holds less (an info); Audit: no flag.
const INVOICES = project(1, "Invoices", { rankPosition: 1, flags: [flag("WARNING", 4, 2)] });
const TAXES = project(2, "Taxes", { rankPosition: 2, flags: [flag("INFO", 4, 1)] });
const AUDIT = project(3, "Audit", { rankPosition: 3 });

const viewOf = (over: Partial<RoadmapView> = {}): RoadmapView => ({
  jiraSites: [],
  revision: 7,
  can: { editRank: false },
  teams: [{ id: 4, name: "Backend" }],
  links: [],
  ranked: [INVOICES, TAXES, AUDIT].map((p, index) => ({ position: index + 1, project: p })),
  unranked: [],
  ...over,
});

let view: RoadmapView;

beforeEach(() => {
  view = viewOf();
  vi.stubGlobal(
    "fetch",
    vi.fn((url: string) => {
      if (url.startsWith("/api/v1/views/roadmap")) return Promise.resolve(jsonResponse(200, view));
      if (url === "/api/v1/baselines") return Promise.resolve(jsonResponse(200, { items: [], can: { manage: false } }));
      if (url === "/api/v1/public-holidays") return Promise.resolve(jsonResponse(200, { items: [] }));
      return Promise.resolve(jsonResponse(404, { title: "x", status: 404 }));
    }),
  );
  localStorage.setItem("astrolabe.auth.token", "fake-token");
});

afterEach(async () => {
  vi.unstubAllGlobals();
  localStorage.clear();
  await i18n.changeLanguage("en");
});

function Where() {
  const location = useLocation();
  return <p data-testid="where">{location.pathname + location.search}</p>;
}
const renderAt = (route = "/roadmap") =>
  renderWithProviders(
    <>
      <Roadmap />
      <Where />
    </>,
    { route },
  );
const waitForGrid = () => screen.findByRole("grid", { name: "Roadmap timeline" });
const facts = () => screen.getByRole("group", { name: "Roadmap facts" });
const rowOf = (name: string) => screen.getByRole("link", { name: `Open project ${name}` }).closest('[role="row"]') as HTMLElement;
const rowLabels = () =>
  within(screen.getByRole("grid", { name: "Roadmap timeline" }))
    .getAllByRole("row")
    .slice(1)
    .map((row) => row.querySelector("a[href^='/projects/']")?.textContent ?? row.querySelector("[role='rowheader']")?.textContent?.trim());
const SPRINTS = "scheduled in a sprint whose capacity differs from Flow";

describe("Roadmap page: the Flow capacity flag of a project row", () => {
  test("the counts cell and the facts line count it like any flag: a warning for the project where the plan holds more, an info for the other", async () => {
    renderAt();
    await waitForGrid();
    expect(rowOf("Invoices").querySelector("[data-flags]")).toHaveAttribute("data-flags", "1,0");
    expect(rowOf("Taxes").querySelector("[data-flags]")).toHaveAttribute("data-flags", "0,1");
    expect(rowOf("Audit").querySelector("[data-flags]")).toBeNull();
    expect(within(facts()).getByText("1 warning")).toBeInTheDocument();
    expect(within(facts()).getByText("1 info")).toBeInTheDocument();
    // No Flow staleness text appears beside the figures.
    expect(within(facts()).queryByText(/out of date/)).toBeNull();
  });

  test("a project on a team whose Flow comparison is pending gets a neutral hourglass, not a flag: no count, no warning, announced in words (1.26.0)", async () => {
    view = viewOf({ ranked: [{ position: 1, project: project(1, "Invoices", { rankPosition: 1, flowPendingTeamIds: [4] }) }, { position: 2, project: AUDIT }] });
    renderAt();
    await waitForGrid();
    const cell = rowOf("Invoices").querySelector("[data-flags]") as HTMLElement;
    expect(cell).toHaveAttribute("data-flags", "0,0");
    expect(cell.querySelector("[data-flow-pending]")).not.toBeNull();
    expect(cell).toHaveTextContent("Flow capacity comparison pending for Backend: waiting for a complete Flow refresh");
    expect(cell.querySelector(".mantine-Badge-root")).toBeNull();
    expect(rowOf("Audit").querySelector("[data-flow-pending]")).toBeNull();
    expect(within(facts()).queryByText(/warning/)).toBeNull();
    expect(screen.getByText("No flags on the projects shown.")).toBeInTheDocument();
  });

  test("a pending team the view does not list leaves the hidden sentence without a name (1.26.0)", async () => {
    view = viewOf({ teams: [], ranked: [{ position: 1, project: project(1, "Invoices", { rankPosition: 1, flowPendingTeamIds: [4] }) }], unranked: [] });
    renderAt();
    await waitForGrid();
    expect(rowOf("Invoices").querySelector("[data-flags]")).toHaveTextContent("Flow capacity comparison pending: waiting for a complete Flow refresh");
  });

  test("the Flags section words each flag with its team and count, a warning before an info, and links the team beside the sentence", async () => {
    const user = userEvent.setup();
    renderAt();
    await waitForGrid();
    await user.click(screen.getByRole("button", { name: "Show the 2 flags" }));
    const table = await screen.findByRole("table", { name: "Flags of the projects shown" });
    const rows = within(table).getAllByRole("row").slice(1);
    expect(rows.map((row) => within(row).getAllByRole("cell").slice(0, 3).map((cell) => cell.textContent))).toEqual([
      ["Warning", "Invoices", "2 milestones on Backend are scheduled in sprints whose capacity differs from Flow"],
      ["Info", "Taxes", "1 milestone on Backend is scheduled in a sprint whose capacity differs from Flow"],
    ]);
    for (const row of rows) expect(within(row).getByRole("link", { name: "Open team Backend" })).toHaveAttribute("href", "/teams/4");
    // The project link and the team link are two links of the row, each named for its destination.
    expect(within(rows[0]).getByRole("link", { name: "Open project Invoices" })).toHaveAttribute("href", "/projects/1");
  });

  test("an info sits under Infos in the section's own control", async () => {
    const user = userEvent.setup();
    renderAt();
    await waitForGrid();
    await user.click(screen.getByRole("button", { name: "Show the 2 flags" }));
    const filter = await screen.findByRole("radiogroup", { name: "Filter the flags by severity" });
    await user.click(within(filter).getByRole("radio", { name: "Infos (1)" }));
    const table = screen.getByRole("table", { name: "Flags of the projects shown" });
    const rows = within(table).getAllByRole("row").slice(1);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toHaveTextContent(`1 milestone on Backend is ${SPRINTS}`);
    expect(within(rows[0]).getByRole("link", { name: "Open team Backend" })).toBeInTheDocument();
  });

  test("the severity filter in the address keeps or drops the row with its flag", async () => {
    const { unmount } = renderAt("/roadmap?severity=WARNING");
    await waitForGrid();
    expect(rowLabels()).toEqual(["Invoices"]);
    unmount();
    renderAt("/roadmap?severity=INFO");
    await waitForGrid();
    expect(rowLabels()).toEqual(["Taxes"]);
  });

  test("a flag whose team the document does not know reads without the team's name and offers no link", async () => {
    const user = userEvent.setup();
    view = viewOf({ teams: [], ranked: [{ position: 1, project: INVOICES }], unranked: [] });
    renderAt();
    await waitForGrid();
    await user.click(screen.getByRole("button", { name: "Show the 1 flag" }));
    const table = await screen.findByRole("table", { name: "Flags of the projects shown" });
    const row = within(table).getAllByRole("row")[1];
    expect(within(row).getByText(/^2 milestones are scheduled in sprints whose capacity differs from Flow/)).toBeInTheDocument();
    expect(within(row).queryByRole("link", { name: /^Open team/ })).toBeNull();
    // Only the project's own link is left in the row.
    expect(within(row).getAllByRole("link").map((link) => link.getAttribute("href"))).toEqual(["/projects/1"]);
  });

  test("a flag without a team id reads without a team name and offers no link", async () => {
    const user = userEvent.setup();
    const bare: PlanFlag = { kind: "FLOW_CAPACITY_MILESTONES", severity: "INFO", count: 1 };
    view = viewOf({ ranked: [{ position: 1, project: { ...TAXES, flags: [bare] } }], unranked: [] });
    renderAt();
    await waitForGrid();
    await user.click(screen.getByRole("button", { name: "Show the 1 flag" }));
    const table = await screen.findByRole("table", { name: "Flags of the projects shown" });
    const row = within(table).getAllByRole("row")[1];
    expect(row).toHaveTextContent("1 milestone is scheduled in a sprint whose capacity differs from Flow");
    expect(within(row).queryByRole("link", { name: /^Open team/ })).toBeNull();
  });

  test("in Polish the sentence takes the plural of the count and the link its destination", async () => {
    await i18n.changeLanguage("pl");
    const user = userEvent.setup();
    renderAt();
    await screen.findByRole("grid", { name: "Oś czasu roadmapy" });
    await user.click(screen.getByRole("button", { name: "Pokaż 2 flagi" }));
    const table = await screen.findByRole("table", { name: "Flagi pokazanych projektów" });
    const rows = within(table).getAllByRole("row").slice(1);
    expect(rows[0]).toHaveTextContent("2 kamienie milowe zespołu Backend przypadają na sprinty, w których przepustowość różni się od Flow");
    expect(rows[1]).toHaveTextContent("1 kamień milowy zespołu Backend przypada na sprint, w którym przepustowość różni się od Flow");
    expect(within(rows[0]).getByRole("link", { name: "Otwórz zespół Backend" })).toHaveAttribute("href", "/teams/4");
  });
});
