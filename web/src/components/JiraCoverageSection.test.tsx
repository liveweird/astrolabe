import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { screen, within } from "@testing-library/react";
import JiraCoverageSection from "./JiraCoverageSection";
import type { JiraCoverage } from "../api/jira";
import { jsonResponse } from "../test/http";
import { CONNECTION } from "../test/jira";
import { renderWithProviders } from "../test/render";

let mockFetch: ReturnType<typeof vi.fn>;

function serve(status: number, body: unknown) {
  mockFetch = vi.fn((url: string) =>
    Promise.resolve(url === "/api/v1/integrations/jira/connections/1/coverage" ? jsonResponse(status, body) : jsonResponse(404, { title: "x", status: 404 })),
  );
  vi.stubGlobal("fetch", mockFetch);
}

afterEach(() => vi.unstubAllGlobals());
beforeEach(() => localStorage.setItem("astrolabe.auth.token", "fake-token"));
afterEach(() => localStorage.clear());

describe("JiraCoverageSection", () => {
  test("shows a real table of the mapped levels with the three counts and when the last successful run finished", async () => {
    const ready: JiraCoverage = {
      state: "READY",
      readAt: Date.UTC(2026, 10, 6, 9, 30),
      levels: [
        { level: "PROJECT", hierarchyLevel: 2, inScope: 12, linked: 9, openUnlinked: 2 },
        { level: "MILESTONE", hierarchyLevel: 1, inScope: 40, linked: 31, openUnlinked: 5 },
      ],
    };
    serve(200, ready);
    renderWithProviders(<JiraCoverageSection connection={CONNECTION} />);
    const table = await screen.findByRole("table", { name: "Coverage per level" });
    expect(within(table).getAllByRole("columnheader").map((cell) => cell.textContent)).toEqual(["Level", "In scope", "Linked", "Open and unlinked"]);
    const project = within(table).getByRole("rowheader", { name: "Project" }).closest("tr");
    expect(within(project as HTMLElement).getAllByRole("cell").map((cell) => cell.textContent)).toEqual(["12", "9", "2"]);
    const milestone = within(table).getByRole("rowheader", { name: "Milestone" }).closest("tr");
    expect(within(milestone as HTMLElement).getAllByRole("cell").map((cell) => cell.textContent)).toEqual(["40", "31", "5"]);
    expect(screen.getByText("Counted as of the last successful synchronisation, 2026-11-06 09:30 (UTC).")).toBeInTheDocument();
  });

  test("a connection that never synced says so, with no table", async () => {
    serve(200, { state: "NOT_SYNCED", readAt: null, levels: [] });
    renderWithProviders(<JiraCoverageSection connection={CONNECTION} />);
    expect(await screen.findByText("Not synced yet")).toBeInTheDocument();
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
  });

  test("a mapping that cannot name the levels says so, with no table", async () => {
    serve(200, { state: "MAPPING_UNUSABLE", readAt: null, levels: [] });
    renderWithProviders(<JiraCoverageSection connection={CONNECTION} />);
    expect(await screen.findByText(/does not name the levels yet/)).toBeInTheDocument();
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
  });

  test("a mapping saved after the last read says so and offers Refresh now, with no table of false zeros", async () => {
    serve(200, { state: "MAPPING_CHANGED", readAt: Date.UTC(2026, 10, 6, 9, 30), levels: [] });
    renderWithProviders(<JiraCoverageSection connection={CONNECTION} />);
    expect(await screen.findByText(/The mapping changed since the last synchronisation/)).toBeInTheDocument();
    expect(screen.getByText(/Use Refresh now to count them/)).toBeInTheDocument();
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
  });

  test("a failed read is an inline error, never counts", async () => {
    serve(500, { title: "x", status: 500 });
    renderWithProviders(<JiraCoverageSection connection={CONNECTION} />);
    expect(await screen.findByText("Could not load the coverage")).toBeInTheDocument();
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
  });
});
