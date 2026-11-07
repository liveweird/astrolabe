import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import userEvent from "@testing-library/user-event";
import { screen, waitFor, within } from "@testing-library/react";
import { Route, Routes } from "react-router-dom";
import ProjectView from "./ProjectView";
import type { ProjectMilestone, ProjectView as ProjectViewDocument } from "../api/milestones";
import { DEV_CONNECTION, endLater, item, view as deviationsView } from "../test/deviations";
import { jsonResponse } from "../test/http";
import { renderWithProviders } from "../test/render";

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
  can: { edit: true, delete: true, schedule: false },
  ...over,
});

const projectCan = { edit: true, delete: true, editTargetWindow: false, createMilestone: true, createDependency: false };
const viewOf = (over: Partial<ProjectViewDocument["project"]["can"]> = {}, milestones: ProjectMilestone[] = [milestone(1, "Discovery"), milestone(2, "Build", { startDate: "2027-01-18", endDate: "2027-01-22" })]): ProjectViewDocument => ({
  revision: 10,
  jiraSites: [],
  project: {
    jira: null,
    flags: [],
    id: 7, programId: 70, workStreamId: 700, programName: "Billing", workStreamName: "Platform", name: "Invoices", description: null,
    ownerPersonId: 5, ownerName: "Ola Owner", targetStart: null, targetEnd: null, createdAt: 1, updatedAt: 2, can: { ...projectCan, ...over },
  },
  span: { start: "2027-01-11", end: "2027-01-22" },
  drift: null,
  scheduled: milestones,
  unscheduled: [],
  dependencies: [],
  idleGaps: [],
  criticalPath: { upstream: [], upstreamTruncated: false },
});

const projectItem = () => item({ bindingId: 5, level: "PROJECT", node: { ...item().node, kind: "PROJECT", id: 7, name: "Invoices", teamId: null, teamName: null }, jira: { ...item().jira, key: "E2E-1" }, deviations: [] });
const milestoneItem = () => item({ bindingId: 6, node: { ...item().node, id: 2, name: "Build" }, jira: { ...item().jira, key: "E2E-3" }, deviations: [endLater(3)] });

type FetchMock = ReturnType<typeof vi.fn>;
let project: ProjectViewDocument;
let deviations: { status: number; body: unknown };
let post: { status: number; body: unknown };
let del: { status: number };
/** Resolves the deviations answer later when set (the chip query "still on its way"). */
let holdDeviations: Promise<void> | null;

function serve(mockFetch: FetchMock) {
  mockFetch.mockImplementation((url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    if (method === "GET" && url === "/api/v1/views/project/7") return Promise.resolve(jsonResponse(200, project));
    if (method === "GET" && url === "/api/v1/public-holidays") return Promise.resolve(jsonResponse(200, { items: [] }));
    if (method === "GET" && url === "/api/v1/views/deviations?projectId=7") {
      const answer = () => jsonResponse(deviations.status, deviations.body);
      return holdDeviations === null ? Promise.resolve(answer()) : holdDeviations.then(answer);
    }
    if (method === "DELETE" && url.startsWith("/api/v1/integrations/jira/bindings/")) return Promise.resolve(del.status === 204 ? new Response(null, { status: 204 }) : jsonResponse(del.status, { title: "x", status: del.status }));
    if (method === "POST" && url === "/api/v1/integrations/jira/bindings") return Promise.resolve(jsonResponse(post.status, post.body));
    return Promise.resolve(jsonResponse(404, { title: "Not Found", status: 404 }));
  });
}

describe("the project page's Jira chip and Link to Jira…", () => {
  let mockFetch: FetchMock;
  const gets = (matcher: RegExp) => mockFetch.mock.calls.filter(([url, init]) => matcher.test(url as string) && ((init as RequestInit | undefined)?.method ?? "GET") === "GET").length;
  beforeEach(() => {
    mockFetch = vi.fn();
    vi.stubGlobal("fetch", mockFetch);
    localStorage.setItem("astrolabe.auth.token", "fake-token");
    localStorage.setItem("astrolabe.auth.roles", JSON.stringify(["USER"]));
    project = viewOf();
    deviations = { status: 200, body: deviationsView({ items: [projectItem(), milestoneItem()] }) };
    post = { status: 201, body: { id: 90 } };
    del = { status: 204 };
    holdDeviations = null;
    serve(mockFetch);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    localStorage.clear();
  });
  const renderPage = () => renderWithProviders(<Routes><Route path="/projects/:id" element={<ProjectView />} /></Routes>, { route: "/projects/7" });

  test("when the project is linked the facts line shows 'Jira: KEY', how many milestones are linked, and a deviation count that opens the page filtered to the project", async () => {
    renderPage();
    const group = await screen.findByRole("group", { name: "Links to Jira" });
    expect(within(group).getByRole("link", { name: /E2E-1/ })).toHaveAttribute("href", "https://acme.atlassian.net/browse/E2E-1");
    expect(within(group).getByText("1 milestone linked to Jira")).toBeInTheDocument();
    expect(within(group).getByRole("link", { name: "1 Jira deviation" })).toHaveAttribute("href", "/deviations?projectId=7");
  });

  test("a failed deviations request shows no chip, and the page and its timeline are as without Jira", async () => {
    deviations = { status: 500, body: { title: "Internal Server Error", status: 500 } };
    renderPage();
    expect(await screen.findByRole("heading", { level: 2, name: "Invoices" })).toBeInTheDocument();
    await waitFor(() => expect(gets(/views\/deviations/)).toBe(1));
    expect(screen.queryByRole("group", { name: "Links to Jira" })).not.toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.getByRole("grid", { name: "Milestone timeline" })).toBeInTheDocument();
  });

  test("the deviations request is asked after the project view, never instead of it", async () => {
    renderPage();
    await screen.findByRole("heading", { level: 2, name: "Invoices" });
    await waitFor(() => expect(gets(/views\/deviations\?projectId=7/)).toBe(1));
    const order = mockFetch.mock.calls.map(([url]) => url as string);
    expect(order.indexOf("/api/v1/views/project/7")).toBeLessThan(order.indexOf("/api/v1/views/deviations?projectId=7"));
  });

  test("the header offers 'Link to Jira…' with the project's can.edit while nothing links the project", async () => {
    deviations = { status: 200, body: deviationsView({ items: [] }) };
    renderPage();
    expect(await screen.findByRole("button", { name: "Link to Jira…" })).toBeInTheDocument();
  });

  test("a project already linked has no Link button; a viewer without can.edit (a team manager who owns nothing here) sees none and no milestone link item either", async () => {
    const first = renderPage();
    await screen.findByRole("group", { name: "Links to Jira" });
    expect(screen.queryByRole("button", { name: "Link to Jira…" })).not.toBeInTheDocument();
    first.unmount();

    project = viewOf({ edit: false }, [milestone(1, "Discovery", { can: { edit: false, delete: false, schedule: true } })]);
    deviations = { status: 200, body: deviationsView({ items: [] }) };
    renderPage();
    await screen.findByRole("heading", { level: 2, name: "Invoices" });
    await waitFor(() => expect(gets(/views\/deviations\?projectId=7/)).toBeGreaterThan(1));
    expect(screen.queryByRole("button", { name: "Link to Jira…" })).not.toBeInTheDocument();
    await userEvent.setup().click(screen.getByRole("button", { name: "Operations for Discovery" }));
    expect(screen.queryByRole("menuitem", { name: /Link to Jira/ })).not.toBeInTheDocument();
  });

  test("a milestone's menu offers the link with its own can.edit; a linked one offers Unlink instead, and the milestone dialog has the node fixed", async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByRole("group", { name: "Links to Jira" });
    await user.click(screen.getByRole("button", { name: "Operations for Build" }));
    // Linked and editable: not the link, but the unlink.
    expect(await screen.findByRole("menuitem", { name: "Unlink from Jira: E2E-3 (Build)" })).toBeEnabled();
    expect(screen.queryByRole("menuitem", { name: /Link to Jira…/ })).not.toBeInTheDocument();
    await user.keyboard("{Escape}");
    await user.click(screen.getByRole("button", { name: "Operations for Discovery" }));
    await user.click(await screen.findByRole("menuitem", { name: "Link to Jira…: Discovery" }));
    const dialog = await screen.findByRole("dialog", { name: "Link to Jira" });
    expect(await within(dialog).findByRole("textbox", { name: "Plan item" })).toHaveValue("Discovery");
    expect(within(dialog).queryByRole("combobox", { name: "Plan item type" })).not.toBeInTheDocument();
    await user.type(within(dialog).getByRole("textbox", { name: "Jira issue key" }), "e2e-9");
    await user.click(within(dialog).getByRole("button", { name: "Link" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Link to Jira" })).not.toBeInTheDocument());
    const posted = mockFetch.mock.calls.find(([url, init]) => url === "/api/v1/integrations/jira/bindings" && (init as RequestInit).method === "POST");
    expect(JSON.parse((posted?.[1] as RequestInit).body as string)).toEqual({ connectionId: DEV_CONNECTION.id, level: "MILESTONE", nodeId: 1, issueKey: "E2E-9" });
  });

  test("linking refreshes the Jira queries AND the project view (it carries the link's flags and bar)", async () => {
    deviations = { status: 200, body: deviationsView({ items: [] }) };
    const user = userEvent.setup();
    renderPage();
    await user.click(await screen.findByRole("button", { name: "Link to Jira…" }));
    const dialog = await screen.findByRole("dialog", { name: "Link to Jira" });
    await user.type(await within(dialog).findByRole("textbox", { name: "Jira issue key" }), "E2E-1");
    const viewReads = gets(/views\/project\/7$/);
    await user.click(within(dialog).getByRole("button", { name: "Link" }));
    await waitFor(() => expect(gets(/views\/deviations\?projectId=7/)).toBeGreaterThan(1));
    await waitFor(() => expect(gets(/views\/project\/7$/)).toBeGreaterThan(viewReads));
    const posted = mockFetch.mock.calls.find(([url, init]) => url === "/api/v1/integrations/jira/bindings" && (init as RequestInit).method === "POST");
    expect(JSON.parse((posted?.[1] as RequestInit).body as string)).toMatchObject({ level: "PROJECT", nodeId: 7 });
  });

  test("the refused link (409 already-bound) stays in the dialog on the project page", async () => {
    deviations = { status: 200, body: deviationsView({ items: [] }) };
    post = { status: 409, body: { type: "urn:astrolabe:problem:already-bound", title: "Conflict", status: 409, detail: "E2E-1 is already linked to project Other" } };
    const user = userEvent.setup();
    renderPage();
    await user.click(await screen.findByRole("button", { name: "Link to Jira…" }));
    const dialog = await screen.findByRole("dialog", { name: "Link to Jira" });
    await user.type(await within(dialog).findByRole("textbox", { name: "Jira issue key" }), "E2E-1");
    await user.click(within(dialog).getByRole("button", { name: "Link" }));
    expect(await within(dialog).findByText("E2E-1 is already linked to project Other")).toBeInTheDocument();
    expect(within(dialog).getByRole("textbox", { name: "Jira issue key" })).toHaveValue("E2E-1");
  });

  const unlinkCalls = () => mockFetch.mock.calls.filter(([, init]) => (init as RequestInit | undefined)?.method === "DELETE").map(([url]) => url as string);

  test("the owner unlinks the project from the header: confirm names the item and the key, DELETEs that binding, refreshes the Jira queries and the project view, focus goes to the heading", async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByRole("group", { name: "Links to Jira" });
    const viewReads = gets(/views\/project\/7$/);
    await user.click(await screen.findByRole("button", { name: "Unlink from Jira" }));
    const dialog = await screen.findByRole("dialog", { name: "Unlink from Jira?" });
    expect(within(dialog).getByText(/Invoices will no longer be linked to E2E-1/)).toBeInTheDocument();
    deviations = { status: 200, body: deviationsView({ items: [milestoneItem()] }) };
    await user.click(within(dialog).getByRole("button", { name: "Unlink" }));
    await waitFor(() => expect(unlinkCalls()).toEqual(["/api/v1/integrations/jira/bindings/5"]));
    await waitFor(() => expect(screen.getByRole("button", { name: "Link to Jira…" })).toBeInTheDocument());
    await waitFor(() => expect(gets(/views\/project\/7$/)).toBeGreaterThan(viewReads));
    await waitFor(() => expect(screen.getByRole("heading", { level: 2, name: "Invoices" })).toHaveFocus());
  });

  test("the owner unlinks a milestone from its row menu (the right binding id), and a refusal (403) or a vanished link (404) stays inline", async () => {
    const user = userEvent.setup();
    del = { status: 403 };
    renderPage();
    await screen.findByRole("group", { name: "Links to Jira" });
    await user.click(screen.getByRole("button", { name: "Operations for Build" }));
    await user.click(await screen.findByRole("menuitem", { name: "Unlink from Jira: E2E-3 (Build)" }));
    const dialog = await screen.findByRole("dialog", { name: "Unlink from Jira?" });
    expect(within(dialog).getByText(/Build will no longer be linked to E2E-3/)).toBeInTheDocument();
    await user.click(within(dialog).getByRole("button", { name: "Unlink" }));
    expect(await within(dialog).findByText("Only the item's owners and administrators can unlink it.")).toBeInTheDocument();
    del = { status: 404 };
    await user.click(within(dialog).getByRole("button", { name: "Unlink" }));
    expect(await within(dialog).findByText("This link no longer exists.")).toBeInTheDocument();
    expect(unlinkCalls()).toEqual(["/api/v1/integrations/jira/bindings/6", "/api/v1/integrations/jira/bindings/6"]);
  });

  test("a team manager who owns nothing here sees no unlink - only the linked milestone's key, disabled", async () => {
    project = viewOf({ edit: false }, [milestone(1, "Discovery", { can: { edit: false, delete: false, schedule: true } })]);
    deviations = { status: 200, body: deviationsView({ items: [item({ bindingId: 7, node: { ...item().node, id: 1, name: "Discovery" }, jira: { ...item().jira, key: "E2E-8" }, deviations: [] })] }) };
    const user = userEvent.setup();
    renderPage();
    await screen.findByRole("group", { name: "Links to Jira" });
    expect(screen.queryByRole("button", { name: /Unlink from Jira|Link to Jira/ })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Operations for Discovery" }));
    expect(await screen.findByRole("menuitem", { name: "Linked to Jira: E2E-8 (Discovery)" })).toHaveAttribute("data-disabled", "true");
    expect(screen.queryByRole("menuitem", { name: /Unlink from Jira/ })).not.toBeInTheDocument();
  });

  test("the header's Jira action waits for the chip query: no Link flashes on a linked project while it is on its way, none after a failure", async () => {
    let release: () => void = () => undefined;
    holdDeviations = new Promise<void>((resolve) => (release = resolve));
    renderPage();
    expect(await screen.findByRole("heading", { level: 2, name: "Invoices" })).toBeInTheDocument();
    await waitFor(() => expect(gets(/views\/deviations\?projectId=7/)).toBe(1));
    expect(screen.queryByRole("button", { name: /Link to Jira|Unlink from Jira/ })).not.toBeInTheDocument();
    release();
    expect(await screen.findByRole("button", { name: "Unlink from Jira" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Link to Jira…" })).not.toBeInTheDocument();
  });

  test("the chip sits in the facts row, not under it", async () => {
    renderPage();
    const group = await screen.findByRole("group", { name: "Links to Jira" });
    expect(within(screen.getByRole("group", { name: "Project facts" })).getByRole("group", { name: "Links to Jira" })).toBe(group);
  });
});
