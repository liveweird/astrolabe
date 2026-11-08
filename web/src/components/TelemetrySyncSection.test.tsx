import { describe, expect, test } from "vitest";
import { renderWithProviders, screen, within } from "../test/render";
import type { TelemetryCurrent, TelemetrySyncConnection } from "../api/telemetry";
import { currentFixture, GENERATED_AT } from "../test/telemetryFixtures";
import TelemetrySyncSection from "./TelemetrySyncSection";

const MIN = 60_000;
const LAST_RUN = { id: 4, startedAt: GENERATED_AT - 10 * MIN, finishedAt: GENERATED_AT - 9 * MIN, outcome: "SUCCEEDED" as const, errorCode: null, trigger: "SCHEDULED" as const, running: false };

function connection(over: Partial<TelemetrySyncConnection> = {}): TelemetrySyncConnection {
  return {
    kind: "JIRA",
    connectionId: 1,
    name: "Acme Jira",
    pollIntervalMinutes: 15,
    ready: true,
    status: { state: "CURRENT", lastRun: LAST_RUN, lastSucceededAt: GENERATED_AT - 5 * MIN, consecutiveFailures: 0, nextPollAt: GENERATED_AT + 10 * MIN },
    ...over,
  };
}

function renderSection(sync: TelemetryCurrent["sync"]) {
  return renderWithProviders(<TelemetrySyncSection current={currentFixture({ sync })} />);
}

describe("TelemetrySyncSection", () => {
  test("a Flow connection is listed with its own kind label beside the Jira ones", () => {
    renderSection({ schedulerEnabled: true, tickSeconds: 60, connections: [connection(), connection({ kind: "FLOW", connectionId: 1, name: "Acme Flow", pollIntervalMinutes: 60 })] });
    const table = screen.getByRole("table", { name: "Sync status per connection" });
    const row = within(table).getByText("Acme Flow").closest("tr")!;
    expect(within(row).getByText("Flow")).toBeInTheDocument();
    expect(within(row).getByText("every 60 min")).toBeInTheDocument();
    expect(within(within(table).getByText("Acme Jira").closest("tr")!).getByText("Jira")).toBeInTheDocument();
  });

  test("one row per connection: its kind, state, the age of the last success (against the server's own clock), failures, next poll and interval", () => {
    renderSection({ schedulerEnabled: true, tickSeconds: 60, connections: [connection()] });
    expect(screen.getByText("The scheduler looks for connections that are due every 60 s.")).toBeInTheDocument();
    const table = screen.getByRole("table", { name: "Sync status per connection" });
    const row = within(table).getByText("Acme Jira").closest("tr")!;
    expect(within(row).getByText("Jira")).toBeInTheDocument();
    expect(within(row).getByText("Current")).toBeInTheDocument();
    expect(within(row).getByText("5 minutes ago")).toBeInTheDocument();
    expect(within(row).getByText("2026-10-24 11:55")).toBeInTheDocument();
    expect(within(row).getByText("0")).toBeInTheDocument();
    expect(within(row).getByText("next poll in 10 min")).toBeInTheDocument();
    expect(within(row).getByText("every 15 min")).toBeInTheDocument();
  });

  test("a failing connection shows the streak and the newest run's code; a running one says so", () => {
    const failed = { ...LAST_RUN, outcome: "FAILED" as const, errorCode: "AUTHENTICATION_FAILED" };
    renderSection({
      schedulerEnabled: true,
      tickSeconds: 60,
      connections: [
        connection({ name: "Broken", status: { state: "FAILED", lastRun: failed, lastSucceededAt: null, consecutiveFailures: 3, nextPollAt: GENERATED_AT + 60 * MIN } }),
        connection({ connectionId: 2, name: "Busy", status: { state: "CURRENT", lastRun: { ...LAST_RUN, outcome: null, finishedAt: null, running: true }, lastSucceededAt: GENERATED_AT - MIN, consecutiveFailures: 0, nextPollAt: null } }),
      ],
    });
    const broken = screen.getByText("Broken").closest("tr")!;
    expect(within(broken).getByText("Failed")).toBeInTheDocument();
    expect(within(broken).getByText("3 failures in a row")).toBeInTheDocument();
    expect(within(broken).getByText("AUTHENTICATION_FAILED")).toBeInTheDocument();
    expect(within(broken).getByText("Never")).toBeInTheDocument();
    expect(within(broken).getByText("next poll in 60 min")).toBeInTheDocument();
    const busy = screen.getByText("Busy").closest("tr")!;
    expect(within(busy).getByText("Running now")).toBeInTheDocument();
    expect(within(busy).getByText("refreshing now")).toBeInTheDocument();
  });

  test("manual only, untested and disabled connections say why they have no next poll", () => {
    const idle = { lastRun: null, lastSucceededAt: null, consecutiveFailures: 0, nextPollAt: null };
    renderSection({
      schedulerEnabled: true,
      tickSeconds: 60,
      connections: [
        connection({ name: "Manual", pollIntervalMinutes: null, status: { ...idle, state: "NEVER_SYNCED" } }),
        connection({ connectionId: 2, name: "Untested", ready: false, status: { ...idle, state: "NEVER_SYNCED" } }),
        connection({ connectionId: 3, name: "Off", status: { ...idle, state: "DISABLED" } }),
      ],
    });
    const manual = screen.getByText("Manual").closest("tr")!;
    expect(within(manual).getByText("manual only")).toBeInTheDocument();
    expect(within(manual).getByText("Manual only")).toBeInTheDocument();
    expect(within(screen.getByText("Untested").closest("tr")!).getByText("not polled: test the connection first")).toBeInTheDocument();
    const off = screen.getByText("Off").closest("tr")!;
    expect(within(off).getByText("Disabled")).toBeInTheDocument();
    expect(within(off).getByText("—")).toBeInTheDocument();
  });

  test("no connections says so, and a process without the scheduler warns that it starts no scheduled runs", () => {
    renderSection({ schedulerEnabled: false, tickSeconds: 60, connections: [] });
    expect(screen.getByText("No connection is set up for syncing yet.")).toBeInTheDocument();
    expect(screen.getByRole("note")).toHaveTextContent("The scheduler is switched off on the process that answered, so it starts no scheduled runs.");
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
  });
});
