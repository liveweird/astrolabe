import { describe, expect, test } from "vitest";
import { screen } from "@testing-library/react";
import TeamPageHeader from "./TeamPageHeader";
import type { TeamView } from "../api/teams";
import { renderWithProviders } from "../test/render";

const team = (over: Partial<TeamView["team"]> = {}): TeamView["team"] => ({
  id: 1,
  name: "Payments",
  description: null,
  managerPersonId: 12,
  managerName: "Cara New",
  createdAt: 1,
  updatedAt: 2,
  can: { schedule: true, editCapacity: true, editOrder: true },
  flags: [],
  ...over,
});

const FLAG: TeamView["team"]["flags"][number] = { kind: "FLOW_CAPACITY", severity: "WARNING", days: null, teamId: null, otherProjectId: null, deviation: null, count: 2 };

const renderHeader = (t: TeamView["team"]) => renderWithProviders(<TeamPageHeader team={t} admin={false} onEdit={() => undefined} />);

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

  test("no flags: nothing is drawn and the title stays the heading", () => {
    renderHeader(team());
    expect(document.querySelector("[data-team-flag]")).toBeNull();
    expect(screen.getByRole("heading", { level: 2, name: "Payments" })).toBeInTheDocument();
  });
});
