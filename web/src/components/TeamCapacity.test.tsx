import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import userEvent from "@testing-library/user-event";
import { renderWithProviders, screen, within } from "../test/render";
import type { CapacityPeriod, TeamView } from "../api/teams";
import TeamCapacity from "./TeamCapacity";

const MANUAL: CapacityPeriod = { id: 11, teamId: 1, effectiveFrom: "2027-02-03", mdPerWeek: 8, wipLimit: 1, createdAt: 1, updatedAt: 2, source: "MANUAL", flowSprintName: null };
const FLOW: CapacityPeriod = { ...MANUAL, id: 12, effectiveFrom: "2027-03-01", mdPerWeek: 20, wipLimit: null, source: "FLOW", flowSprintName: "Sprint 12" };

const view = (periods: CapacityPeriod[]): TeamView =>
  ({ team: { id: 1, name: "Payments", can: { schedule: true, editCapacity: true, editOrder: true } }, capacity: { periods } }) as unknown as TeamView;

describe("TeamCapacity and Flow-imported periods", () => {
  beforeEach(() => {
    localStorage.setItem("astrolabe.auth.token", "fake-token");
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    localStorage.clear();
  });

  test("a Flow-imported row carries a gray Flow badge titled with the sprint; a hand-entered row carries none", () => {
    renderWithProviders(<TeamCapacity view={view([MANUAL, FLOW])} />);
    const table = screen.getByRole("table", { name: "Capacity periods of the team" });
    const rows = within(table).getAllByRole("row");
    expect(within(rows[1]).queryByText("Flow")).not.toBeInTheDocument();
    const badge = within(rows[2]).getByText("Flow");
    expect(badge.closest(".mantine-Badge-root")).toHaveAttribute("title", "Sprint 12");
    expect(badge.closest(".mantine-Badge-root")).toHaveAttribute("data-variant", "light");
    expect(rows[2]).toHaveTextContent("2027-03-01Flow20");
  });

  test("editing a Flow-imported period says that a saved change makes it a hand-entered one; a hand-entered period says nothing", async () => {
    const put = vi.fn(() => Promise.resolve(new Response(null, { status: 204 })));
    vi.stubGlobal("fetch", put);
    renderWithProviders(<TeamCapacity view={view([MANUAL, FLOW])} />);
    await userEvent.click(screen.getByRole("button", { name: "Operations for 2027-03-01" }));
    await userEvent.click(await screen.findByRole("menuitem", { name: "Edit the period from 2027-03-01" }));
    const dialog = await screen.findByRole("dialog", { name: "Edit the capacity period" });
    expect(within(dialog).getByRole("note")).toHaveTextContent("This period was imported from Flow sprint “Sprint 12”. Saving a change makes it a hand-entered period: later imports will never touch it.");
    await userEvent.click(within(dialog).getByRole("button", { name: "Close" }));
    await userEvent.click(screen.getByRole("button", { name: "Operations for 2027-02-03" }));
    await userEvent.click(await screen.findByRole("menuitem", { name: "Edit the period from 2027-02-03" }));
    expect(within(await screen.findByRole("dialog", { name: "Edit the capacity period" })).queryByRole("note")).not.toBeInTheDocument();
  });

  test("adding a period shows no Flow hint", async () => {
    renderWithProviders(<TeamCapacity view={view([FLOW])} />);
    await userEvent.click(screen.getByRole("button", { name: "Add period" }));
    expect(within(await screen.findByRole("dialog")).queryByRole("note")).not.toBeInTheDocument();
  });

  test("a Flow period without a sprint name still hints and has no title", async () => {
    renderWithProviders(<TeamCapacity view={view([{ ...FLOW, flowSprintName: null }])} />);
    expect(screen.getByText("Flow").closest(".mantine-Badge-root")).not.toHaveAttribute("title");
    await userEvent.click(screen.getByRole("button", { name: "Operations for 2027-03-01" }));
    await userEvent.click(await screen.findByRole("menuitem", { name: "Edit the period from 2027-03-01" }));
    expect(await screen.findByRole("note")).toHaveTextContent("This period was imported from Flow. Saving a change makes it a hand-entered period");
  });
});
