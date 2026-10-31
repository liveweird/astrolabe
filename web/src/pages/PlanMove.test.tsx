import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import userEvent from "@testing-library/user-event";
import { act, screen, waitFor, within } from "@testing-library/react";
import { QueryClient } from "@tanstack/react-query";
import Plan from "./Plan";
import type { PlanProgram, PlanProject, PlanView, PlanWorkStream } from "../api/plan";
import { jsonResponse } from "../test/http";
import { renderWithProviders } from "../test/render";
import { showSuccessToast } from "../utils/toast";

vi.mock("../utils/toast", () => ({ showSuccessToast: vi.fn() }));

type FetchMock = ReturnType<typeof vi.fn>;

const project = (id: number, name: string, programId: number, over: Partial<PlanProject["can"]> = {}): PlanProject => ({
  id,
  name,
  programId,
  workStreamId: 1,
  description: null,
  ownerPersonId: 5,
  ownerName: "Piotr Project",
  targetStart: null,
  targetEnd: null,
  createdAt: 1,
  updatedAt: 2,
  can: { edit: true, delete: true, editTargetWindow: true, move: true, ...over },
});

const program = (id: number, name: string, workStreamId: number, projects: PlanProject[] = [], over: Partial<PlanProgram["can"]> = {}): PlanProgram => ({
  id,
  name,
  workStreamId,
  description: null,
  ownerPersonId: 6,
  ownerName: "Pola Program",
  createdAt: 1,
  updatedAt: 2,
  can: { edit: true, delete: true, createProject: true, move: true, ...over },
  projects,
});

const stream = (id: number, name: string, programs: PlanProgram[], over: Partial<PlanWorkStream> = {}): PlanWorkStream => ({
  id,
  name,
  description: null,
  ownerPersonId: 4,
  ownerName: "Ola Owner",
  startDate: "2026-01-05",
  endDate: null,
  createdAt: 1,
  updatedAt: 2,
  can: { edit: true, delete: true, createProgram: true },
  programs,
  ...over,
});

const baseView = (): PlanView => ({
  revision: 5,
  can: { createWorkStream: true },
  workStreams: [
    stream(1, "Platform", [
      program(10, "Billing", 1, [project(100, "Invoices", 10), project(101, "Taxes", 10, { edit: false, delete: false, editTargetWindow: false }), project(102, "Audit", 10, { move: false })]),
      program(11, "Identity", 1),
      program(12, "Sealed", 1, [], { createProject: false }),
      program(13, "Ślęża", 1),
    ]),
    stream(2, "Legacy", [program(20, "Archive", 2)], { endDate: "2025-12-31", startDate: "2024-01-01" }),
    stream(3, "Locked", [], { can: { edit: true, delete: true, createProgram: false } }),
  ],
});

let view: PlanView;
let mockFetch: FetchMock;
let moveAnswer: { status: number; body?: unknown };
/** While set, every `GET /views/plan` waits for it (a reload that takes a while). */
let holdPlan: Promise<void> | null;

function serve() {
  mockFetch.mockImplementation((url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    if (method === "GET" && url === "/api/v1/views/plan") return (holdPlan ?? Promise.resolve()).then(() => jsonResponse(200, view));
    if (method === "POST" && /\/(projects|programs)\/\d+\/move$/.test(url)) {
      return Promise.resolve(moveAnswer.body === undefined ? new Response(null, { status: moveAnswer.status }) : jsonResponse(moveAnswer.status, moveAnswer.body));
    }
    return Promise.resolve(jsonResponse(404, { title: "x", status: 404 }));
  });
}

const moves = () =>
  mockFetch.mock.calls
    .filter(([url, init]) => (init as RequestInit | undefined)?.method === "POST" && /\/move$/.test(url as string))
    .map(([url, init]) => ({ url: url as string, body: JSON.parse((init as RequestInit).body as string) }));
const planGets = () => mockFetch.mock.calls.filter(([url, init]) => url === "/api/v1/views/plan" && !(init as RequestInit | undefined)?.method).length;

async function openMove(user: ReturnType<typeof userEvent.setup>, name: string, aria: string) {
  await user.click(await screen.findByRole("button", { name: `Operations for ${name}` }));
  await user.click(await screen.findByRole("menuitem", { name: aria }));
  return screen.findByRole("dialog");
}

async function pick(user: ReturnType<typeof userEvent.setup>, dialog: HTMLElement, label: string, search: string, option: string) {
  const select = within(dialog).getByRole("combobox", { name: label });
  await user.click(select);
  await user.type(select, search);
  await user.click(await screen.findByRole("option", { name: option }));
}

beforeEach(() => {
  view = baseView();
  moveAnswer = { status: 204 };
  holdPlan = null;
  mockFetch = vi.fn();
  vi.stubGlobal("fetch", mockFetch);
  vi.mocked(showSuccessToast).mockClear();
  localStorage.setItem("astrolabe.auth.token", "fake-token");
  serve();
});

afterEach(() => {
  vi.unstubAllGlobals();
  localStorage.clear();
});

describe("Plan page: Move to…", () => {
  test("a node's Move to… follows its own can.move flag, even when it is the only action", async () => {
    const user = userEvent.setup();
    renderWithProviders(<Plan />);
    await screen.findByRole("heading", { level: 3, name: "Platform" });
    // Taxes: move only (no edit, no delete) - the kebab exists for it alone; Audit: edit and delete but no move
    await user.click(screen.getByRole("button", { name: "Operations for Taxes" }));
    expect(await screen.findByRole("menuitem", { name: "Move Taxes to another program" })).toHaveTextContent("Move to…");
    expect(screen.queryByRole("menuitem", { name: /^Edit/ })).toBeNull();
    expect(screen.queryByRole("menuitem", { name: /^Delete/ })).toBeNull();
    await user.keyboard("{Escape}");
    await user.click(screen.getByRole("button", { name: "Operations for Audit" }));
    expect(await screen.findByRole("menuitem", { name: "Edit Audit" })).toBeInTheDocument();
    expect(screen.queryByRole("menuitem", { name: /^Move/ })).toBeNull();
    await user.keyboard("{Escape}");
  });

  test("a program without the move flag has no Move to…, and no kebab when nothing else is allowed", async () => {
    view.workStreams[0].programs[1].can = { edit: true, delete: false, createProject: true, move: false };
    view.workStreams[1].programs[0].can = { edit: false, delete: false, createProject: false, move: false };
    const user = userEvent.setup();
    renderWithProviders(<Plan />);
    await screen.findByRole("heading", { level: 3, name: "Platform" });
    await user.click(screen.getByRole("button", { name: "Operations for Identity" }));
    expect(await screen.findByRole("menuitem", { name: "Edit Identity" })).toBeInTheDocument();
    expect(screen.queryByRole("menuitem", { name: /^Move/ })).toBeNull();
    expect(screen.queryByRole("button", { name: "Operations for Archive" })).toBeNull();
  });

  test("a project moves to another program: targets grouped by stream (own program and no-create programs left out), closed streams labelled", async () => {
    const user = userEvent.setup();
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    queryClient.setQueryData(["roadmap", "view"], { revision: 1, can: { editRank: false }, ranked: [], unranked: [] });
    renderWithProviders(<Plan />, { queryClient });
    const dialog = await openMove(user, "Invoices", "Move Invoices to another program");
    expect(within(dialog).getByRole("heading", { name: "Move project" })).toBeInTheDocument();
    expect(dialog).toHaveTextContent("Project Invoices is currently in program Billing.");
    await user.click(within(dialog).getByRole("combobox", { name: "New program" }));
    expect(await screen.findByRole("option", { name: "Identity" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "Archive" })).toBeInTheDocument();
    expect(screen.queryByRole("option", { name: "Billing" })).toBeNull();
    expect(screen.queryByRole("option", { name: "Sealed" })).toBeNull();
    expect(screen.getByText("Legacy (closed)")).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "Ślęża" })).toBeInTheDocument();
    // searchable, case-insensitive
    await user.type(within(dialog).getByRole("combobox", { name: "New program" }), "ARCH");
    expect(screen.queryByRole("option", { name: "Identity" })).toBeNull();
    await user.click(screen.getByRole("option", { name: "Archive" }));
    const before = planGets();
    await user.click(within(dialog).getByRole("button", { name: "Move" }));
    await waitFor(() => expect(moves()).toEqual([{ url: "/api/v1/projects/100/move", body: { programId: 20 } }]));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(showSuccessToast).toHaveBeenCalledWith("Project moved");
    // the plan reloads, and so does everything else under ["roadmap"]
    await waitFor(() => expect(planGets()).toBeGreaterThan(before));
    expect(queryClient.getQueryState(["roadmap", "view"])?.isInvalidated).toBe(true);
  });

  test("a program moves to another work stream: closed streams stay valid targets, streams you cannot create in are not offered", async () => {
    const user = userEvent.setup();
    renderWithProviders(<Plan />);
    const dialog = await openMove(user, "Billing", "Move Billing to another work stream");
    expect(dialog).toHaveTextContent("Program Billing is currently in work stream Platform.");
    await user.click(within(dialog).getByRole("combobox", { name: "New work stream" }));
    expect(await screen.findByRole("option", { name: "Legacy (closed)" })).toBeInTheDocument();
    expect(screen.queryByRole("option", { name: "Platform" })).toBeNull();
    expect(screen.queryByRole("option", { name: "Locked" })).toBeNull();
    await user.click(screen.getByRole("option", { name: "Legacy (closed)" }));
    await user.click(within(dialog).getByRole("button", { name: "Move" }));
    await waitFor(() => expect(moves()).toEqual([{ url: "/api/v1/programs/10/move", body: { workStreamId: 2 } }]));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(showSuccessToast).toHaveBeenCalledWith("Program moved");
  });

  test("Move needs a target: nothing is sent without one", async () => {
    const user = userEvent.setup();
    renderWithProviders(<Plan />);
    const dialog = await openMove(user, "Invoices", "Move Invoices to another program");
    await user.click(within(dialog).getByRole("button", { name: "Move" }));
    expect(await within(dialog).findByText("Pick where to move it")).toBeInTheDocument();
    expect(moves()).toHaveLength(0);
  });

  test("Move to… is hidden where no target is eligible: no menu item, and no kebab when it would be the only action", async () => {
    // every program refuses new projects, and Locked/Legacy are the only other streams: Invoices has no program to go to
    for (const ws of view.workStreams) for (const pr of ws.programs) pr.can.createProject = false;
    const user = userEvent.setup();
    renderWithProviders(<Plan />);
    await screen.findByRole("heading", { level: 3, name: "Platform" });
    // Taxes (move only) loses its kebab; Invoices keeps Edit and Delete but no Move, and no divider is left dangling
    expect(screen.queryByRole("button", { name: "Operations for Taxes" })).toBeNull();
    await user.click(screen.getByRole("button", { name: "Operations for Invoices" }));
    expect(await screen.findByRole("menuitem", { name: "Edit Invoices" })).toBeInTheDocument();
    expect(screen.queryByRole("menuitem", { name: /^Move/ })).toBeNull();
    const menu = screen.getByRole("menuitem", { name: "Delete Invoices" }).parentElement as HTMLElement;
    expect(menu.querySelectorAll(".mantine-Menu-divider")).toHaveLength(1); // Edit | Delete
    await user.keyboard("{Escape}");
  });

  test("a delete-only row has no divider, and a move-and-delete row has one", async () => {
    view.workStreams[0].programs[0].projects = [
      project(100, "OnlyDelete", 10, { edit: false, editTargetWindow: false, move: false }),
      project(101, "MoveAndDelete", 10, { edit: false, editTargetWindow: false }),
    ];
    const user = userEvent.setup();
    renderWithProviders(<Plan />);
    await user.click(await screen.findByRole("button", { name: "Operations for OnlyDelete" }));
    const only = (await screen.findByRole("menuitem", { name: "Delete OnlyDelete" })).parentElement as HTMLElement;
    expect(only.querySelectorAll(".mantine-Menu-divider")).toHaveLength(0);
    await user.keyboard("{Escape}");
    await user.click(screen.getByRole("button", { name: "Operations for MoveAndDelete" }));
    const both = (await screen.findByRole("menuitem", { name: "Delete MoveAndDelete" })).parentElement as HTMLElement;
    expect(both.querySelectorAll(".mantine-Menu-divider")).toHaveLength(1);
  });

  test("a program with no other work stream to go to has no Move to…", async () => {
    for (const ws of view.workStreams) ws.can.createProgram = ws.id === 1; // only its own stream still takes programs
    const user = userEvent.setup();
    renderWithProviders(<Plan />);
    await user.click(await screen.findByRole("button", { name: "Operations for Billing" }));
    expect(await screen.findByRole("menuitem", { name: "Edit Billing" })).toBeInTheDocument();
    expect(screen.queryByRole("menuitem", { name: /^Move/ })).toBeNull();
  });

  test("when the last target disappears under the open dialog it says why and Move is disabled", async () => {
    const user = userEvent.setup();
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    renderWithProviders(<Plan />, { queryClient });
    const dialog = await openMove(user, "Invoices", "Move Invoices to another program");
    const next = baseView();
    for (const ws of next.workStreams) for (const pr of ws.programs) pr.can.createProject = false;
    act(() => queryClient.setQueryData(["plan", "view"], next));
    expect(await within(dialog).findByText(/There is no other program to move this project to/)).toBeInTheDocument();
    expect(within(dialog).queryByRole("combobox", { name: "New program" })).toBeNull();
    expect(within(dialog).getByRole("button", { name: "Move" })).toBeDisabled();
  });

  test("409 (the name is taken in the target): the dialog stays open, says so, and another target can be tried", async () => {
    moveAnswer = { status: 409, body: { title: "Conflict", status: 409 } };
    const user = userEvent.setup();
    renderWithProviders(<Plan />);
    const dialog = await openMove(user, "Invoices", "Move Invoices to another program");
    await pick(user, dialog, "New program", "Ident", "Identity");
    await user.click(within(dialog).getByRole("button", { name: "Move" }));
    expect(await within(dialog).findByText("A project with this name already exists in that program — pick another program.")).toBeInTheDocument();
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(showSuccessToast).not.toHaveBeenCalled();
    moveAnswer = { status: 204 };
    await user.clear(within(dialog).getByRole("combobox", { name: "New program" }));
    await pick(user, dialog, "New program", "Arch", "Archive");
    // picking again clears the old message
    expect(within(dialog).queryByText(/already exists in that program/)).toBeNull();
    await user.click(within(dialog).getByRole("button", { name: "Move" }));
    await waitFor(() => expect(moves().map((m) => m.body)).toEqual([{ programId: 11 }, { programId: 20 }]));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  test("400 (the target is gone): the message shows, the plan reloads, and the vanished target is dropped from the options and the pick", async () => {
    moveAnswer = { status: 400, body: { title: "Bad request", status: 400 } };
    const user = userEvent.setup();
    renderWithProviders(<Plan />);
    const dialog = await openMove(user, "Invoices", "Move Invoices to another program");
    await pick(user, dialog, "New program", "Ident", "Identity");
    const before = planGets();
    // the target is deleted meanwhile: the reload no longer has it
    view = baseView();
    view.workStreams[0].programs.splice(1, 1);
    await user.click(within(dialog).getByRole("button", { name: "Move" }));
    expect(await within(dialog).findByText("That target no longer exists. The plan was reloaded — pick another.")).toBeInTheDocument();
    await waitFor(() => expect(planGets()).toBeGreaterThan(before));
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    const select = within(dialog).getByRole("combobox", { name: "New program" });
    await waitFor(() => expect(select).toHaveValue(""));
    await user.click(select);
    expect(screen.queryByRole("option", { name: "Identity" })).toBeNull();
    expect(await screen.findByRole("option", { name: "Archive" })).toBeInTheDocument();
    expect(showSuccessToast).not.toHaveBeenCalled();
  });

  test("403 (the rights changed): the message shows and the plan reloads, the dialog stays", async () => {
    moveAnswer = { status: 403, body: { title: "Forbidden", status: 403 } };
    const user = userEvent.setup();
    renderWithProviders(<Plan />);
    const dialog = await openMove(user, "Billing", "Move Billing to another work stream");
    await pick(user, dialog, "New work stream", "Leg", "Legacy (closed)");
    const before = planGets();
    await user.click(within(dialog).getByRole("button", { name: "Move" }));
    expect(await within(dialog).findByText("You are not allowed to move this there any more. The plan was reloaded.")).toBeInTheDocument();
    await waitFor(() => expect(planGets()).toBeGreaterThan(before));
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(showSuccessToast).not.toHaveBeenCalled();
  });

  test("404 (the node itself is gone): the dialog closes and the plan reloads", async () => {
    moveAnswer = { status: 404, body: { title: "Not found", status: 404 } };
    const user = userEvent.setup();
    renderWithProviders(<Plan />);
    const dialog = await openMove(user, "Invoices", "Move Invoices to another program");
    await pick(user, dialog, "New program", "Ident", "Identity");
    const before = planGets();
    await user.click(within(dialog).getByRole("button", { name: "Move" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await waitFor(() => expect(planGets()).toBeGreaterThan(before));
    expect(showSuccessToast).not.toHaveBeenCalled();
  });

  test("any other failure is an inline alert in words, never a toast, and the dialog stays", async () => {
    moveAnswer = { status: 500, body: { title: "Boom", status: 500 } };
    const user = userEvent.setup();
    renderWithProviders(<Plan />);
    const dialog = await openMove(user, "Invoices", "Move Invoices to another program");
    await pick(user, dialog, "New program", "Ident", "Identity");
    await user.click(within(dialog).getByRole("button", { name: "Move" }));
    expect(await within(dialog).findByRole("alert")).toHaveTextContent("The move failed (500)");
    expect(showSuccessToast).not.toHaveBeenCalled();
  });

  test("the whole flow works from the keyboard: kebab, menu item, dialog focus, select, submit with Enter", async () => {
    const user = userEvent.setup();
    renderWithProviders(<Plan />);
    const kebab = await screen.findByRole("button", { name: "Operations for Invoices" });
    act(() => kebab.focus());
    await user.keyboard("{Enter}");
    const item = await screen.findByRole("menuitem", { name: "Move Invoices to another program" });
    for (let i = 0; i < 4 && document.activeElement !== item; i += 1) await user.keyboard("{ArrowDown}");
    expect(item).toHaveFocus();
    await user.keyboard("{Enter}");
    const dialog = await screen.findByRole("dialog", { name: "Move project" });
    await waitFor(() => expect(dialog.contains(document.activeElement)).toBe(true));
    const select = within(dialog).getByRole("combobox", { name: "New program" });
    await user.type(select, "Ident");
    await user.keyboard("{ArrowDown}{Enter}");
    await user.keyboard("{Enter}");
    await waitFor(() => expect(moves()).toEqual([{ url: "/api/v1/projects/100/move", body: { programId: 11 } }]));
  });

  test("the target search ignores case and accents: \"sleza\" finds \"Ślęża\"", async () => {
    const user = userEvent.setup();
    renderWithProviders(<Plan />);
    const dialog = await openMove(user, "Invoices", "Move Invoices to another program");
    const select = within(dialog).getByRole("combobox", { name: "New program" });
    await user.click(select);
    await user.type(select, "SLEZA");
    expect(await screen.findByRole("option", { name: "Ślęża" })).toBeInTheDocument();
    expect(screen.queryByRole("option", { name: "Identity" })).toBeNull();
    await user.click(screen.getByRole("option", { name: "Ślęża" }));
    await user.click(within(dialog).getByRole("button", { name: "Move" }));
    await waitFor(() => expect(moves()).toEqual([{ url: "/api/v1/projects/100/move", body: { programId: 13 } }]));
  });

  test("Escape with the option list open closes only the list; a second Escape closes the dialog", async () => {
    const user = userEvent.setup();
    renderWithProviders(<Plan />);
    const dialog = await openMove(user, "Invoices", "Move Invoices to another program");
    await user.click(within(dialog).getByRole("combobox", { name: "New program" }));
    expect(await screen.findByRole("option", { name: "Identity" })).toBeInTheDocument();
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("option", { name: "Identity" })).toBeNull());
    expect(screen.getByRole("dialog", { name: "Move project" })).toBeInTheDocument();
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  test("a program's move that the server answers 409 is not a name clash: it gets the generic move message", async () => {
    moveAnswer = { status: 409, body: { title: "Conflict", status: 409 } };
    const user = userEvent.setup();
    renderWithProviders(<Plan />);
    const dialog = await openMove(user, "Billing", "Move Billing to another work stream");
    await pick(user, dialog, "New work stream", "Leg", "Legacy (closed)");
    await user.click(within(dialog).getByRole("button", { name: "Move" }));
    expect(await within(dialog).findByRole("alert")).toHaveTextContent("The move failed (409)");
    expect(screen.queryByText(/already exists in that program/)).toBeNull();
  });

  test("the dialog follows the live plan: a project moved elsewhere meanwhile is offered its OLD program and not its new one", async () => {
    const user = userEvent.setup();
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    renderWithProviders(<Plan />, { queryClient });
    const dialog = await openMove(user, "Invoices", "Move Invoices to another program");
    expect(dialog).toHaveTextContent("Project Invoices is currently in program Billing.");
    // somebody else moves it to Identity; the reload brings that view in
    const next = baseView();
    const invoices = next.workStreams[0].programs[0].projects.shift() as PlanProject;
    next.workStreams[0].programs[1].projects.push({ ...invoices, programId: 11 });
    act(() => queryClient.setQueryData(["plan", "view"], next));
    await waitFor(() => expect(dialog).toHaveTextContent("Project Invoices is currently in program Identity."));
    await user.click(within(dialog).getByRole("combobox", { name: "New program" }));
    expect(await screen.findByRole("option", { name: "Billing" })).toBeInTheDocument();
    expect(screen.queryByRole("option", { name: "Identity" })).toBeNull();
  });

  test("a node that disappears from the plan under the open dialog closes it, as on a 404", async () => {
    const user = userEvent.setup();
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    renderWithProviders(<Plan />, { queryClient });
    await openMove(user, "Invoices", "Move Invoices to another program");
    const next = baseView();
    next.workStreams[0].programs[0].projects.shift();
    act(() => queryClient.setQueryData(["plan", "view"], next));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(showSuccessToast).not.toHaveBeenCalled();
  });

  test("after a 403 that took the right away the dialog says so once, Move stays disabled, and nothing is retried", async () => {
    moveAnswer = { status: 403, body: { title: "Forbidden", status: 403 } };
    const user = userEvent.setup();
    renderWithProviders(<Plan />);
    const dialog = await openMove(user, "Invoices", "Move Invoices to another program");
    await pick(user, dialog, "New program", "Ident", "Identity");
    view = baseView();
    view.workStreams[0].programs[0].projects[0].can.move = false;
    await user.click(within(dialog).getByRole("button", { name: "Move" }));
    const message = "You are not allowed to move this there any more. The plan was reloaded.";
    expect(await within(dialog).findByText(message)).toBeInTheDocument();
    await waitFor(() => expect(within(dialog).getByRole("button", { name: "Move" })).toBeDisabled());
    await user.click(within(dialog).getByRole("button", { name: "Move" }));
    expect(within(dialog).getAllByText(message)).toHaveLength(1);
    expect(moves()).toHaveLength(1);
  });

  test("a node that has lost can.move before any submit shows the forbidden message with Move disabled", async () => {
    const user = userEvent.setup();
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    renderWithProviders(<Plan />, { queryClient });
    const dialog = await openMove(user, "Billing", "Move Billing to another work stream");
    const next = baseView();
    next.workStreams[0].programs[0].can.move = false;
    act(() => queryClient.setQueryData(["plan", "view"], next));
    expect(await within(dialog).findByText(/You are not allowed to move this there any more/)).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "Move" })).toBeDisabled();
    expect(moves()).toHaveLength(0);
  });

  test.each([
    [400, { title: "Bad request", status: 400 }],
    [403, { title: "Forbidden", status: 403 }],
  ])("after a %i Move stays disabled while the plan reloads, and comes back when the reload is in", async (status, body) => {
    moveAnswer = { status, body };
    const user = userEvent.setup();
    renderWithProviders(<Plan />);
    const dialog = await openMove(user, "Invoices", "Move Invoices to another program");
    await pick(user, dialog, "New program", "Ident", "Identity");
    let release: () => void = () => undefined;
    holdPlan = new Promise<void>((resolve) => {
      release = resolve;
    });
    await user.click(within(dialog).getByRole("button", { name: "Move" }));
    // the answer is in (the message shows) but the reload is still out: the old plan must not be movable again
    expect(await within(dialog).findByRole("alert")).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "Move" })).toBeDisabled();
    await user.click(within(dialog).getByRole("button", { name: "Move" }));
    expect(moves()).toHaveLength(1);
    release();
    await waitFor(() => expect(within(dialog).getByRole("button", { name: "Move" })).toBeEnabled());
  });
});
