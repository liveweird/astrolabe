import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import userEvent from "@testing-library/user-event";
import { screen, waitFor, within } from "@testing-library/react";
import { Route, Routes } from "react-router-dom";
import ProjectView from "./ProjectView";
import type { ProjectMilestone, ProjectView as ProjectViewDocument } from "../api/milestones";
import { jsonResponse } from "../test/http";
import { renderWithProviders } from "../test/render";
import { applyPin } from "../utils/pinUpdate";

// The pin on the project page (1.7): the row menu's Pin / Unpin dates by the row's own `can.schedule` (the team's manager or an ADMIN - the project's
// owner sees the glyph and no item), the request, the live-region sentence (no toast) and the bar's name. The team page's twin is TeamDetails.pin.test.tsx.

const milestone = (id: number, name: string, over: Partial<ProjectMilestone> = {}): ProjectMilestone => ({
  jira: null,
  flags: [],
  id,
  projectId: 7,
  name,
  description: null,
  teamId: 3,
  teamName: "Backend",
  estimateMd: 5,
  startDate: "2027-01-11",
  endDate: "2027-01-15",
  createdAt: 1,
  updatedAt: 2,
  slackDays: null,
  critical: false,
  pinned: false,
  can: { edit: true, delete: true, schedule: true },
  ...over,
});

const viewOf = (schedule: boolean): ProjectViewDocument => ({
  revision: 10,
  jiraSites: [],
  project: {
    jira: null,
    flags: [],
    id: 7, programId: 70, workStreamId: 700, programName: "Billing", workStreamName: "Platform", name: "Invoices", description: null,
    ownerPersonId: 5, ownerName: "Ola Owner", targetStart: null, targetEnd: null, createdAt: 1, updatedAt: 2,
    can: { edit: true, delete: true, editTargetWindow: false, createMilestone: true, createDependency: false },
  },
  span: { start: "2027-01-11", end: "2027-01-22" },
  drift: null,
  scheduled: [
    milestone(1, "Discovery", { can: { edit: true, delete: true, schedule } }),
    milestone(2, "Build", { startDate: "2027-01-18", endDate: "2027-01-22", pinned: true, can: { edit: true, delete: true, schedule } }),
  ],
  unscheduled: [milestone(3, "Backlog", { startDate: null, endDate: null, can: { edit: true, delete: true, schedule } })],
  dependencies: [],
  idleGaps: [],
  criticalPath: { upstream: [], upstreamTruncated: false },
});

type FetchMock = ReturnType<typeof vi.fn>;
let project: ProjectViewDocument;

describe("the project page's pin", () => {
  let mockFetch: FetchMock;
  beforeEach(() => {
    project = viewOf(true);
    mockFetch = vi.fn((url: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      if (method === "GET" && url === "/api/v1/views/project/7") return Promise.resolve(jsonResponse(200, project));
      if (method === "GET" && url === "/api/v1/public-holidays") return Promise.resolve(jsonResponse(200, { items: [] }));
      const pin = /^\/api\/v1\/milestones\/(\d+)\/pin$/.exec(url);
      if (method === "PUT" && pin) {
        const body = JSON.parse(init?.body as string) as { pinned: boolean };
        project = { ...applyPin(project, Number(pin[1]), body.pinned), revision: project.revision + 1 };
        return Promise.resolve(jsonResponse(200, { revision: project.revision }));
      }
      return Promise.resolve(jsonResponse(404, { title: "Not Found", status: 404 }));
    });
    vi.stubGlobal("fetch", mockFetch);
    localStorage.setItem("astrolabe.auth.token", "fake-token");
    localStorage.setItem("astrolabe.auth.roles", JSON.stringify(["USER"]));
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    localStorage.clear();
  });

  const renderPage = () => renderWithProviders(<Routes><Route path="/projects/:id" element={<ProjectView />} /></Routes>, { route: "/projects/7" });
  const grid = () => screen.findByRole("grid", { name: "Milestone timeline" });
  const rowOf = (name: string) => within(screen.getByRole("grid", { name: "Milestone timeline" })).getAllByRole("row").find((row) => row.textContent?.includes(name)) as HTMLElement;
  const pinPuts = () =>
    mockFetch.mock.calls
      .filter(([url, init]) => /\/pin$/.test(url as string) && (init as RequestInit | undefined)?.method === "PUT")
      .map(([url, init]) => ({ url: url as string, body: JSON.parse((init as RequestInit).body as string) as unknown }));
  const openMenu = async (user: ReturnType<typeof userEvent.setup>, name: string) => user.click(screen.getByRole("button", { name: `Operations for ${name}` }));

  test("a pinned row carries the glyph with a hidden 'pinned' and the bar's name says so", async () => {
    renderPage();
    await grid();
    expect(within(rowOf("Build")).getByText("pinned")).toBeInTheDocument();
    expect(within(rowOf("Build")).getByRole("button", { name: /^Build, Backend, 2027-01-18 to 2027-01-22, 5 man-days, pinned$/ })).toBeInTheDocument();
    expect(within(rowOf("Discovery")).queryByText("pinned")).toBeNull();
  });

  test("Pin dates sends {pinned: true}, shows the glyph and says it in the live region (no toast); the menu then offers Unpin dates", async () => {
    const user = userEvent.setup();
    renderPage();
    await grid();
    await openMenu(user, "Discovery");
    await user.click(await screen.findByRole("menuitem", { name: "Pin dates of Discovery" }));
    expect(pinPuts()).toEqual([{ url: "/api/v1/milestones/1/pin", body: { pinned: true } }]);
    await waitFor(() => expect(within(rowOf("Discovery")).getByText("pinned")).toBeInTheDocument());
    expect(screen.getAllByRole("status").map((region) => region.textContent).join(" | ")).toContain("Discovery pinned");
    expect(document.querySelector(".mantine-Notification-root")).toBeNull();
    await openMenu(user, "Discovery");
    expect(await screen.findByRole("menuitem", { name: "Unpin dates of Discovery" })).toBeInTheDocument();
  });

  test("Unpin dates sends {pinned: false} and removes the glyph", async () => {
    const user = userEvent.setup();
    renderPage();
    await grid();
    await openMenu(user, "Build");
    await user.click(await screen.findByRole("menuitem", { name: "Unpin dates of Build" }));
    expect(pinPuts()).toEqual([{ url: "/api/v1/milestones/2/pin", body: { pinned: false } }]);
    await waitFor(() => expect(within(rowOf("Build")).queryByText("pinned")).toBeNull());
  });

  test("a viewer without the row's can.schedule (the owner) sees the glyph and no pin item; the tray row offers none either", async () => {
    project = viewOf(false);
    const user = userEvent.setup();
    renderPage();
    await grid();
    expect(within(rowOf("Build")).getByText("pinned")).toBeInTheDocument();
    await openMenu(user, "Build");
    expect(await screen.findByRole("menuitem", { name: "Edit Build" })).toBeInTheDocument();
    expect(screen.queryByRole("menuitem", { name: /pin dates/i })).toBeNull();
  });

  test("a manager's tray row offers no pin", async () => {
    const user = userEvent.setup();
    renderPage();
    await grid();
    await openMenu(user, "Backlog");
    expect(await screen.findByRole("menuitem", { name: "Edit schedule of Backlog" })).toBeInTheDocument();
    expect(screen.queryByRole("menuitem", { name: /pin dates/i })).toBeNull();
  });
});
