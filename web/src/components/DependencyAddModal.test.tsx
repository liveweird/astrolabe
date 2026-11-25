import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import userEvent from "@testing-library/user-event";
import { screen, waitFor, within } from "@testing-library/react";
import i18n from "../i18n";
import { deferred } from "../test/deferred";
import { jsonResponse } from "../test/http";
import { renderWithProviders } from "../test/render";
import DependencyAddModal from "./DependencyAddModal";

// The Dependencies page's add dialog on its own: the picker of the successor's project, the successor limited to it, the predecessor from the whole plan,
// the write and its refusals. The page around it (the button, the refresh, the focus) is `pages/Dependencies.add.test.tsx`.

const milestone = (id: number, projectId: number, projectName: string, name: string) => ({
  id, projectId, projectName, name, teamId: 3, teamName: "Backend", estimateMd: 1, description: null, startDate: null, endDate: null, createdAt: 1, updatedAt: 2,
});
const ALL_MILESTONES = [milestone(11, 2, "Alpha", "a1"), milestone(1, 7, "Invoices", "b1"), milestone(5, 7, "Invoices", "b2"), milestone(6, 9, "Payments", "c1")];
const PROJECTS = {
  items: [
    { id: 2, programId: 20, programName: "Billing", workStreamId: 200, workStreamName: "Platform", name: "Alpha", description: null, ownerPersonId: 1, ownerName: "O", targetStart: null, targetEnd: null, createdAt: 1, updatedAt: 2 },
    { id: 7, programId: 20, programName: "Billing", workStreamId: 200, workStreamName: "Platform", name: "Invoices", description: null, ownerPersonId: 1, ownerName: "O", targetStart: null, targetEnd: null, createdAt: 1, updatedAt: 2 },
  ],
  page: 1,
  pageSize: 50,
  total: 2,
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
/** The projects the caller may add to: two of the plan's three. */
const MAY_ADD = [
  { id: 7, label: "Invoices" },
  { id: 9, label: "Payments" },
];

let mockFetch: ReturnType<typeof vi.fn>;
let post: () => Response | Promise<Response>;

beforeEach(() => {
  post = () => jsonResponse(201, { id: 90 });
  mockFetch = vi.fn((url: string, init?: RequestInit) => {
    if (init?.method === "POST") return Promise.resolve(post());
    if (url.startsWith("/api/v1/milestones?")) {
      const projectId = new URL(url, "http://test").searchParams.get("projectId");
      const items = ALL_MILESTONES.filter((item) => projectId === null || String(item.projectId) === projectId);
      return Promise.resolve(jsonResponse(200, { items, page: 1, pageSize: 50, total: items.length }));
    }
    if (url.startsWith("/api/v1/projects?")) return Promise.resolve(jsonResponse(200, PROJECTS));
    return Promise.resolve(jsonResponse(404, { title: "x", status: 404 }));
  });
  vi.stubGlobal("fetch", mockFetch);
  localStorage.setItem("astrolabe.auth.token", "fake-token");
});

afterEach(async () => {
  vi.unstubAllGlobals();
  localStorage.clear();
  await i18n.changeLanguage("en");
});

const posts = () =>
  mockFetch.mock.calls
    .filter(([, init]) => (init as RequestInit | undefined)?.method === "POST")
    .map(([url, init]) => ({ url: String(url), body: JSON.parse(String((init as RequestInit).body)) }));
const milestoneReads = () => mockFetch.mock.calls.map(([url]) => String(url)).filter((url) => url.startsWith("/api/v1/milestones?"));

function renderModal(initialProjectId: number | null = null, onSaved = vi.fn(() => Promise.resolve()), onClose = vi.fn()) {
  const view = renderWithProviders(<DependencyAddModal projects={MAY_ADD} initialProjectId={initialProjectId} onClose={onClose} onSaved={onSaved} />);
  return { onSaved, onClose, unmount: view.unmount };
}

async function pickProject(user: ReturnType<typeof userEvent.setup>, dialog: HTMLElement, name: string) {
  await user.click(within(dialog).getByRole("combobox", { name: "Successor's project" }));
  await user.click(await screen.findByRole("option", { name }));
}

async function pickPredecessor(user: ReturnType<typeof userEvent.setup>, dialog: HTMLElement, option: string) {
  await user.click(within(dialog).getByRole("combobox", { name: "Predecessor" }));
  await user.click(await screen.findByRole("option", { name: option }));
}

describe("DependencyAddModal", () => {
  test("offers only the projects it is given, limits the successor milestones to the picked one and POSTs to that project", async () => {
    const user = userEvent.setup();
    const { onSaved } = renderModal();
    const dialog = await screen.findByRole("dialog", { name: "Add dependency" });
    // Before a project is picked there is nothing to pick a successor milestone from.
    expect(within(dialog).queryByRole("combobox", { name: "Successor" })).toBeNull();
    await user.click(within(dialog).getByRole("combobox", { name: "Successor's project" }));
    expect(screen.getAllByRole("option").map((option) => option.textContent)).toEqual(["Invoices", "Payments"]);
    await user.click(screen.getByRole("option", { name: "Invoices" }));

    await user.click(within(dialog).getByRole("combobox", { name: "Successor" }));
    expect((await screen.findAllByRole("option")).map((option) => option.textContent)).toEqual(["b1 · Invoices", "b2 · Invoices"]);
    expect(milestoneReads().some((url) => new URL(url, "http://test").searchParams.get("projectId") === "7")).toBe(true);
    await user.click(screen.getByRole("option", { name: "b1 · Invoices" }));

    await pickPredecessor(user, dialog, "a1 · Alpha");
    await user.click(within(dialog).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    expect(posts()).toEqual([
      {
        url: "/api/v1/projects/7/dependencies",
        body: { predecessor: { kind: "MILESTONE", id: 11 }, successor: { kind: "MILESTONE", id: 1 }, type: "FS", lagDays: 0 },
      },
    ]);
  });

  test("starts on the project it was opened for, when the caller may add to it; any other is ignored", async () => {
    renderModal(9);
    expect(await screen.findByRole("combobox", { name: "Successor's project" })).toHaveValue("Payments");
  });

  test("the dialog opens on the first empty field: the project select, or the successor milestone when a project is given", async () => {
    const first = renderModal();
    expect(await screen.findByRole("combobox", { name: "Successor's project" })).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole("combobox", { name: "Successor's project" })).toHaveFocus());
    first.unmount();

    renderModal(9);
    expect(await screen.findByRole("combobox", { name: "Successor" })).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole("combobox", { name: "Successor" })).toHaveFocus());
    expect(screen.getByRole("combobox", { name: "Successor's project" })).not.toHaveFocus();
  });

  test("a project the caller may not add to is not a start", async () => {
    renderModal(2);
    expect(await screen.findByRole("combobox", { name: "Successor's project" })).toHaveValue("");
  });

  test("a whole project can be the successor: no milestone picker, the project's own id in the body", async () => {
    const user = userEvent.setup();
    const { onSaved } = renderModal(9);
    const dialog = await screen.findByRole("dialog");
    await user.click(within(screen.getByRole("radiogroup", { name: "Successor is a" })).getByRole("radio", { name: "Project" }));
    expect(within(dialog).queryByRole("combobox", { name: "Successor" })).toBeNull();
    await pickPredecessor(user, dialog, "a1 · Alpha");
    await user.click(within(dialog).getByRole("combobox", { name: "Type" }));
    await user.click(await screen.findByRole("option", { name: "Start → Start (SS)" }));
    const lag = within(dialog).getByRole("textbox", { name: /Lag/ });
    await user.clear(lag);
    await user.type(lag, "-2");
    await user.click(within(dialog).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    expect(posts()).toEqual([
      {
        url: "/api/v1/projects/9/dependencies",
        body: { predecessor: { kind: "MILESTONE", id: 11 }, successor: { kind: "PROJECT", id: 9 }, type: "SS", lagDays: -2 },
      },
    ]);
  });

  test("the predecessor may be a whole project, found by name across the plan", async () => {
    const user = userEvent.setup();
    const { onSaved } = renderModal(9);
    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("combobox", { name: "Successor" }));
    await user.click(await screen.findByRole("option", { name: "c1 · Payments" }));
    await user.click(within(screen.getByRole("radiogroup", { name: "Predecessor is a" })).getByRole("radio", { name: "Project" }));
    await pickPredecessor(user, dialog, "Alpha · Billing · Platform");
    await user.click(within(dialog).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    expect(posts()[0].body).toEqual({ predecessor: { kind: "PROJECT", id: 2 }, successor: { kind: "MILESTONE", id: 6 }, type: "FS", lagDays: 0 });
  });

  test("changing the project empties the successor and searches the new project's milestones", async () => {
    const user = userEvent.setup();
    renderModal(7);
    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("combobox", { name: "Successor" }));
    await user.click(await screen.findByRole("option", { name: "b2 · Invoices" }));
    expect(within(dialog).getByRole("combobox", { name: "Successor" })).toHaveValue("b2 · Invoices");
    await pickProject(user, dialog, "Payments");
    expect(within(dialog).getByRole("combobox", { name: "Successor" })).toHaveValue("");
    await user.click(within(dialog).getByRole("combobox", { name: "Successor" }));
    expect((await screen.findAllByRole("option")).map((option) => option.textContent)).toEqual(["c1 · Payments"]);
    expect(milestoneReads().some((url) => new URL(url, "http://test").searchParams.get("projectId") === "9")).toBe(true);
  });

  test("nothing picked: the project, then the successor milestone and the predecessor are asked for, each on its own field, and nothing is sent", async () => {
    const user = userEvent.setup();
    renderModal();
    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: "Save" }));
    const project = within(dialog).getByRole("combobox", { name: "Successor's project" });
    await waitFor(() => expect(project).toHaveAccessibleDescription(expect.stringContaining("Pick the successor's project")));
    expect(project).toBeInvalid();
    expect(within(dialog).getByRole("combobox", { name: "Predecessor" })).toHaveAccessibleDescription(expect.stringContaining("Pick the predecessor"));
    // The successor milestone has no picker yet, so its message waits for the project.
    expect(within(dialog).queryByText("Pick the successor milestone")).toBeNull();

    await pickProject(user, dialog, "Invoices");
    expect(project).not.toBeInvalid();
    await user.click(within(dialog).getByRole("button", { name: "Save" }));
    const successor = within(dialog).getByRole("combobox", { name: "Successor" });
    await waitFor(() => expect(successor).toHaveAccessibleDescription(expect.stringContaining("Pick the successor milestone")));
    expect(successor).toBeInvalid();
    expect(posts()).toEqual([]);

    // Picking it clears its message; a whole project needs no milestone.
    await user.click(successor);
    await user.click(await screen.findByRole("option", { name: "b1 · Invoices" }));
    expect(successor).not.toBeInvalid();
  });

  test("an end cannot be linked to itself: the milestone chosen on both sides, the project on both sides", async () => {
    const user = userEvent.setup();
    renderModal(7);
    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("combobox", { name: "Successor" }));
    await user.click(await screen.findByRole("option", { name: "b1 · Invoices" }));
    await pickPredecessor(user, dialog, "b1 · Invoices");
    await user.click(within(dialog).getByRole("button", { name: "Save" }));
    expect(await within(dialog).findByText("An end cannot depend on itself")).toBeInTheDocument();
    expect(posts()).toEqual([]);

    // Another successor makes the same predecessor fine again, and clears the stale message.
    await user.click(within(dialog).getByRole("combobox", { name: "Successor" }));
    await user.click(await screen.findByRole("option", { name: "b2 · Invoices" }));
    expect(within(dialog).queryByText("An end cannot depend on itself")).toBeNull();

    // The project on both sides.
    await user.click(within(screen.getByRole("radiogroup", { name: "Successor is a" })).getByRole("radio", { name: "Project" }));
    await user.click(within(screen.getByRole("radiogroup", { name: "Predecessor is a" })).getByRole("radio", { name: "Project" }));
    await pickPredecessor(user, dialog, "Invoices · Billing · Platform");
    await user.click(within(dialog).getByRole("button", { name: "Save" }));
    expect(await within(dialog).findByText("An end cannot depend on itself")).toBeInTheDocument();
    expect(posts()).toEqual([]);
  });

  test("the lag must be a whole number of working days in range", async () => {
    const user = userEvent.setup();
    renderModal(9);
    const dialog = await screen.findByRole("dialog");
    await user.click(within(screen.getByRole("radiogroup", { name: "Successor is a" })).getByRole("radio", { name: "Project" }));
    await pickPredecessor(user, dialog, "a1 · Alpha");
    await user.clear(within(dialog).getByRole("textbox", { name: /Lag/ }));
    await user.click(within(dialog).getByRole("button", { name: "Save" }));
    expect(await within(dialog).findByText("Enter a whole number of working days from -365 to 365")).toBeInTheDocument();
    expect(posts()).toEqual([]);
  });

  test("while the save is in flight the dialog cannot be closed (X, Escape, outside click) and Cancel is disabled", async () => {
    const gate = deferred<Response>();
    post = () => gate.promise;
    const user = userEvent.setup();
    const { onSaved, onClose } = renderModal(9);
    const dialog = await screen.findByRole("dialog");
    await user.click(within(screen.getByRole("radiogroup", { name: "Successor is a" })).getByRole("radio", { name: "Project" }));
    await pickPredecessor(user, dialog, "a1 · Alpha");
    expect(within(dialog).getByRole("button", { name: "Close" })).toBeInTheDocument();
    await user.click(within(dialog).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(within(dialog).queryByRole("button", { name: "Close" })).toBeNull());
    await user.keyboard("{Escape}");
    await user.click(document.querySelector(".mantine-Modal-overlay") as HTMLElement);
    expect(within(dialog).getByRole("button", { name: "Cancel" })).toBeDisabled();
    expect(onClose).not.toHaveBeenCalled();
    gate.resolve(jsonResponse(201, { id: 90 }));
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
  });

  test("Cancel closes the dialog without a write", async () => {
    const user = userEvent.setup();
    const { onClose } = renderModal();
    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(onClose).toHaveBeenCalled();
    expect(posts()).toEqual([]);
  });

  test("a cycle 409 is told apart and drawn with its path in the UI language; the dialog stays open and retryable", async () => {
    post = () => jsonResponse(409, CYCLE);
    const user = userEvent.setup();
    const { onSaved } = renderModal(7);
    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("combobox", { name: "Successor" }));
    await user.click(await screen.findByRole("option", { name: "b1 · Invoices" }));
    await pickPredecessor(user, dialog, "a1 · Alpha");
    await user.click(within(dialog).getByRole("button", { name: "Save" }));
    const alert = await within(dialog).findByRole("alert");
    expect(alert).toHaveTextContent("This link would close a cycle through:");
    expect(alert).toHaveTextContent("b1 → a1 → b1");
    expect(alert).not.toHaveTextContent("server words");
    expect(onSaved).not.toHaveBeenCalled();
    expect(within(dialog).getByRole("button", { name: "Save" })).toBeEnabled();
  });

  test("a duplicate pair, a forbidden caller, a vanished end and a refused body read as fixed sentences in the dialog", async () => {
    const user = userEvent.setup();
    const { onSaved } = renderModal(9);
    const dialog = await screen.findByRole("dialog");
    await user.click(within(screen.getByRole("radiogroup", { name: "Successor is a" })).getByRole("radio", { name: "Project" }));
    await pickPredecessor(user, dialog, "a1 · Alpha");
    const save = within(dialog).getByRole("button", { name: "Save" });
    post = () => jsonResponse(409, { title: "Conflict", status: 409, detail: "These two endpoints are already linked" });
    await user.click(save);
    expect(await within(dialog).findByRole("alert")).toHaveTextContent("These two ends are already linked.");
    post = () => jsonResponse(403, { title: "Forbidden", status: 403 });
    await user.click(save);
    await waitFor(() => expect(within(dialog).getByRole("alert")).toHaveTextContent("Only the owners of the successor's project"));
    post = () => jsonResponse(404, { title: "Not found", status: 404 });
    await user.click(save);
    await waitFor(() => expect(within(dialog).getByRole("alert")).toHaveTextContent("This no longer exists"));
    post = () => jsonResponse(400, { title: "Bad", status: 400, detail: "Unknown or deleted milestone ids: 11" });
    await user.click(save);
    await waitFor(() => expect(within(dialog).getByRole("alert")).toHaveTextContent("either may have been deleted meanwhile"));
    expect(onSaved).not.toHaveBeenCalled();
    expect(dialog).toBeInTheDocument();
  });

  test("speaks Polish", async () => {
    await i18n.changeLanguage("pl");
    const user = userEvent.setup();
    renderModal(7);
    const dialog = await screen.findByRole("dialog", { name: "Dodaj zależność" });
    expect(within(dialog).getByRole("combobox", { name: "Projekt następnika" })).toHaveValue("Invoices");
    expect(within(dialog).getByText("Projekt, który czeka. Na liście są tylko projekty, którymi możesz zarządzać.")).toBeInTheDocument();
    expect(within(screen.getByRole("radiogroup", { name: "Następnik to" })).getByRole("radio", { name: "Kamień milowy" })).toBeChecked();
    await user.click(within(dialog).getByRole("button", { name: "Zapisz" }));
    expect(await within(dialog).findByText("Wybierz kamień milowy następnika")).toBeInTheDocument();
    await user.click(within(dialog).getByRole("combobox", { name: "Następnik" }));
    await user.click(await screen.findByRole("option", { name: "b1 · Invoices" }));
    expect(await within(dialog).findByLabelText("Wyczyść kamień milowy następnika")).toBeInTheDocument();
  });
});
