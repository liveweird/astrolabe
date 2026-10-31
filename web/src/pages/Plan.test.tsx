import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import userEvent from "@testing-library/user-event";
import { screen, waitFor, within } from "@testing-library/react";
import Plan from "./Plan";
import type { PlanProgram, PlanProject, PlanView, PlanWorkStream } from "../api/plan";
import { QueryClient } from "@tanstack/react-query";
import { headingOutline } from "../test/headings";
import { jsonResponse } from "../test/http";
import { renderWithProviders } from "../test/render";

type FetchMock = ReturnType<typeof vi.fn>;

const project = (over: Partial<PlanProject> & Pick<PlanProject, "id" | "name">): PlanProject => ({
  programId: 10,
  workStreamId: 1,
  description: null,
  ownerPersonId: 5,
  ownerName: "Piotr Project",
  targetStart: null,
  targetEnd: null,
  createdAt: 1,
  updatedAt: 2,
  can: { edit: true, delete: true, editTargetWindow: true },
  ...over,
});

const program = (over: Partial<PlanProgram> & Pick<PlanProgram, "id" | "name">): PlanProgram => ({
  workStreamId: 1,
  description: null,
  ownerPersonId: 6,
  ownerName: "Pola Program",
  createdAt: 1,
  updatedAt: 2,
  can: { edit: true, delete: true, createProject: true },
  projects: [],
  ...over,
});

const stream = (over: Partial<PlanWorkStream> & Pick<PlanWorkStream, "id" | "name">): PlanWorkStream => ({
  description: null,
  ownerPersonId: 4,
  ownerName: "Ola Owner",
  startDate: "2026-01-05",
  endDate: null,
  createdAt: 1,
  updatedAt: 2,
  can: { edit: true, delete: true, createProgram: true },
  programs: [],
  ...over,
});

const INVOICES = project({ id: 100, name: "Invoices", targetStart: "2026-02-01", targetEnd: "2026-03-31", description: "Monthly invoicing" });
// An owner without the window right, and a roadmap editor (window only) — the two halves of the project modal.
const TAXES = project({ id: 101, name: "Taxes", ownerName: "Tania Tax", can: { edit: true, delete: false, editTargetWindow: false } });
const AUDIT = project({ id: 102, name: "Audit", targetStart: "2026-04-01", targetEnd: "2026-04-30", can: { edit: false, delete: false, editTargetWindow: true } });

const VIEW: PlanView = {
  revision: 5,
  can: { createWorkStream: true },
  workStreams: [
    stream({
      id: 1,
      name: "Platform",
      description: "The core platform",
      programs: [program({ id: 10, name: "Billing", description: "Money in", projects: [INVOICES, TAXES, AUDIT] }), program({ id: 11, name: "Identity" })],
    }),
    stream({ id: 2, name: "Legacy", endDate: "2025-12-31", startDate: "2024-01-01" }),
  ],
};

const PEOPLE = {
  items: [
    { id: 4, name: "Ola Owner", email: "ola@example.com", userId: null, userEmail: null, createdAt: 1, updatedAt: 2 },
    { id: 7, name: "Nina New", email: "nina@example.com", userId: null, userEmail: null, createdAt: 1, updatedAt: 2 },
  ],
  page: 1,
  pageSize: 50,
  total: 2,
};

let view: PlanView;

function serve(mockFetch: FetchMock, mutations: Record<string, { status: number; body?: unknown }> = {}) {
  mockFetch.mockImplementation((url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    const m = mutations[`${method} ${url}`];
    if (m) return Promise.resolve(m.body === undefined ? new Response(null, { status: m.status }) : jsonResponse(m.status, m.body));
    if (method === "GET" && url === "/api/v1/views/plan") return Promise.resolve(jsonResponse(200, view));
    if (method === "GET" && url.startsWith("/api/v1/people?")) return Promise.resolve(jsonResponse(200, PEOPLE));
    return Promise.resolve(jsonResponse(404, { title: "x", status: 404 }));
  });
}

const findCalls = (mockFetch: FetchMock, method: string, url: string) =>
  mockFetch.mock.calls.filter(([u, init]) => ((init as RequestInit | undefined)?.method ?? "GET") === method && u === url);
const bodyOf = (mockFetch: FetchMock, method: string, url: string) => JSON.parse((findCalls(mockFetch, method, url)[0][1] as RequestInit).body as string);
const writes = (mockFetch: FetchMock) =>
  mockFetch.mock.calls.map(([u, init]) => `${(init as RequestInit | undefined)?.method ?? "GET"} ${u}`).filter((c) => !c.startsWith("GET"));

async function pickOwner(user: ReturnType<typeof userEvent.setup>, modal: HTMLElement, search: string, option: string) {
  const owner = within(modal).getByRole("combobox", { name: "Owner" });
  await user.click(owner);
  await user.type(owner, search);
  await user.click(await screen.findByRole("option", { name: option }));
}

async function openMenu(user: ReturnType<typeof userEvent.setup>, name: string, item: string) {
  await user.click(await screen.findByRole("button", { name: `Operations for ${name}` }));
  await user.click(await screen.findByRole("menuitem", { name: item }));
}

describe("Plan page", () => {
  let mockFetch: FetchMock;

  beforeEach(() => {
    view = VIEW;
    mockFetch = vi.fn();
    vi.stubGlobal("fetch", mockFetch);
    localStorage.setItem("astrolabe.auth.token", "fake-token");
    serve(mockFetch);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    localStorage.clear();
  });

  test("renders the tree: stream h3, program h4, projects in a named table, the heading outline pinned", async () => {
    renderWithProviders(<Plan />);
    await screen.findByRole("heading", { level: 3, name: "Platform" });
    expect(headingOutline()).toEqual([
      [2, "Plan"],
      [3, "Platform"],
      [4, "Billing"],
      [4, "Identity"],
      [3, "Legacy"],
    ]);
    expect(screen.getByText("The core platform")).toBeInTheDocument();
    expect(screen.getByText("Owner: Ola Owner · From 2026-01-05")).toBeInTheDocument();
    const table = screen.getByRole("table", { name: "Projects of Billing" });
    const row = within(table).getByRole("row", { name: /Invoices/ });
    expect(within(row).getByText("Piotr Project")).toBeInTheDocument();
    expect(within(row).getByText("2026-02-01 – 2026-03-31")).toBeInTheDocument();
    expect(within(table).getByRole("row", { name: /Taxes/ })).toHaveTextContent("Not set");
    expect(screen.getByText("No projects yet")).toBeInTheDocument();
  });

  test("a closed work stream shows the Closed badge and its dates; an open one does not", async () => {
    renderWithProviders(<Plan />);
    await screen.findByRole("heading", { level: 3, name: "Legacy" });
    expect(screen.getAllByText("Closed")).toHaveLength(1);
    expect(screen.getByText("Owner: Ola Owner · 2024-01-01 – 2025-12-31")).toBeInTheDocument();
    expect(screen.getByText("No programs yet")).toBeInTheDocument();
    // A closed stream still takes programs.
    expect(screen.getByRole("button", { name: "New program in Legacy" })).toBeInTheDocument();
  });

  test("shows only the actions the can flags allow", async () => {
    view = {
      revision: 1,
      can: { createWorkStream: false },
      workStreams: [
        stream({
          id: 1,
          name: "Platform",
          can: { edit: false, delete: false, createProgram: false },
          programs: [
            program({ id: 10, name: "Billing", can: { edit: false, delete: false, createProject: false }, projects: [TAXES, AUDIT, INVOICES].map((p) => ({ ...p, can: { edit: p.id === 101, delete: false, editTargetWindow: p.id === 102 } })) }),
          ],
        }),
      ],
    };
    const user = userEvent.setup();
    renderWithProviders(<Plan />);
    await screen.findByRole("heading", { level: 3, name: "Platform" });
    expect(screen.queryByRole("button", { name: /new work stream/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /new program/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /new project/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Operations for Platform" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Operations for Billing" })).not.toBeInTheDocument();
    // Taxes: edit only; Audit: window only (still an Edit entry); Invoices: nothing.
    await user.click(screen.getByRole("button", { name: "Operations for Taxes" }));
    expect(await screen.findByRole("menuitem", { name: "Edit Taxes" })).toBeInTheDocument();
    expect(screen.queryByRole("menuitem", { name: /^Delete/ })).not.toBeInTheDocument();
    await user.keyboard("{Escape}");
    expect(screen.getByRole("button", { name: "Operations for Audit" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Operations for Invoices" })).not.toBeInTheDocument();
  });

  test("the empty plan offers the first work stream to a creator and a hint to everyone else", async () => {
    view = { revision: 0, can: { createWorkStream: true }, workStreams: [] };
    const first = renderWithProviders(<Plan />);
    expect(await screen.findByText("No work streams yet")).toBeInTheDocument();
    expect(screen.getByText("Create the first work stream to start planning.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "New work stream" })).toBeInTheDocument();
    first.unmount();

    view = { revision: 0, can: { createWorkStream: false }, workStreams: [] };
    renderWithProviders(<Plan />);
    expect(await screen.findByText("An administrator creates the first work stream.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "New work stream" })).not.toBeInTheDocument();
  });

  test("shows the load-failure alert", async () => {
    mockFetch.mockImplementation(() => Promise.resolve(jsonResponse(500, { title: "boom", status: 500 })));
    renderWithProviders(<Plan />);
    expect(await screen.findByText("Could not load the plan")).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 2, name: "Plan" })).toBeInTheDocument();
  });

  test("creating a work stream posts name, owner and the typed ISO start date; the end stays null", async () => {
    serve(mockFetch, { "POST /api/v1/work-streams": { status: 201, body: { id: 3 } } });
    const user = userEvent.setup();
    renderWithProviders(<Plan />);
    await user.click(await screen.findByRole("button", { name: "New work stream" }));
    const modal = screen.getByRole("dialog");
    await user.type(within(modal).getByLabelText("Name"), "  Growth ");
    await pickOwner(user, modal, "nina", "Nina New (nina@example.com)");
    await user.type(within(modal).getByLabelText(/Start date/), "2026-03-01");
    await user.click(within(modal).getByRole("button", { name: /^create$/i }));
    await waitFor(() => expect(findCalls(mockFetch, "POST", "/api/v1/work-streams")).toHaveLength(1));
    expect(bodyOf(mockFetch, "POST", "/api/v1/work-streams")).toEqual({
      name: "Growth",
      description: null,
      ownerPersonId: 7,
      startDate: "2026-03-01",
      endDate: null,
    });
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    // The plan is reloaded after the write.
    expect(findCalls(mockFetch, "GET", "/api/v1/views/plan").length).toBeGreaterThan(1);
  });

  test("the work stream form blocks a missing owner and start date, and an end before the start", async () => {
    const user = userEvent.setup();
    renderWithProviders(<Plan />);
    await user.click(await screen.findByRole("button", { name: "New work stream" }));
    const modal = screen.getByRole("dialog");
    await user.click(within(modal).getByRole("button", { name: /^create$/i }));
    expect(await screen.findByText("Name must be 1–100 characters")).toBeInTheDocument();
    expect(screen.getByText("Pick an owner")).toBeInTheDocument();
    expect(screen.getByText("Enter a start date")).toBeInTheDocument();

    await user.type(within(modal).getByLabelText(/Start date/), "2026-03-01");
    await user.type(within(modal).getByLabelText("End date"), "2026-02-01");
    await user.click(within(modal).getByRole("button", { name: /^create$/i }));
    expect(await screen.findByText("The end must not be before the start")).toBeInTheDocument();
    expect(writes(mockFetch)).toEqual([]);
  });

  test("editing a work stream prefills it; clearing the end date reopens (an explicit null)", async () => {
    serve(mockFetch, { "PUT /api/v1/work-streams/2": { status: 204 } });
    const user = userEvent.setup();
    renderWithProviders(<Plan />);
    await openMenu(user, "Legacy", "Edit Legacy");
    const modal = await screen.findByRole("dialog");
    expect(within(modal).getByLabelText("Name")).toHaveValue("Legacy");
    expect(within(modal).getByRole("combobox", { name: "Owner" })).toHaveValue("Ola Owner");
    expect(within(modal).getByLabelText(/Start date/)).toHaveValue("2024-01-01");
    expect(within(modal).getByLabelText("End date")).toHaveValue("2025-12-31");
    await user.click(within(modal).getByLabelText("Clear End date"));
    await user.click(within(modal).getByRole("button", { name: /^save$/i }));
    await waitFor(() => expect(findCalls(mockFetch, "PUT", "/api/v1/work-streams/2")).toHaveLength(1));
    expect(bodyOf(mockFetch, "PUT", "/api/v1/work-streams/2")).toEqual({
      name: "Legacy",
      description: null,
      ownerPersonId: 4,
      startDate: "2024-01-01",
      endDate: null,
    });
  });

  test("Close work stream sends the full PUT with an end date of today (never before the start); Reopen sends null", async () => {
    serve(mockFetch, { "PUT /api/v1/work-streams/1": { status: 204 }, "PUT /api/v1/work-streams/2": { status: 204 } });
    const user = userEvent.setup();
    renderWithProviders(<Plan />);
    await openMenu(user, "Platform", "Close work stream Platform");
    await waitFor(() => expect(findCalls(mockFetch, "PUT", "/api/v1/work-streams/1")).toHaveLength(1));
    const closed = bodyOf(mockFetch, "PUT", "/api/v1/work-streams/1");
    expect(closed).toMatchObject({ name: "Platform", description: "The core platform", ownerPersonId: 4, startDate: "2026-01-05" });
    expect(closed.endDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(closed.endDate >= "2026-01-05").toBe(true);

    await openMenu(user, "Legacy", "Reopen work stream Legacy");
    await waitFor(() => expect(findCalls(mockFetch, "PUT", "/api/v1/work-streams/2")).toHaveLength(1));
    expect(bodyOf(mockFetch, "PUT", "/api/v1/work-streams/2").endDate).toBeNull();
  });

  test("a failed close shows an inline alert", async () => {
    serve(mockFetch, { "PUT /api/v1/work-streams/1": { status: 403, body: { title: "Forbidden", status: 403 } } });
    const user = userEvent.setup();
    renderWithProviders(<Plan />);
    await openMenu(user, "Platform", "Close work stream Platform");
    expect(await screen.findByText("You are not allowed to change this")).toBeInTheDocument();
  });

  test("creating a program posts to its work stream with the owner; a 409 marks the name", async () => {
    serve(mockFetch, { "POST /api/v1/work-streams/1/programs": { status: 409, body: { title: "Conflict", status: 409 } } });
    const user = userEvent.setup();
    renderWithProviders(<Plan />);
    await user.click(await screen.findByRole("button", { name: "New program in Platform" }));
    const modal = screen.getByRole("dialog");
    expect(within(modal).getByText("In work stream Platform")).toBeInTheDocument();
    await user.type(within(modal).getByLabelText("Name"), "Billing");
    await user.type(within(modal).getByLabelText("Description"), "dup");
    await pickOwner(user, modal, "ola", "Ola Owner (ola@example.com)");
    await user.click(within(modal).getByRole("button", { name: /^create$/i }));
    expect(await screen.findByText("A program with this name already exists")).toBeInTheDocument();
    expect(within(modal).getByLabelText("Name")).toHaveAttribute("aria-invalid", "true");
    expect(bodyOf(mockFetch, "POST", "/api/v1/work-streams/1/programs")).toEqual({ name: "Billing", description: "dup", ownerPersonId: 4 });

    serve(mockFetch, { "POST /api/v1/work-streams/1/programs": { status: 201, body: { id: 12 } } });
    await user.click(within(modal).getByRole("button", { name: /^create$/i }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  });

  test("editing a program hands the owner over (a PUT with the new owner id)", async () => {
    serve(mockFetch, { "PUT /api/v1/programs/11": { status: 204 } });
    const user = userEvent.setup();
    renderWithProviders(<Plan />);
    await openMenu(user, "Identity", "Edit Identity");
    const modal = await screen.findByRole("dialog");
    expect(within(modal).getByRole("combobox", { name: "Owner" })).toHaveValue("Pola Program");
    await user.click(within(modal).getByLabelText("Clear the owner"));
    await pickOwner(user, modal, "nina", "Nina New (nina@example.com)");
    await user.click(within(modal).getByRole("button", { name: /^save$/i }));
    await waitFor(() => expect(findCalls(mockFetch, "PUT", "/api/v1/programs/11")).toHaveLength(1));
    expect(bodyOf(mockFetch, "PUT", "/api/v1/programs/11")).toEqual({ name: "Identity", description: null, ownerPersonId: 7 });
  });

  test("creating a project carries the target window in the create body; a 400 stays inline", async () => {
    serve(mockFetch, { "POST /api/v1/programs/11/projects": { status: 400, body: { title: "Bad", status: 400 } } });
    const user = userEvent.setup();
    renderWithProviders(<Plan />);
    await user.click(await screen.findByRole("button", { name: "New project in Identity" }));
    const modal = screen.getByRole("dialog");
    expect(within(modal).getByText("In program Identity")).toBeInTheDocument();
    await user.type(within(modal).getByLabelText("Name"), "SSO");
    await pickOwner(user, modal, "ola", "Ola Owner (ola@example.com)");
    await user.type(within(modal).getByLabelText("Target start"), "2026-05-01");
    await user.type(within(modal).getByLabelText("Target end"), "2026-06-30");
    await user.click(within(modal).getByRole("button", { name: /^create$/i }));
    expect(await within(modal).findByText(/One or more fields are invalid/)).toBeInTheDocument();
    expect(bodyOf(mockFetch, "POST", "/api/v1/programs/11/projects")).toEqual({
      name: "SSO",
      description: null,
      ownerPersonId: 4,
      targetStart: "2026-05-01",
      targetEnd: "2026-06-30",
    });
  });

  test("a half target window is refused before any request", async () => {
    const user = userEvent.setup();
    renderWithProviders(<Plan />);
    await user.click(await screen.findByRole("button", { name: "New project in Identity" }));
    const modal = screen.getByRole("dialog");
    await user.type(within(modal).getByLabelText("Name"), "SSO");
    await pickOwner(user, modal, "ola", "Ola Owner (ola@example.com)");
    await user.type(within(modal).getByLabelText("Target start"), "2026-05-01");
    await user.click(within(modal).getByRole("button", { name: /^create$/i }));
    expect(await screen.findByText("Set both target dates or neither")).toBeInTheDocument();
    expect(writes(mockFetch)).toEqual([]);
  });

  test("the project modal enables each part by its own flag: an owner edits the fields but not the window", async () => {
    const user = userEvent.setup();
    renderWithProviders(<Plan />);
    await openMenu(user, "Taxes", "Edit Taxes");
    const modal = await screen.findByRole("dialog");
    expect(within(modal).getByLabelText("Name")).toBeEnabled();
    expect(within(modal).getByRole("combobox", { name: "Owner" })).toBeEnabled();
    expect(within(modal).getByLabelText("Target start")).toBeDisabled();
    expect(within(modal).getByLabelText("Target end")).toBeDisabled();
    expect(within(modal).getByText(/Only an administrator, an owner above the project or a roadmap editor/)).toBeInTheDocument();
  });

  test("a roadmap editor (window right only) sees the fields read-only and saves just the window", async () => {
    serve(mockFetch, { "PUT /api/v1/projects/102/target-window": { status: 204 } });
    const user = userEvent.setup();
    renderWithProviders(<Plan />);
    await openMenu(user, "Audit", "Edit Audit");
    const modal = await screen.findByRole("dialog");
    expect(within(modal).getByLabelText("Name")).toBeDisabled();
    expect(within(modal).getByRole("combobox", { name: "Owner" })).toBeDisabled();
    expect(within(modal).getByText(/Only the project's owner, an owner above it or an administrator/)).toBeInTheDocument();
    const end = within(modal).getByLabelText("Target end");
    expect(end).toBeEnabled();
    await user.clear(end);
    await user.type(end, "2026-05-15");
    await user.click(within(modal).getByRole("button", { name: /^save$/i }));
    await waitFor(() => expect(findCalls(mockFetch, "PUT", "/api/v1/projects/102/target-window")).toHaveLength(1));
    expect(bodyOf(mockFetch, "PUT", "/api/v1/projects/102/target-window")).toEqual({ targetStart: "2026-04-01", targetEnd: "2026-05-15" });
    expect(writes(mockFetch)).toEqual(["PUT /api/v1/projects/102/target-window"]);
  });

  test("changing fields and window saves two PUTs, fields first; unchanged parts are not sent", async () => {
    serve(mockFetch, { "PUT /api/v1/projects/100": { status: 204 }, "PUT /api/v1/projects/100/target-window": { status: 204 } });
    const user = userEvent.setup();
    renderWithProviders(<Plan />);
    await openMenu(user, "Invoices", "Edit Invoices");
    const modal = await screen.findByRole("dialog");
    expect(within(modal).getByLabelText("Target start")).toHaveValue("2026-02-01");
    await user.clear(within(modal).getByLabelText("Name"));
    await user.type(within(modal).getByLabelText("Name"), "Invoices 2");
    const end = within(modal).getByLabelText("Target end");
    await user.clear(end);
    await user.type(end, "2026-04-15");
    await user.click(within(modal).getByRole("button", { name: /^save$/i }));
    await waitFor(() => expect(writes(mockFetch)).toHaveLength(2));
    expect(writes(mockFetch)).toEqual(["PUT /api/v1/projects/100", "PUT /api/v1/projects/100/target-window"]);
    expect(bodyOf(mockFetch, "PUT", "/api/v1/projects/100")).toEqual({ name: "Invoices 2", description: "Monthly invoicing", ownerPersonId: 5 });
    expect(bodyOf(mockFetch, "PUT", "/api/v1/projects/100/target-window")).toEqual({ targetStart: "2026-02-01", targetEnd: "2026-04-15" });
  });

  test("only the fields changed: one PUT, no window request", async () => {
    serve(mockFetch, { "PUT /api/v1/projects/100": { status: 204 } });
    const user = userEvent.setup();
    renderWithProviders(<Plan />);
    await openMenu(user, "Invoices", "Edit Invoices");
    const modal = await screen.findByRole("dialog");
    await user.type(within(modal).getByLabelText("Name"), "!");
    await user.click(within(modal).getByRole("button", { name: /^save$/i }));
    await waitFor(() => expect(writes(mockFetch)).toEqual(["PUT /api/v1/projects/100"]));
  });

  test("saving without a change just closes the modal", async () => {
    const user = userEvent.setup();
    renderWithProviders(<Plan />);
    await openMenu(user, "Invoices", "Edit Invoices");
    const modal = await screen.findByRole("dialog");
    await user.click(within(modal).getByRole("button", { name: /^save$/i }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(writes(mockFetch)).toEqual([]);
  });

  test("when the window PUT fails after the fields PUT, a retry sends only the window", async () => {
    serve(mockFetch, {
      "PUT /api/v1/projects/100": { status: 204 },
      "PUT /api/v1/projects/100/target-window": { status: 403, body: { title: "Forbidden", status: 403 } },
    });
    const user = userEvent.setup();
    renderWithProviders(<Plan />);
    await openMenu(user, "Invoices", "Edit Invoices");
    const modal = await screen.findByRole("dialog");
    await user.type(within(modal).getByLabelText("Name"), "!");
    const end = within(modal).getByLabelText("Target end");
    await user.clear(end);
    await user.type(end, "2026-04-15");
    await user.click(within(modal).getByRole("button", { name: /^save$/i }));
    expect(await within(modal).findByText("You are not allowed to change this")).toBeInTheDocument();

    serve(mockFetch, { "PUT /api/v1/projects/100/target-window": { status: 204 } });
    mockFetch.mockClear();
    await user.click(within(modal).getByRole("button", { name: /^save$/i }));
    await waitFor(() => expect(writes(mockFetch)).toEqual(["PUT /api/v1/projects/100/target-window"]));
  });

  test("a project name clash (409) marks the name field", async () => {
    serve(mockFetch, { "PUT /api/v1/projects/100": { status: 409, body: { title: "Conflict", status: 409 } } });
    const user = userEvent.setup();
    renderWithProviders(<Plan />);
    await openMenu(user, "Invoices", "Edit Invoices");
    const modal = await screen.findByRole("dialog");
    await user.type(within(modal).getByLabelText("Name"), "!");
    await user.click(within(modal).getByRole("button", { name: /^save$/i }));
    expect(await screen.findByText("A project with this name already exists in this program")).toBeInTheDocument();
  });

  test("deleting a project confirms, calls DELETE and reloads the plan", async () => {
    serve(mockFetch, { "DELETE /api/v1/projects/100": { status: 204 } });
    const user = userEvent.setup();
    renderWithProviders(<Plan />);
    await openMenu(user, "Invoices", "Delete Invoices");
    expect(await screen.findByText(/Project "Invoices" will be deleted/)).toBeInTheDocument();
    const before = findCalls(mockFetch, "GET", "/api/v1/views/plan").length;
    await user.click(within(screen.getByRole("dialog")).getByRole("button", { name: /^delete$/i }));
    await waitFor(() => expect(findCalls(mockFetch, "DELETE", "/api/v1/projects/100")).toHaveLength(1));
    await waitFor(() => expect(findCalls(mockFetch, "GET", "/api/v1/views/plan").length).toBeGreaterThan(before));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  });

  test("deleting a program or work stream that still has children says so (409)", async () => {
    serve(mockFetch, {
      "DELETE /api/v1/programs/10": { status: 409, body: { title: "Conflict", status: 409 } },
      "DELETE /api/v1/work-streams/1": { status: 409, body: { title: "Conflict", status: 409 } },
    });
    const user = userEvent.setup();
    renderWithProviders(<Plan />);
    await openMenu(user, "Billing", "Delete Billing");
    await user.click(within(await screen.findByRole("dialog")).getByRole("button", { name: /^delete$/i }));
    expect(await screen.findByText("This program still has projects. Delete them first.")).toBeInTheDocument();
    await user.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());

    await openMenu(user, "Platform", "Delete Platform");
    await user.click(within(await screen.findByRole("dialog")).getByRole("button", { name: /^delete$/i }));
    expect(await screen.findByText("This work stream still has programs. Delete them first.")).toBeInTheDocument();
  });
});

describe("Plan page and the roadmap", () => {
  beforeEach(() => {
    view = VIEW;
    vi.stubGlobal("fetch", vi.fn());
    localStorage.setItem("astrolabe.auth.token", "fake-token");
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    localStorage.clear();
  });

  test("a plan mutation also invalidates the cached roadmap (a deleted project leaves the ranking)", async () => {
    const mockFetch = fetch as unknown as FetchMock;
    serve(mockFetch, { "DELETE /api/v1/projects/100": { status: 204 } });
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    queryClient.setQueryData(["roadmap", "view"], { revision: 1, can: { editRank: false }, ranked: [], unranked: [] });
    const user = userEvent.setup();
    renderWithProviders(<Plan />, { queryClient });
    await openMenu(user, "Invoices", "Delete Invoices");
    await user.click(within(await screen.findByRole("dialog")).getByRole("button", { name: /^delete$/i }));
    await waitFor(() => expect(queryClient.getQueryState(["roadmap", "view"])?.isInvalidated).toBe(true));
  });
});
