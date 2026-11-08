import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import userEvent from "@testing-library/user-event";
import { screen, waitFor, within } from "@testing-library/react";
import DependencyEditorModal from "./DependencyEditorModal";
import type { EndpointRef, ProjectDependency } from "../api/dependencies";
import { jsonResponse } from "../test/http";
import { renderWithProviders } from "../test/render";

const MILESTONES = {
  items: [
    { id: 11, projectId: 2, projectName: "Alpha", name: "a1", teamId: 3, teamName: "Backend", estimateMd: 1, description: null, startDate: null, endDate: null, createdAt: 1, updatedAt: 2 },
    { id: 12, projectId: 3, projectName: "Beta", name: "a1", teamId: 3, teamName: "Backend", estimateMd: 1, description: null, startDate: null, endDate: null, createdAt: 1, updatedAt: 2 },
    // a milestone of the project being edited: picking it as the predecessor of itself is the self-link
    { id: 1, projectId: 7, projectName: "Invoices", name: "b1", teamId: 3, teamName: "Backend", estimateMd: 1, description: null, startDate: null, endDate: null, createdAt: 1, updatedAt: 2 },
  ],
  page: 1,
  pageSize: 50,
  total: 3,
};
const PROJECTS = {
  items: [{ id: 2, programId: 20, programName: "Billing", workStreamId: 200, workStreamName: "Platform", name: "Alpha", description: null, ownerPersonId: 1, ownerName: "O", targetStart: null, targetEnd: null, createdAt: 1, updatedAt: 2 }],
  page: 1,
  pageSize: 50,
  total: 1,
};

const CYCLE = {
  type: "urn:astrolabe:problem:dependency-cycle",
  title: "Conflict",
  status: 409,
  detail: "server words",
  cycle: [
    { kind: "MILESTONE", id: 1, name: "b1" },
    { kind: "MILESTONE", id: 11, name: "a1" },
    { kind: "MILESTONE", id: 1, name: "b1" },
  ],
};

let mockFetch: ReturnType<typeof vi.fn>;
let post: { status: number; body: unknown };

beforeEach(() => {
  post = { status: 201, body: { id: 90 } };
  mockFetch = vi.fn((url: string, init?: RequestInit) => {
    if (init?.method === "POST") return Promise.resolve(jsonResponse(post.status, post.body));
    if (url.startsWith("/api/v1/milestones?")) return Promise.resolve(jsonResponse(200, MILESTONES));
    if (url.startsWith("/api/v1/projects?")) return Promise.resolve(jsonResponse(200, PROJECTS));
    return Promise.resolve(jsonResponse(404, { title: "x", status: 404 }));
  });
  vi.stubGlobal("fetch", mockFetch);
  localStorage.setItem("astrolabe.auth.token", "fake-token");
});

afterEach(() => {
  vi.unstubAllGlobals();
  localStorage.clear();
});

const posts = () => mockFetch.mock.calls.filter(([, init]) => (init as RequestInit | undefined)?.method === "POST").map(([url, init]) => ({ url: url as string, body: JSON.parse((init as RequestInit).body as string) }));

function renderModal(successor: EndpointRef | null = null, onSaved = vi.fn(() => Promise.resolve()), onClose = vi.fn()) {
  renderWithProviders(
    <DependencyEditorModal
      project={{ id: 7, name: "Invoices" }}
      milestones={[
        { id: 1, name: "b1" },
        { id: 5, name: "Build" },
      ]}
      successor={successor}
      onClose={onClose}
      onSaved={onSaved}
    />,
  );
  return { onSaved };
}

describe("DependencyEditorModal", () => {
  test("searches milestones by name across projects, tells equal names apart by project, and POSTs the picked link", async () => {
    const user = userEvent.setup();
    const { onSaved } = renderModal({ kind: "MILESTONE", id: 1 });
    const dialog = await screen.findByRole("dialog", { name: "Add dependency" });
    // the successor is prefilled with the milestone the shortcut was opened on; the project itself and every milestone are offered
    expect(within(dialog).getByRole("combobox", { name: "Successor" })).toHaveValue("b1");
    await user.click(within(dialog).getByRole("combobox", { name: "Predecessor" }));
    expect(await screen.findByRole("option", { name: "a1 · Alpha" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "a1 · Beta" })).toBeInTheDocument();
    await user.click(screen.getByRole("option", { name: "a1 · Alpha" }));
    await user.click(within(dialog).getByRole("combobox", { name: "Type" }));
    await user.click(await screen.findByRole("option", { name: "Start → Start (SS)" }));
    const lag = within(dialog).getByRole("textbox", { name: /Lag/ });
    await user.clear(lag);
    await user.type(lag, "-2");
    await user.click(within(dialog).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    expect(posts()).toEqual([
      {
        url: "/api/v1/projects/7/dependencies",
        body: { predecessor: { kind: "MILESTONE", id: 11 }, successor: { kind: "MILESTONE", id: 1 }, type: "SS", lagDays: -2 },
      },
    ]);
    expect(mockFetch.mock.calls.some(([url]) => (url as string).startsWith("/api/v1/milestones?") && (url as string).includes("sort=name"))).toBe(true);
  });

  test("the kind toggle switches the predecessor to a project search ('project · program · work stream')", async () => {
    const user = userEvent.setup();
    renderModal();
    const dialog = await screen.findByRole("dialog");
    // the successor defaults to the project itself; the kind defaults to Milestone
    expect(within(dialog).getByRole("combobox", { name: "Successor" })).toHaveValue("This project (Invoices)");
    expect(within(dialog).getByRole("radio", { name: "Milestone" })).toBeChecked();
    await user.click(within(dialog).getByRole("radio", { name: "Project" }));
    await user.click(within(dialog).getByRole("combobox", { name: "Predecessor" }));
    await user.click(await screen.findByRole("option", { name: "Alpha · Billing · Platform" }));
    await user.click(within(dialog).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(posts()).toHaveLength(1));
    expect(posts()[0].body).toEqual({ predecessor: { kind: "PROJECT", id: 2 }, successor: { kind: "PROJECT", id: 7 }, type: "FS", lagDays: 0 });
  });

  test("an end cannot be linked to itself, a predecessor is required and nothing is sent", async () => {
    const user = userEvent.setup();
    renderModal({ kind: "MILESTONE", id: 1 });
    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: "Save" }));
    expect(await within(dialog).findByText("Pick the predecessor")).toBeInTheDocument();
    // milestone 1 ("b1") is the successor: a milestone predecessor of the same id is itself
    await user.click(within(dialog).getByRole("combobox", { name: "Predecessor" }));
    await user.click(await screen.findByRole("option", { name: "b1 · Invoices" }));
    await user.click(within(dialog).getByRole("button", { name: "Save" }));
    expect(await within(dialog).findByText("An end cannot depend on itself")).toBeInTheDocument();
    expect(posts()).toEqual([]);
  });

  test("the lag must be a whole number of working days in range", async () => {
    const user = userEvent.setup();
    renderModal();
    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("combobox", { name: "Predecessor" }));
    await user.click(await screen.findByRole("option", { name: "a1 · Alpha" }));
    const lag = within(dialog).getByRole("textbox", { name: /Lag/ });
    await user.clear(lag);
    await user.click(within(dialog).getByRole("button", { name: "Save" }));
    expect(await within(dialog).findByText("Enter a whole number of working days from -365 to 365")).toBeInTheDocument();
    expect(posts()).toEqual([]);
  });

  test("while the save is in flight the dialog cannot be closed (X, Escape, outside click) and Cancel is disabled", async () => {
    let release: () => void = () => undefined;
    const base = mockFetch.getMockImplementation() as (url: string, init?: RequestInit) => Promise<Response>;
    mockFetch.mockImplementation((url: string, init?: RequestInit) =>
      init?.method === "POST" ? new Promise<Response>((resolve) => { release = () => resolve(jsonResponse(201, { id: 90 })); }) : base(url, init),
    );
    const user = userEvent.setup();
    const onClose = vi.fn();
    const { onSaved } = renderModal(null, undefined, onClose);
    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("combobox", { name: "Predecessor" }));
    await user.click(await screen.findByRole("option", { name: "a1 · Alpha" }));
    expect(within(dialog).getByRole("button", { name: "Close" })).toBeInTheDocument();
    await user.click(within(dialog).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(within(dialog).queryByRole("button", { name: "Close" })).toBeNull());
    await user.keyboard("{Escape}");
    await user.click(document.querySelector(".mantine-Modal-overlay") as HTMLElement);
    expect(within(dialog).getByRole("button", { name: "Cancel" })).toBeDisabled();
    expect(onClose).not.toHaveBeenCalled();
    release();
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
  });

  test("a cycle 409 shows the notice with the path in the UI language; the dialog stays open and retryable", async () => {
    post = { status: 409, body: CYCLE };
    const user = userEvent.setup();
    const { onSaved } = renderModal({ kind: "MILESTONE", id: 1 });
    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("combobox", { name: "Predecessor" }));
    await user.click(await screen.findByRole("option", { name: "a1 · Alpha" }));
    await user.click(within(dialog).getByRole("button", { name: "Save" }));
    const alert = await within(dialog).findByRole("alert");
    expect(alert).toHaveTextContent("This link would close a cycle through:");
    expect(alert).toHaveTextContent("b1 → a1 → b1");
    expect(alert).not.toHaveTextContent("server words");
    expect(onSaved).not.toHaveBeenCalled();
    expect(within(dialog).getByRole("button", { name: "Save" })).toBeEnabled();
  });

  test("a duplicate pair (any other 409), a forbidden caller and a vanished predecessor read as fixed sentences", async () => {
    const user = userEvent.setup();
    renderModal();
    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("combobox", { name: "Predecessor" }));
    await user.click(await screen.findByRole("option", { name: "a1 · Alpha" }));
    const save = within(dialog).getByRole("button", { name: "Save" });
    post = { status: 409, body: { title: "Conflict", status: 409, detail: "These two endpoints are already linked" } };
    await user.click(save);
    expect(await within(dialog).findByRole("alert")).toHaveTextContent("These two ends are already linked.");
    post = { status: 403, body: { title: "Forbidden", status: 403 } };
    await user.click(save);
    await waitFor(() => expect(within(dialog).getByRole("alert")).toHaveTextContent("Only the owners of the successor's project"));
    post = { status: 400, body: { title: "Bad", status: 400, detail: "Unknown or deleted milestone ids: 11" } };
    await user.click(save);
    await waitFor(() => expect(within(dialog).getByRole("alert")).toHaveTextContent("either may have been deleted meanwhile"));
  });

  describe("edit mode (a target link)", () => {
    const TARGET: ProjectDependency = {
      id: 31,
      predecessor: { kind: "MILESTONE", id: 11, name: "a1", projectId: 2, projectName: "Alpha", teamId: 3, teamName: "Backend", startDate: null, endDate: null },
      successor: { kind: "PROJECT", id: 7, name: "Invoices", projectId: 7, projectName: "Invoices", teamId: null, teamName: null, startDate: null, endDate: null },
      type: "FF",
      lagDays: 3,
      check: { status: "UNSCHEDULED", shortfallDays: null, slackDays: null, requiredDate: null, actualDate: null },
      critical: false,
      can: { edit: true, delete: true },
    };
    const puts = () => mockFetch.mock.calls.filter(([, init]) => (init as RequestInit | undefined)?.method === "PUT").map(([url, init]) => ({ url: url as string, body: JSON.parse((init as RequestInit).body as string) }));

    function renderEdit(onSaved = vi.fn(() => Promise.resolve())) {
      renderWithProviders(<DependencyEditorModal project={{ id: 7, name: "Invoices" }} milestones={[]} successor={null} target={TARGET} onClose={vi.fn()} onSaved={onSaved} />);
      return { onSaved };
    }

    test("shows both ends as read-only text, prefills the type and lag, and PUTs only those two", async () => {
      mockFetch.mockImplementation(() => Promise.resolve(new Response(null, { status: 204 })));
      const user = userEvent.setup();
      const { onSaved } = renderEdit();
      const dialog = await screen.findByRole("dialog", { name: "Edit dependency" });
      expect(within(dialog).getByRole("textbox", { name: "Predecessor" })).toHaveValue("a1 · Alpha");
      expect(within(dialog).getByRole("textbox", { name: "Successor" })).toHaveValue("Project Invoices");
      expect(within(dialog).queryByRole("radio")).toBeNull();
      expect(within(dialog).getByRole("combobox", { name: "Type" })).toHaveValue("Finish → Finish (FF)");
      expect(within(dialog).getByRole("textbox", { name: /Lag/ })).toHaveValue("3");
      await user.click(within(dialog).getByRole("combobox", { name: "Type" }));
      await user.click(await screen.findByRole("option", { name: "Start → Finish (SF)" }));
      await user.click(within(dialog).getByRole("button", { name: "Save" }));
      await waitFor(() => expect(onSaved).toHaveBeenCalled());
      expect(puts()).toEqual([{ url: "/api/v1/dependencies/31", body: { type: "SF", lagDays: 3 } }]);
      expect(posts()).toEqual([]);
    });

    test("an out-of-range lag is refused before anything is sent", async () => {
      const user = userEvent.setup();
      renderEdit();
      const dialog = await screen.findByRole("dialog", { name: "Edit dependency" });
      const lag = within(dialog).getByRole("textbox", { name: /Lag/ });
      await user.clear(lag);
      await user.click(within(dialog).getByRole("button", { name: "Save" }));
      expect(await within(dialog).findByText("Enter a whole number of working days from -365 to 365")).toBeInTheDocument();
      expect(puts()).toEqual([]);
    });
  });
});
