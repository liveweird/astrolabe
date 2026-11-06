import { describe, expect, test } from "vitest";
import { renderWithProviders, screen, within } from "../test/render";
import { run } from "../test/jira";
import { ApiError } from "../api/http";
import SyncRunsTable from "./SyncRunsTable";

function renderRuns(runs: Parameters<typeof SyncRunsTable>[0]["runs"], extra: Partial<Parameters<typeof SyncRunsTable>[0]> = {}) {
  return renderWithProviders(<SyncRunsTable runs={runs} isLoading={false} isError={false} error={null} {...extra} />);
}

describe("SyncRunsTable", () => {
  test("a succeeded run reads its counters and dates (UTC)", () => {
    renderRuns([run({ startedAt: Date.UTC(2026, 10, 6, 10, 0), finishedAt: Date.UTC(2026, 10, 6, 10, 1), observedCount: 12, goneCount: 1, callCount: 9 })]);
    const table = screen.getByRole("table", { name: "Recent runs" });
    const row = within(table).getAllByRole("row")[1];
    expect(within(row).getByText("2026-11-06 10:00")).toBeInTheDocument();
    expect(within(row).getByText("2026-11-06 10:01")).toBeInTheDocument();
    expect(within(row).getByText("Succeeded")).toBeInTheDocument();
    expect(within(row).getByText("A person")).toBeInTheDocument();
    expect(within(row).getByText("12")).toBeInTheDocument();
    expect(within(row).getByText("9")).toBeInTheDocument();
  });

  test("a failed run shows the typed error in words with its code, and the server's short hint as text", () => {
    renderRuns([run({ outcome: "FAILED", errorCode: "MAPPING_INVALID", errorDetail: "No issue type at hierarchy level 3 <b>x</b>", rateLimitedCount: 2 })]);
    expect(screen.getByText("Failed")).toBeInTheDocument();
    expect(screen.getByText("The saved mapping no longer fits the site; correct and save it (MAPPING_INVALID)")).toBeInTheDocument();
    // The hint is a text node, never markup.
    expect(screen.getByText("No issue type at hierarchy level 3 <b>x</b>")).toBeInTheDocument();
    expect(screen.getByText("2 rate-limited")).toBeInTheDocument();
  });

  test("an unfinished run is Running or Interrupted by the server's `running` alone, whatever its start looks like to this browser", () => {
    renderRuns([
      run({ id: 9, outcome: null, finishedAt: null, startedAt: 1, running: true }),
      run({ id: 8, outcome: null, finishedAt: null, startedAt: Date.now(), running: false }),
    ]);
    expect(screen.getByText("Running")).toBeInTheDocument();
    const interrupted = screen.getByText("Interrupted").closest("td")!;
    // The wording claims nothing about what happens to the row next.
    expect(within(interrupted).getByText("No result was recorded and nothing is running it now.")).toBeInTheDocument();
    expect(screen.queryByText(/next claim|abandon/i)).not.toBeInTheDocument();
  });

  test("an abandoned run says so", () => {
    renderRuns([run({ outcome: "ABANDONED", errorCode: "ABANDONED", errorDetail: "The run did not finish within 10 minutes" })]);
    expect(screen.getByText("Abandoned")).toBeInTheDocument();
    expect(screen.getByText("The run never finished and a later one took over (ABANDONED)")).toBeInTheDocument();
  });

  test("the empty state spans every column", () => {
    renderRuns([]);
    const empty = screen.getByText(/No runs yet/);
    expect(empty.closest("td")).toHaveAttribute("colspan", String(screen.getAllByRole("columnheader").length));
  });

  test("a failed load renders the alert above the table", () => {
    renderRuns(undefined, { isError: true, error: new ApiError(500, null) });
    expect(screen.getByRole("alert")).toHaveTextContent("Could not load the runs");
  });
});
