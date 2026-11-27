import { describe, expect, test } from "vitest";
import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import TeamPageHeader from "./TeamPageHeader";
import type { TeamView } from "../api/teams";
import { renderWithProviders } from "../test/render";
import { openPageInfo } from "../test/pageInfo";
import { textContent } from "../test/textContent";

const team = (over: Partial<TeamView["team"]> = {}): TeamView["team"] => ({
  id: 1,
  name: "Payments",
  description: null,
  managerPersonId: 12,
  managerName: "Cara New",
  colour: "INDIGO",
  createdAt: 1,
  updatedAt: 2,
  can: { schedule: true, editCapacity: true, editOrder: true },
  flags: [],
  ...over,
});

const FLAG: TeamView["team"]["flags"][number] = { kind: "FLOW_CAPACITY", severity: "WARNING", count: 2 };

const renderHeader = (t: TeamView["team"]) => renderWithProviders(<TeamPageHeader team={t} admin={false} onEdit={() => undefined} />);

describe("TeamPageHeader: the colour swatch (1.29)", () => {
  test("the team's own colour stands before the name, inside the title's row, hidden from the heading's name", () => {
    renderHeader(team({ colour: "GRAPE" }));
    const heading = screen.getByRole("heading", { level: 2, name: "Payments" });
    const swatch = document.querySelector("[data-team-colour]") as HTMLElement;
    expect(swatch).toHaveAttribute("data-team-colour", "GRAPE");
    expect(swatch).toHaveAttribute("aria-hidden", "true");
    expect(swatch.nextElementSibling).toBe(heading);
    expect(heading).toHaveTextContent(/^Payments$/);
  });
});

describe("TeamPageHeader: the manager (1.31)", () => {
  test("the manager's name leads to the person's page, inside the line that still says 'Manager:'; the line is on the page, not behind the info button", () => {
    renderHeader(team());
    expect(screen.getByRole("link", { name: "Open person Cara New" })).toHaveAttribute("href", "/people/12");
    expect(screen.getByText(textContent("Manager: Cara New"))).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^About this page/ })).toBeNull();
  });

  test("a team without a manager says so and links nothing", () => {
    renderHeader(team({ managerPersonId: null, managerName: null }));
    expect(screen.getByText("No manager")).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /Open person/ })).toBeNull();
  });

  test("the team's own written description is behind the info button", async () => {
    renderHeader(team({ description: "Money movers" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(within(await openPageInfo(userEvent.setup())).getByText("Money movers")).toBeInTheDocument();
  });
});

describe("TeamPageHeader: the Flow capacity flag (1.9)", () => {
  test("a FLOW_CAPACITY warning is its sentence in words beside the title, with no count badge and the sentence announced once", () => {
    renderHeader(team({ flags: [FLAG] }));
    expect(screen.getByRole("heading", { level: 2, name: "Payments" })).toBeInTheDocument();
    const badge = document.querySelector("[data-team-flag]") as HTMLElement;
    expect(badge).toHaveAttribute("data-team-flag", "FLOW_CAPACITY");
    expect(badge).toHaveAttribute("data-severity", "WARNING");
    expect(badge).toHaveTextContent(/^Capacity differs from Flow: 2 open differences$/);
    expect(screen.getAllByText("Capacity differs from Flow: 2 open differences")).toHaveLength(1);
    expect(document.querySelector("[data-flags]")).toBeNull();
    expect(badge.querySelector("svg")).toHaveAttribute("aria-hidden", "true");
  });

  test("an INFO flag is the gray info variant", () => {
    renderHeader(team({ flags: [{ ...FLAG, severity: "INFO", count: 1 }] }));
    expect(document.querySelector("[data-team-flag]")).toHaveAttribute("data-severity", "INFO");
    expect(screen.getByText("Capacity differs from Flow: 1 open difference")).toBeInTheDocument();
  });

  test("two flags are two badges, each its own sentence and severity", () => {
    renderHeader(team({ flags: [FLAG, { ...FLAG, severity: "INFO", count: 1 }] }));
    const badges = Array.from(document.querySelectorAll("[data-team-flag]"));
    expect(badges.map((b) => b.getAttribute("data-severity"))).toEqual(["WARNING", "INFO"]);
    expect(badges.map((b) => b.textContent)).toEqual(["Capacity differs from Flow: 2 open differences", "Capacity differs from Flow: 1 open difference"]);
  });

  test("a pending flag (an incomplete Flow snapshot) is neutral: gray with an hourglass, no severity, its sentence announced once (1.26.0)", () => {
    renderHeader(team({ flags: [{ kind: "FLOW_CAPACITY_PENDING", severity: "INFO" }] }));
    const badge = document.querySelector("[data-team-flag]") as HTMLElement;
    expect(badge).toHaveAttribute("data-team-flag", "FLOW_CAPACITY_PENDING");
    expect(badge).not.toHaveAttribute("data-severity");
    expect(badge.getAttribute("style") ?? "").not.toMatch(/orange|red/);
    expect(badge).toHaveTextContent(/^Flow capacity comparison pending: waiting for a complete Flow refresh$/);
    expect(screen.getAllByText("Flow capacity comparison pending: waiting for a complete Flow refresh")).toHaveLength(1);
    expect(badge.querySelector("svg")).toHaveAttribute("aria-hidden", "true");
  });

  test("no flags: nothing is drawn and the title stays the heading", () => {
    renderHeader(team());
    expect(document.querySelector("[data-team-flag]")).toBeNull();
    expect(screen.getByRole("heading", { level: 2, name: "Payments" })).toBeInTheDocument();
  });
});
