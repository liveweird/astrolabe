import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import userEvent from "@testing-library/user-event";
import { screen } from "@testing-library/react";
import Programs from "./Programs";
import type { Deviation } from "../api/deviations";
import type { ProgramsProgram, ProgramsView, ProgramsWorkStream } from "../api/programs";
import type { PlanFlag, RoadmapProject } from "../api/roadmap";
import { jsonResponse } from "../test/http";
import { renderWithProviders } from "../test/render";
import { detail, evidence } from "../test/deviations";

// The 1.3 Jira markers on the Programs page: the "Jira dates" toggle (on by default, remembered) and the shadow bar of each bound PROJECT row. Work stream
// and program rows are not bound in 1.3: no Jira bar there, and the roll-up counts in the Flags cell stay severity-driven.

const KEY = "astrolabe.viewSettings.timeline.jiraBars";

const flag = (kind: PlanFlag["kind"], severity: PlanFlag["severity"], over: Partial<PlanFlag> = {}): PlanFlag => ({ kind, severity, ...over });

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
  teamIds: [],
  span: { start: "2026-03-02", end: "2026-04-10" },
  drift: null,
  flags: [],
  can: { editTargetWindow: false },
  ...over,
});

// Jira ends a week before the plan's span (2026-04-10): the evidence of the open END deviation agrees with the dates on the bar.
const endLater: Deviation = { kind: "END_DIFFERS", severity: "WARNING", detail: detail({ plan: "2026-04-10", jira: "2026-04-03", days: 5 }) };

const INVOICES = project(1, "Invoices", {
  jira: { bindingId: 11, connectionId: 2, issueKey: "E2E-6", start: "2026-03-02", end: "2026-04-03", rollup: null },
  flags: [flag("JIRA_DEVIATION", "WARNING", { deviation: evidence(endLater) })],
});
const TAXES = project(2, "Taxes", { jira: { bindingId: 12, connectionId: 2, issueKey: "E2E-7", start: null, end: null, rollup: null } });
const BILLING: ProgramsProgram = { id: 10, name: "Billing", ownerName: "Pat Program", span: { start: "2026-03-02", end: "2026-04-10" }, flags: { warnings: 1, infos: 0 }, projects: [INVOICES, TAXES] };
const PLATFORM: ProgramsWorkStream = {
  id: 1,
  name: "Platform",
  ownerName: "Sam Stream",
  startDate: "2026-01-05",
  endDate: null,
  span: { start: "2026-03-02", end: "2026-04-10" },
  flags: { warnings: 1, infos: 0 },
  programs: [BILLING],
};
const VIEW: ProgramsView = { jiraSites: [{ connectionId: 2, siteUrl: "https://acme.atlassian.net", state: "CURRENT" as const, mappingOk: true }], revision: 9, teams: [], links: [], workStreams: [PLATFORM] };

beforeEach(() => {
  vi.stubGlobal(
    "fetch",
    vi.fn((url: string) => {
      if (url.startsWith("/api/v1/views/programs")) return Promise.resolve(jsonResponse(200, VIEW));
      if (url === "/api/v1/baselines") return Promise.resolve(jsonResponse(200, { items: [], can: { manage: false } }));
      if (url === "/api/v1/public-holidays") return Promise.resolve(jsonResponse(200, { items: [] }));
      return Promise.resolve(jsonResponse(404, { title: "x", status: 404 }));
    }),
  );
  localStorage.setItem("astrolabe.auth.token", "fake-token");
});

afterEach(() => {
  vi.unstubAllGlobals();
  localStorage.clear();
});

const waitForGrid = () => screen.findByRole("grid", { name: "Programs timeline" });
const jiraBars = () => [...document.querySelectorAll('[data-tone="jira"]')].map((bar) => bar.getAttribute("aria-label"));
const toggle = () => screen.getByRole("button", { name: "Jira dates" });

describe("Programs page: the Jira dates", () => {
  test("on by default: a shadow bar on each bound project row with both dates once its program is open; none on the node rows", async () => {
    const user = userEvent.setup();
    renderWithProviders(<Programs />);
    await waitForGrid();
    expect(toggle()).toHaveAttribute("aria-pressed", "true");
    expect(jiraBars()).toEqual([]); // the projects are folded away under Billing
    await user.click(screen.getByRole("button", { name: "Program Billing" }));
    expect(jiraBars()).toEqual(["Jira E2E-6: 2026-03-02 to 2026-04-03, Ends 5 working days later than Jira (plan 2026-04-10, Jira 2026-04-03), read-only"]);
    expect(localStorage.getItem(KEY)).toBeNull();
  });

  test("the toggle hides the bars and remembers it; a later visit starts hidden", async () => {
    const user = userEvent.setup();
    const first = renderWithProviders(<Programs />);
    await waitForGrid();
    await user.click(screen.getByRole("button", { name: "Program Billing" }));
    expect(jiraBars()).toHaveLength(1);
    await user.click(toggle());
    expect(toggle()).toHaveAttribute("aria-pressed", "false");
    expect(jiraBars()).toEqual([]);
    expect(JSON.parse(localStorage.getItem(KEY) ?? "null")).toBe(false);
    first.unmount();

    renderWithProviders(<Programs />);
    await waitForGrid();
    expect(toggle()).toHaveAttribute("aria-pressed", "false");
    await user.click(screen.getByRole("button", { name: "Program Billing" }));
    expect(jiraBars()).toEqual([]);
    await user.click(toggle());
    expect(jiraBars()).toHaveLength(1);
  });

  test("without a Jira site in the view there is no toggle, and the remembered choice is left alone", async () => {
    localStorage.setItem(KEY, "false");
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string) => {
        if (url.startsWith("/api/v1/views/programs")) return Promise.resolve(jsonResponse(200, { ...VIEW, jiraSites: [] }));
        if (url === "/api/v1/baselines") return Promise.resolve(jsonResponse(200, { items: [], can: { manage: false } }));
        return Promise.resolve(jsonResponse(200, { items: [] }));
      }),
    );
    renderWithProviders(<Programs />);
    await waitForGrid();
    expect(screen.queryByRole("button", { name: "Jira dates" })).toBeNull();
    expect(localStorage.getItem(KEY)).toBe("false");
  });

  test("the toggle follows the baseline picker in the timeline's toolbar", async () => {
    renderWithProviders(<Programs />);
    await waitForGrid();
    const picker = screen.getByRole("combobox", { name: "Baseline" });
    expect(picker.compareDocumentPosition(toggle()) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
});
