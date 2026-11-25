import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { screen, within } from "@testing-library/react";
import Plan from "./Plan";
import { headingOutline } from "../test/headings";
import { routeFetch } from "../test/http";
import { linksView } from "../test/jiraLinks";
import { findPlanTree, planOf } from "../test/planView";
import { renderWithProviders } from "../test/render";

const PLAN = planOf([
  {
    id: 1,
    name: "Platform",
    description: "The core platform",
    programs: [
      {
        id: 10,
        name: "Billing",
        projects: [
          { id: 100, name: "Invoices", description: "Monthly invoicing", targetStart: "2026-02-01", targetEnd: "2026-03-31" },
          { id: 101, name: "Taxes", ownerName: "Tania Tax" },
        ],
      },
      { id: 11, name: "Identity" },
    ],
  },
  { id: 2, name: "Legacy", endDate: "2025-12-31", startDate: "2024-01-01" },
]);

beforeEach(() => {
  localStorage.setItem("astrolabe.auth.token", "fake-token");
  vi.stubGlobal("fetch", routeFetch({ "GET /api/v1/views/plan": PLAN, "GET /api/v1/views/jira-links": linksView() }));
});

afterEach(() => {
  vi.unstubAllGlobals();
  localStorage.clear();
});

test("renders ONE table: a row per node in the server's order with its parent, count, owner and dates; the outline is just the title", async () => {
  renderWithProviders(<Plan />);
  const table = await findPlanTree();
  expect(headingOutline()).toEqual([[2, "Plan"]]);
  expect(screen.getAllByRole("table")).toHaveLength(1);
  const rows = within(table).getAllByRole("row").slice(1);
  expect(rows.map((row) => [row.getAttribute("data-kind"), row.getAttribute("data-key"), row.getAttribute("data-parent")])).toEqual([
    ["workStream", "ws:1", null],
    ["program", "pg:10", "ws:1"],
    ["project", "pj:100", "pg:10"],
    ["project", "pj:101", "pg:10"],
    ["program", "pg:11", "ws:1"],
    ["workStream", "ws:2", null],
  ]);
  const platform = rows[0];
  expect(within(platform).getByRole("button", { name: "Work stream Platform", expanded: true })).toBeInTheDocument();
  expect(within(platform).getByText("The core platform")).toBeInTheDocument();
  expect(within(platform).getByText("Ola Owner")).toBeInTheDocument();
  expect(within(platform).getByText("From 2026-01-05")).toBeInTheDocument();
  // The count is a visible number with its unit said to a screen reader.
  expect(within(platform).getByText("2 programs")).toBeInTheDocument();
  expect(within(rows[1]).getByText("2 projects")).toBeInTheDocument();
  const invoices = rows[2];
  expect(within(invoices).getByRole("link", { name: "Open Invoices" })).toHaveAttribute("href", "/projects/100");
  expect(within(invoices).getByText("Piotr Project")).toBeInTheDocument();
  expect(within(invoices).getByText("2026-02-01 – 2026-03-31")).toBeInTheDocument();
  expect(within(invoices).getByText("Target window:")).toBeInTheDocument();
  expect(within(invoices).getByText("Monthly invoicing")).toHaveAttribute("title", "Monthly invoicing");
  expect(rows[3]).toHaveTextContent("Tania Tax");
  expect(rows[3]).toHaveTextContent("Not set");
});

test("a closed work stream shows the Closed badge and its dates; an open one does not; a childless one is plain text with its kind said", async () => {
  renderWithProviders(<Plan />);
  await findPlanTree();
  expect(screen.getAllByText("Closed")).toHaveLength(1);
  const legacy = screen.getByRole("rowheader", { name: /Legacy/ }).closest("tr")!;
  expect(within(legacy).getByText("Closed")).toBeInTheDocument();
  expect(within(legacy).getByText("2024-01-01 – 2025-12-31")).toBeInTheDocument();
  expect(within(legacy).getByText("0 programs")).toBeInTheDocument();
  expect(within(legacy).queryByRole("button", { name: /Work stream Legacy/ })).not.toBeInTheDocument();
  expect(within(legacy).getByText("Work stream")).toBeInTheDocument();
  // A closed stream still takes programs.
  expect(screen.getByRole("button", { name: "New program in Legacy" })).toBeInTheDocument();
});
