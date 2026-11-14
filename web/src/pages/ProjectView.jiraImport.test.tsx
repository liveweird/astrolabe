import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import userEvent from "@testing-library/user-event";
import { screen, waitFor, within } from "@testing-library/react";
import { Route, Routes } from "react-router-dom";
import ProjectView from "./ProjectView";
import type { ProjectView as ProjectViewDocument } from "../api/milestones";
import type { JiraLink } from "../api/roadmap";
import { DEV_CONNECTION, view as deviationsView } from "../test/deviations";
import { jsonResponse } from "../test/http";
import { previewOf } from "../test/jiraImport";
import { renderWithProviders } from "../test/render";

// "Import from Jira…" on the project page (1.14): the header button for a LINKED project the caller may add milestones to, the dialog rooted at the
// project (the connections are read only then), and the rooted preview body. The page's other Jira markers are in ProjectView.jira.test.tsx.

const PROJECT_LINK: JiraLink = { bindingId: 5, connectionId: DEV_CONNECTION.id, issueKey: "E2E-1", start: null, end: null, rollup: null };
const can = { edit: true, delete: true, editTargetWindow: false, createMilestone: true, createDependency: false };

const viewOf = (over: Partial<ProjectViewDocument["project"]["can"]> = {}, jira: JiraLink | null = PROJECT_LINK): ProjectViewDocument => ({
  revision: 10,
  jiraSites: [{ connectionId: DEV_CONNECTION.id, siteUrl: DEV_CONNECTION.siteUrl, state: "CURRENT" as const, mappingOk: true }],
  project: {
    jira,
    flags: [],
    id: 7, programId: 70, workStreamId: 700, programName: "Billing", workStreamName: "Platform", name: "Invoices", description: null,
    ownerPersonId: 5, ownerName: "Ola Owner", targetStart: null, targetEnd: null, createdAt: 1, updatedAt: 2, can: { ...can, ...over },
  },
  span: null,
  drift: null,
  scheduled: [],
  unscheduled: [],
  dependencies: [],
  idleGaps: [],
  criticalPath: { upstream: [], upstreamTruncated: false },
});

let mockFetch: ReturnType<typeof vi.fn>;
let project: ProjectViewDocument;
let previews: unknown[];

const gets = (matcher: RegExp) => mockFetch.mock.calls.filter(([url, init]) => matcher.test(url as string) && ((init as RequestInit | undefined)?.method ?? "GET") === "GET").length;
const renderPage = () => renderWithProviders(<Routes><Route path="/projects/:id" element={<ProjectView />} /></Routes>, { route: "/projects/7" });
const importButton = () => screen.queryByRole("button", { name: "Import from Jira…" });

beforeEach(() => {
  project = viewOf();
  previews = [];
  mockFetch = vi.fn((url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    if (method === "GET" && url === "/api/v1/views/project/7") return Promise.resolve(jsonResponse(200, project));
    if (method === "GET" && url === "/api/v1/public-holidays") return Promise.resolve(jsonResponse(200, { items: [] }));
    if (method === "GET" && url === "/api/v1/views/deviations?projectId=7") return Promise.resolve(jsonResponse(200, deviationsView({ items: [] })));
    if (method === "POST" && url === "/api/v1/integrations/jira/connections/1/import-preview") {
      previews.push(JSON.parse(init?.body as string));
      return Promise.resolve(jsonResponse(200, previewOf([])));
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

describe("the project page's Import from Jira…", () => {
  test("a linked project the caller may add milestones to has the button beside Unlink; nothing asks for the connections until it is clicked", async () => {
    renderPage();
    await screen.findByRole("button", { name: "Unlink from Jira" });
    expect(importButton()).toBeInTheDocument();
    expect(gets(/views\/deviations/)).toBe(0);
  });

  test("it is absent without can.createMilestone, and while the view says the project is not linked", async () => {
    project = viewOf({ createMilestone: false });
    const first = renderPage();
    await screen.findByRole("button", { name: "Unlink from Jira" });
    expect(importButton()).not.toBeInTheDocument();
    first.unmount();

    project = viewOf({}, null);
    renderPage();
    await screen.findByRole("button", { name: "Link to Jira…" });
    expect(importButton()).not.toBeInTheDocument();
    expect(gets(/views\/deviations/)).toBe(0);
  });

  test("the dialog opens rooted at the project: the connections are asked for then, the note names the key and the project, no owner or work stream is asked", async () => {
    const user = userEvent.setup();
    renderPage();
    await user.click(await screen.findByRole("button", { name: "Import from Jira…" }));
    const dialog = await screen.findByRole("dialog", { name: "Import from Jira" });
    await waitFor(() => expect(gets(/views\/deviations\?projectId=7/)).toBe(1));
    expect(within(dialog).getByRole("note")).toHaveTextContent("Importing what Jira lists under E2E-1 into the project “Invoices”: its milestones.");
    expect(within(dialog).queryByRole("combobox", { name: "Owner of the new items" })).not.toBeInTheDocument();
    expect(within(dialog).queryByRole("combobox", { name: /^Work stream/ })).not.toBeInTheDocument();
    expect(await within(dialog).findByRole("combobox", { name: /^Jira connection/ })).toHaveValue("Acme Jira");
  });

  test("the preview carries the project's root, its work stream and its owner - never the keys or a default program", async () => {
    const user = userEvent.setup();
    renderPage();
    await user.click(await screen.findByRole("button", { name: "Import from Jira…" }));
    const dialog = await screen.findByRole("dialog", { name: "Import from Jira" });
    const preview = await within(dialog).findByRole("button", { name: "Preview" });
    await waitFor(() => expect(preview).toBeEnabled());
    await user.click(preview);
    await waitFor(() => expect(previews).toHaveLength(1));
    expect(previews[0]).toEqual({ workStreamId: 700, ownerPersonId: 5, copyDates: true, filter: { excludeDone: true, updatedWithinDays: 365 }, root: { level: "PROJECT", nodeId: 7 } });
  });

  test("closing the dialog leaves the page as it was", async () => {
    const user = userEvent.setup();
    renderPage();
    await user.click(await screen.findByRole("button", { name: "Import from Jira…" }));
    const dialog = await screen.findByRole("dialog", { name: "Import from Jira" });
    await user.click(within(dialog).getByRole("button", { name: "Close" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Import from Jira" })).not.toBeInTheDocument());
    expect(screen.getByRole("heading", { level: 2, name: "Invoices" })).toBeInTheDocument();
  });
});
