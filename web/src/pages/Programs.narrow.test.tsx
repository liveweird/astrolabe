import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import userEvent from "@testing-library/user-event";
import { screen, waitFor, within } from "@testing-library/react";
import { QueryClient } from "@tanstack/react-query";
import { useLocation } from "react-router-dom";
import Programs from "./Programs";
import { programsViewKey, type ProgramsProgram, type ProgramsView, type ProgramsWorkStream } from "../api/programs";
import type { RoadmapProject } from "../api/roadmap";
import { jsonResponse } from "../test/http";
import { renderWithProviders } from "../test/render";

// The Roadmap overview narrowed to a work stream (1.31, `?workStreamId=N`, where a work stream's name leads): what shows, what says so, the way back, an empty
// work stream or program, an unknown id, and the remembered program pick not fighting the address. The page's other behaviour: Programs.test.tsx.

const PICK_KEY = "astrolabe.viewSettings.planning.programPick";

const project = (id: number, name: string, programId: number, programName: string, workStreamId: number, workStreamName: string): RoadmapProject => ({
  jira: null,
  id,
  name,
  programId,
  programName,
  workStreamId,
  workStreamName,
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
});

const none = { warnings: 0, infos: 0 };
const BILLING: ProgramsProgram = { id: 10, name: "Billing", ownerPersonId: 5, ownerName: "Pat Program", span: { start: "2026-03-02", end: "2026-04-10" }, flags: none, projects: [project(1, "Invoices", 10, "Billing", 1, "Platform")] };
const REPORTS: ProgramsProgram = { id: 11, name: "Reports", ownerPersonId: 5, ownerName: "Rita Reports", span: { start: "2026-03-02", end: "2026-04-10" }, flags: none, projects: [project(3, "Dashboards", 11, "Reports", 1, "Platform")] };
const LEGACY: ProgramsProgram = { id: 12, name: "Legacy", ownerPersonId: 5, ownerName: "Leo Legacy", span: null, flags: none, projects: [] };
const PLATFORM: ProgramsWorkStream = { id: 1, name: "Platform", ownerPersonId: 5, ownerName: "Sam Stream", startDate: "2026-01-05", endDate: null, span: { start: "2026-03-02", end: "2026-04-10" }, flags: none, programs: [BILLING, REPORTS] };
const ARCHIVE: ProgramsWorkStream = { id: 2, name: "Archive", ownerPersonId: 5, ownerName: "Ava Archive", startDate: "2025-01-06", endDate: null, span: null, flags: none, programs: [LEGACY] };
const EMPTY: ProgramsWorkStream = { id: 3, name: "Fresh", ownerPersonId: 5, ownerName: "Fay Fresh", startDate: "2026-01-05", endDate: null, span: null, flags: none, programs: [] };

let view: ProgramsView;

beforeEach(() => {
  view = { jiraSites: [], revision: 9, teams: [], links: [], workStreams: [PLATFORM, ARCHIVE, EMPTY] };
  vi.stubGlobal(
    "fetch",
    vi.fn((url: string) => {
      if (url === "/api/v1/public-holidays") return Promise.resolve(jsonResponse(200, { items: [] }));
      return Promise.resolve(url === "/api/v1/views/programs" ? jsonResponse(200, view) : jsonResponse(404, { title: "x", status: 404 }));
    }),
  );
  localStorage.setItem("astrolabe.auth.token", "fake-token");
});

afterEach(() => {
  vi.unstubAllGlobals();
  localStorage.clear();
});

function Where() {
  const location = useLocation();
  return <p data-testid="where">{location.pathname + location.search}</p>;
}
const where = () => screen.getByTestId("where").textContent;
const renderAt = (route: string) =>
  renderWithProviders(
    <>
      <Programs />
      <Where />
    </>,
    { route },
  );
/** What the polite status regions say right now. */
const liveText = () => screen.getAllByRole("status").map((region) => region.textContent).join("");
const grid = () => screen.findByRole("grid", { name: "Programs timeline" });
const rowLabels = () =>
  within(screen.getByRole("grid", { name: "Programs timeline" }))
    .getAllByRole("row")
    .slice(1)
    .map((row) => row.querySelector("[role='rowheader'] button[aria-expanded]")?.getAttribute("aria-label") ?? row.querySelector("a[href^='/projects/']")?.textContent ?? row.querySelector("[role='rowheader']")?.textContent?.trim());

describe("the overview narrowed to a work stream", () => {
  test("only that work stream shows, with its programs open on their projects, the facts of what is left, and what is narrowed said above the timeline", async () => {
    renderAt("/roadmap?mode=overview&workStreamId=1");
    await grid();
    expect(rowLabels()).toEqual(["Work stream Platform", "Program Billing", "Invoices", "Program Reports", "Dashboards"]);
    const facts = screen.getByRole("group", { name: "Programs facts" });
    expect(within(facts).getByText("1 work stream")).toBeInTheDocument();
    expect(within(facts).getByText("2 programs")).toBeInTheDocument();
    expect(within(facts).getByText("2 projects")).toBeInTheDocument();
    expect(screen.getByText("Work stream: Platform")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^Filters/ })).toHaveTextContent("1");
    expect(where()).toBe("/roadmap?mode=overview&workStreamId=1");
  });

  test("the way back leaves the address with the other parameters kept, and the whole plan shows", async () => {
    const user = userEvent.setup();
    renderAt("/roadmap?mode=overview&workStreamId=1");
    await grid();
    await user.click(screen.getByRole("button", { name: "Show every work stream" }));
    await waitFor(() => expect(where()).toBe("/roadmap?mode=overview"));
    expect(screen.queryByText("Work stream: Platform")).toBeNull();
    expect(rowLabels()).toEqual(["Work stream Platform", "Program Billing", "Program Reports", "Work stream Archive", "Legacy Leo Legacy", "Fresh Fay Fresh"]);
  });

  test("the way back with a program pick remembered shows EVERY work stream: the pick does not come back", async () => {
    const user = userEvent.setup();
    localStorage.setItem(PICK_KEY, JSON.stringify([12]));
    renderAt("/roadmap?mode=overview&workStreamId=1");
    await grid();
    await user.click(screen.getByRole("button", { name: "Show every work stream" }));
    await waitFor(() => expect(where()).toBe("/roadmap?mode=overview"));
    expect(rowLabels()).toEqual(["Work stream Platform", "Program Billing", "Program Reports", "Work stream Archive", "Legacy Leo Legacy", "Fresh Fay Fresh"]);
    expect(JSON.parse(localStorage.getItem(PICK_KEY) ?? "null")).toEqual([12]);
  });

  test("a work stream with no projects says so beside the way back instead of a bare row", async () => {
    const user = userEvent.setup();
    renderAt("/roadmap?mode=overview&workStreamId=2");
    await grid();
    expect(screen.getAllByText("No projects in this work stream yet.")[0]).toBeInTheDocument();
    await waitFor(() => expect(liveText()).toContain("No projects in this work stream yet."));
    expect(rowLabels()).toEqual(["Work stream Archive", "Legacy Leo Legacy"]);
    await user.click(screen.getByRole("button", { name: "Show every work stream" }));
    await waitFor(() => expect(screen.queryByText("No projects in this work stream yet.")).toBeNull());
    expect(rowLabels()).toContain("Work stream Platform");
  });

  test("a work stream with nothing at all (no program) says the same", async () => {
    renderAt("/roadmap?mode=overview&workStreamId=3");
    await grid();
    expect(screen.getAllByText("No projects in this work stream yet.")[0]).toBeInTheDocument();
    expect(rowLabels()).toEqual(["Fresh Fay Fresh"]);
  });

  test("a program with no projects (the program pick a program's name leads to) says so, with a way back that clears the pick", async () => {
    const user = userEvent.setup();
    renderAt("/roadmap?mode=overview&programId=12");
    await grid();
    expect(screen.getAllByText("No projects in the picked program yet.")[0]).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Show every program" }));
    await waitFor(() => expect(where()).toBe("/roadmap?mode=overview"));
    expect(screen.queryByText("No projects in the picked program yet.")).toBeNull();
  });

  test("a program pick with projects shows no empty line, and the plan's own empty states are not this one", async () => {
    renderAt("/roadmap?mode=overview&programId=10");
    await grid();
    expect(screen.queryByText(/No projects in the picked/)).toBeNull();
    expect(rowLabels()).toEqual(["Work stream Platform", "Program Billing"]);
  });

  test("a work stream the plan does not have drops the narrowing with a dismissible notice: the whole plan shows and the address loses the parameter", async () => {
    const user = userEvent.setup();
    renderAt("/roadmap?mode=overview&workStreamId=99");
    await grid();
    // the visible note, a plain `note` (an Alert's implicit alert role would read it twice), and the always-mounted status region that says it
    expect(await screen.findByRole("note")).toHaveTextContent(/That work stream is not in the plan any more/);
    await waitFor(() => expect(liveText()).toMatch(/That work stream is not in the plan any more/));
    await waitFor(() => expect(where()).toBe("/roadmap?mode=overview"));
    expect(rowLabels()).toContain("Work stream Archive");
    expect(screen.queryByText(/^Work stream: /)).toBeNull();
    await user.click(screen.getByRole("button", { name: "Dismiss this notice" }));
    expect(screen.queryByRole("note")).toBeNull();
    await waitFor(() => expect(liveText()).toBe(""));
  });

  test("a failed refetch behind a cached copy that lacks the work stream says nothing: no notice, the narrowing named stays in the address", async () => {
    vi.stubGlobal("fetch", vi.fn((url: string) => Promise.resolve(url === "/api/v1/public-holidays" ? jsonResponse(200, { items: [] }) : jsonResponse(500, { title: "Server error", status: 500 }))));
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    queryClient.setQueryData(programsViewKey(null, null), view);
    renderWithProviders(
      <>
        <Programs />
        <Where />
      </>,
      { route: "/roadmap?mode=overview&workStreamId=99", queryClient },
    );
    await grid();
    await waitFor(() => expect(queryClient.getQueryState(programsViewKey(null, null))?.status).toBe("error"));
    expect(screen.queryByText(/That work stream is not in the plan any more/)).toBeNull();
    expect(where()).toBe("/roadmap?mode=overview&workStreamId=99");
  });

  test("a malformed id is the same notice", async () => {
    renderAt("/roadmap?mode=overview&workStreamId=abc");
    await grid();
    expect(await screen.findByRole("note")).toHaveTextContent(/That work stream is not in the plan any more/);
  });

  test("a remembered program pick does not fight an address naming a work stream: it is neither restored into the address nor applied", async () => {
    localStorage.setItem(PICK_KEY, JSON.stringify([12]));
    renderAt("/roadmap?mode=overview&workStreamId=1");
    await grid();
    expect(where()).toBe("/roadmap?mode=overview&workStreamId=1");
    expect(rowLabels()).toEqual(["Work stream Platform", "Program Billing", "Invoices", "Program Reports", "Dashboards"]);
    expect(JSON.parse(localStorage.getItem(PICK_KEY) ?? "null")).toEqual([12]);
  });

  test("the filter panel's Work stream field narrows by writing the address only (nothing remembered) and clears with its own button", async () => {
    const user = userEvent.setup();
    renderAt("/roadmap?mode=overview");
    await grid();
    await user.click(screen.getByRole("button", { name: /^Filters/ }));
    await user.click(screen.getByRole("combobox", { name: "Work stream" }));
    await user.click(await screen.findByRole("option", { name: "Archive" }));
    await waitFor(() => expect(where()).toBe("/roadmap?mode=overview&workStreamId=2"));
    expect(rowLabels()).toEqual(["Work stream Archive", "Legacy Leo Legacy"]);
    expect(localStorage.getItem(PICK_KEY)).toBeNull();
    await user.click(screen.getByLabelText("Clear work stream filter"));
    await waitFor(() => expect(where()).toBe("/roadmap?mode=overview"));
  });
});
