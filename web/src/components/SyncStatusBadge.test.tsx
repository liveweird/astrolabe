import { describe, expect, test } from "vitest";
import { renderWithProviders, screen } from "../test/render";
import type { SyncState, SyncStatus } from "../api/sync";
import SyncStatusBadge from "./SyncStatusBadge";

const NOW = Date.UTC(2026, 10, 6, 11, 0);
const LAST_RUN: NonNullable<SyncStatus["lastRun"]> = { id: 1, startedAt: NOW - 600_000, finishedAt: NOW - 540_000, outcome: "SUCCEEDED", errorCode: null, trigger: "SCHEDULED", running: false };

function status(over: Partial<SyncStatus> = {}): SyncStatus {
  return { state: "CURRENT", lastRun: LAST_RUN, lastSucceededAt: LAST_RUN.startedAt, consecutiveFailures: 0, nextPollAt: NOW + 7 * 60_000 - 1_000, ...over };
}

describe("SyncStatusBadge", () => {
  test.each<[SyncState, string, string]>([
    ["CURRENT", "Current", "green"],
    ["FAILED", "Failed", "red"],
    ["STALE", "Stale", "orange"],
    ["NEVER_SYNCED", "Never synced", "gray"],
    ["DISABLED", "Disabled", "gray"],
  ])("%s reads %s in the %s of the colour vocabulary (green success, red failure, orange warning, gray neutral)", (state, label, color) => {
    renderWithProviders(<SyncStatusBadge status={status({ state })} now={NOW} />);
    const badge = screen.getByText(label).closest(".mantine-Badge-root")!;
    expect(badge.getAttribute("style")).toContain(`--mantine-color-${color}-`);
  });

  test("the secondary line: the next poll, due now, manual only, a failure streak with the code, Test first, and nothing for a disabled connection", () => {
    const { rerender } = renderWithProviders(<SyncStatusBadge status={status()} now={NOW} />);
    expect(screen.getByText("next poll in 7 min")).toBeInTheDocument();
    rerender(<SyncStatusBadge status={status({ nextPollAt: NOW - 1 })} now={NOW} />);
    expect(screen.getByText("due now")).toBeInTheDocument();
    rerender(<SyncStatusBadge status={status({ nextPollAt: null })} now={NOW} pollIntervalMinutes={null} />);
    expect(screen.getByText("manual only")).toBeInTheDocument();
    rerender(<SyncStatusBadge status={status({ state: "FAILED", consecutiveFailures: 1, lastRun: { ...LAST_RUN, outcome: "FAILED", errorCode: "TOKEN_UNREADABLE" } })} now={NOW} />);
    expect(screen.getByText("1 failure in a row · TOKEN_UNREADABLE")).toBeInTheDocument();
    rerender(<SyncStatusBadge status={status({ state: "NEVER_SYNCED", lastRun: null, lastSucceededAt: null, nextPollAt: null })} now={NOW} ready={false} pollIntervalMinutes={15} />);
    expect(screen.getByText("not polled: test the connection first")).toBeInTheDocument();
    rerender(<SyncStatusBadge status={status({ state: "DISABLED", nextPollAt: null, consecutiveFailures: 2 })} now={NOW} pollIntervalMinutes={15} />);
    expect(screen.getByText("Disabled")).toBeInTheDocument();
    expect(screen.queryByText(/failures|poll/)).not.toBeInTheDocument();
  });

  test("a running run with no poll moment says it is refreshing; detail={false} leaves the line out", () => {
    const { rerender } = renderWithProviders(<SyncStatusBadge status={status({ nextPollAt: null, lastRun: { ...LAST_RUN, outcome: null, finishedAt: null, running: true } })} now={NOW} />);
    expect(screen.getByText("refreshing now")).toBeInTheDocument();
    rerender(<SyncStatusBadge status={status()} now={NOW} detail={false} />);
    expect(screen.queryByText(/next poll/)).not.toBeInTheDocument();
    expect(screen.getByText("Current")).toBeInTheDocument();
  });
});
