import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import userEvent from "@testing-library/user-event";
import { screen, waitFor, within } from "@testing-library/react";
import Plan from "./Plan";
import type { PlanView } from "../api/plan";
import { routeFetch } from "../test/http";
import { linksView } from "../test/jiraLinks";
import { findPlanTree, planOf, planStatus } from "../test/planView";
import { renderWithProviders } from "../test/render";

const COLLAPSED_KEY = "astrolabe.viewSettings.plan.collapsed";

const PLAN = planOf([
  {
    id: 1,
    name: "Platform",
    programs: [
      { id: 10, name: "Billing", projects: [{ id: 100, name: "Invoices" }, { id: 101, name: "Taxes" }] },
      { id: 11, name: "Identity", projects: [{ id: 102, name: "Login" }] },
    ],
  },
  { id: 2, name: "Legacy", endDate: "2025-12-31", programs: [{ id: 12, name: "Archive" }] },
]);

/** The visible rows' keys, in table order. */
const keys = () =>
  within(screen.getByRole("table", { name: "Work streams, programs and projects" }))
    .getAllByRole("row")
    .slice(1)
    .map((row) => row.getAttribute("data-key"));
const stored = () => JSON.parse(localStorage.getItem(COLLAPSED_KEY) ?? "null") as unknown;
const status = planStatus;

const PEOPLE = { items: [{ id: 4, name: "Ola Owner", email: "ola@example.com", userId: null, userEmail: null, createdAt: 1, updatedAt: 2 }], page: 1, pageSize: 50, total: 1 };

function show(view: PlanView = PLAN, extra: Parameters<typeof routeFetch>[0] = {}) {
  const fetchMock = routeFetch({
    "GET /api/v1/views/plan": view,
    "GET /api/v1/views/jira-links": linksView(),
    ...extra,
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("Plan page: folds", () => {
  beforeEach(() => {
    localStorage.setItem("astrolabe.auth.token", "fake-token");
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    localStorage.clear();
  });

  test("a first visit shows everything expanded, and stores nothing until the user folds", async () => {
    show();
    renderWithProviders(<Plan />);
    await findPlanTree();
    expect(keys()).toEqual(["ws:1", "pg:10", "pj:100", "pj:101", "pg:11", "pj:102", "ws:2", "pg:12"]);
    for (const name of ["Work stream Platform", "Program Billing", "Program Identity", "Work stream Legacy"]) {
      expect(screen.getByRole("button", { name })).toHaveAttribute("aria-expanded", "true");
    }
    expect(stored()).toBeNull();
  });

  test("a childless program has no disclosure button: its name is a link that says its kind", async () => {
    show();
    renderWithProviders(<Plan />);
    await findPlanTree();
    expect(screen.queryByRole("button", { name: "Program Archive" })).not.toBeInTheDocument();
    expect(within(screen.getByRole("rowheader", { name: /Archive/ })).getByRole("link", { name: "Open program Archive" })).toHaveTextContent(/^Archive$/);
  });

  test("a click folds a work stream, hides what is under it, keeps the focus on the button, says so and remembers it", async () => {
    show();
    const user = userEvent.setup();
    renderWithProviders(<Plan />);
    await findPlanTree();
    const button = screen.getByRole("button", { name: "Work stream Platform" });
    await user.click(button);
    expect(keys()).toEqual(["ws:1", "ws:2", "pg:12"]);
    expect(button).toHaveAttribute("aria-expanded", "false");
    expect(button).toHaveFocus();
    expect(status()).toHaveTextContent("Platform collapsed");
    expect(stored()).toEqual(["ws:1"]);
    // The count stays the document's own while the children are out of sight.
    expect(within(button.closest("tr")!).getByText("2 programs")).toBeInTheDocument();

    await user.click(button);
    expect(keys()).toHaveLength(8);
    expect(button).toHaveFocus();
    expect(status()).toHaveTextContent("Platform expanded, 2 programs");
    expect(stored()).toEqual([]);
  });

  test("a program folds on its own, and the keyboard (Enter, Space) does what the click does", async () => {
    show();
    const user = userEvent.setup();
    renderWithProviders(<Plan />);
    await findPlanTree();
    const billing = screen.getByRole("button", { name: "Program Billing" });
    billing.focus();
    await user.keyboard("{Enter}");
    expect(keys()).toEqual(["ws:1", "pg:10", "pg:11", "pj:102", "ws:2", "pg:12"]);
    expect(status()).toHaveTextContent("Billing collapsed");
    await user.keyboard(" ");
    expect(keys()).toContain("pj:100");
    expect(billing).toHaveFocus();
    expect(status()).toHaveTextContent("Billing expanded, 2 projects");
  });

  test("Collapse all folds every node that has children, Expand all opens them again, each said once and remembered", async () => {
    show();
    const user = userEvent.setup();
    renderWithProviders(<Plan />);
    await findPlanTree();
    await user.click(screen.getByRole("button", { name: "Collapse all" }));
    expect(keys()).toEqual(["ws:1", "ws:2"]);
    expect(status()).toHaveTextContent("Every work stream and program collapsed");
    expect([...(stored() as string[])].sort()).toEqual(["pg:10", "pg:11", "ws:1", "ws:2"]);

    await user.click(screen.getByRole("button", { name: "Expand all" }));
    expect(keys()).toHaveLength(8);
    expect(status()).toHaveTextContent("Every work stream and program expanded");
    expect(stored()).toEqual([]);
  });

  test("folds survive a reload: the stored keys are read at mount", async () => {
    show();
    const user = userEvent.setup();
    const first = renderWithProviders(<Plan />);
    await findPlanTree();
    await user.click(screen.getByRole("button", { name: "Program Billing" }));
    first.unmount();

    renderWithProviders(<Plan />);
    await findPlanTree();
    expect(keys()).toEqual(["ws:1", "pg:10", "pg:11", "pj:102", "ws:2", "pg:12"]);
    expect(screen.getByRole("button", { name: "Program Billing" })).toHaveAttribute("aria-expanded", "false");
  });

  test("a stored key of a node that is gone matches nothing, and the user's next change drops it", async () => {
    localStorage.setItem(COLLAPSED_KEY, JSON.stringify(["pg:10", "pg:999", "ws:404"]));
    show();
    const user = userEvent.setup();
    renderWithProviders(<Plan />);
    await findPlanTree();
    expect(keys()).toEqual(["ws:1", "pg:10", "pg:11", "pj:102", "ws:2", "pg:12"]);
    expect(stored()).toEqual(["pg:10", "pg:999", "ws:404"]);
    await user.click(screen.getByRole("button", { name: "Program Identity" }));
    expect([...(stored() as string[])].sort()).toEqual(["pg:10", "pg:11"]);
  });

  test("a corrupt or foreign stored value reads as the default", async () => {
    localStorage.setItem(COLLAPSED_KEY, JSON.stringify({ collapsed: true }));
    show();
    renderWithProviders(<Plan />);
    await findPlanTree();
    expect(keys()).toHaveLength(8);
  });

  test("a plan with nothing to fold offers no Expand all or Collapse all", async () => {
    show(planOf([{ id: 1, name: "Solo" }]));
    renderWithProviders(<Plan />);
    await findPlanTree();
    expect(screen.queryByRole("button", { name: "Expand all" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Collapse all" })).not.toBeInTheDocument();
  });

  test("a folded work stream keeps its icon-only plus under today's name", async () => {
    show();
    const user = userEvent.setup();
    renderWithProviders(<Plan />);
    await findPlanTree();
    await user.click(screen.getByRole("button", { name: "Work stream Platform" }));
    expect(screen.getByRole("button", { name: "New program in Platform" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "New project in Billing" })).not.toBeInTheDocument();
  });

  test("a program created under a folded work stream opens it, so the new row is not saved out of sight", async () => {
    show(PLAN, { "GET /api/v1/people": PEOPLE, "POST /api/v1/work-streams/1/programs": new Response(JSON.stringify({ id: 12 }), { status: 201, headers: { "Content-Type": "application/json" } }) });
    const user = userEvent.setup();
    renderWithProviders(<Plan />);
    const platform = await screen.findByRole("button", { name: "Work stream Platform" });
    await user.click(platform);
    expect(platform).toHaveAttribute("aria-expanded", "false");
    await user.click(screen.getByRole("button", { name: "New program in Platform" }));
    const modal = screen.getByRole("dialog");
    await user.type(within(modal).getByLabelText("Name"), "Reports");
    const owner = within(modal).getByRole("combobox", { name: "Owner" });
    await user.click(owner);
    await user.type(owner, "ola");
    await user.click(await screen.findByRole("option", { name: "Ola Owner (ola@example.com)" }));
    await user.click(within(modal).getByRole("button", { name: /^create$/i }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(screen.getByRole("button", { name: "Work stream Platform" })).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByRole("button", { name: "Program Billing" })).toBeInTheDocument();
  });

  test("the focus returns to the row's plus when its editor closes", async () => {
    show(PLAN, { "GET /api/v1/people": PEOPLE });
    const user = userEvent.setup();
    renderWithProviders(<Plan />);
    await findPlanTree();
    const plus = screen.getByRole("button", { name: "New program in Platform" });
    await user.click(plus);
    await user.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    await waitFor(() => expect(plus).toHaveFocus());
  });

  test("a reader with no rights sees no control but the folds, the filters and the links", async () => {
    const readOnly = planOf(
      [{ id: 1, name: "Platform", can: { edit: false, delete: false, createProgram: false, orderPrograms: false }, programs: [{ id: 10, name: "Billing", can: { edit: false, delete: false, createProject: false, move: false }, projects: [{ id: 100, name: "Invoices", can: { edit: false, delete: false, editTargetWindow: false, move: false, createMilestone: false, createDependency: false } }] }] }],
      { can: { createWorkStream: false, orderWorkStreams: false } },
    );
    show(readOnly);
    renderWithProviders(<Plan />);
    await findPlanTree();
    const names = screen.getAllByRole("button").map((button) => button.getAttribute("aria-label") ?? button.textContent);
    // The only menus left are the view ones (Show only this, Pin): everyone may focus and pin.
    expect(names.sort()).toEqual(["Collapse all", "Expand all", "Filters", "Operations for Billing", "Operations for Invoices", "Operations for Platform", "Program Billing", "Work stream Platform"]);
    expect(screen.getByRole("link", { name: "Open project Invoices" })).toBeInTheDocument();
  });

  test("the load failure shows no table and no fold controls", async () => {
    vi.stubGlobal("fetch", routeFetch({ "GET /api/v1/views/plan": new Response(JSON.stringify({ title: "x", status: 500 }), { status: 500, headers: { "Content-Type": "application/json" } }) }));
    renderWithProviders(<Plan />);
    expect(await screen.findByText("Could not load the plan")).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByRole("table")).not.toBeInTheDocument());
    expect(screen.queryByRole("button", { name: "Collapse all" })).not.toBeInTheDocument();
  });
});

describe("Plan page: a moved node stays in sight", () => {
  let plan: PlanView;
  const moveTo = async (user: ReturnType<typeof userEvent.setup>, from: string, item: string, label: string, search: string, option: string) => {
    await user.click(await screen.findByRole("button", { name: `Operations for ${from}` }));
    await user.click(await screen.findByRole("menuitem", { name: item }));
    const dialog = await screen.findByRole("dialog");
    const select = within(dialog).getByRole("combobox", { name: label });
    await user.click(select);
    await user.type(select, search);
    await user.click(await screen.findByRole("option", { name: option }));
    return dialog;
  };

  beforeEach(() => {
    localStorage.setItem("astrolabe.auth.token", "fake-token");
    plan = planOf([
      { id: 1, name: "Platform", programs: [{ id: 10, name: "Billing", projects: [{ id: 100, name: "Invoices" }] }, { id: 11, name: "Identity", projects: [{ id: 101, name: "Login" }] }] },
      { id: 2, name: "Legacy", programs: [{ id: 20, name: "Archive", projects: [{ id: 102, name: "Old" }] }] },
    ]);
    vi.stubGlobal(
      "fetch",
      routeFetch({
        "GET /api/v1/views/plan": () => plan,
        "GET /api/v1/views/jira-links": linksView(),
        "POST /api/v1/projects/:id/move": new Response(null, { status: 204 }),
        "POST /api/v1/programs/:id/move": new Response(null, { status: 204 }),
      }),
    );
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    localStorage.clear();
  });

  test("a project moved into a program of a folded work stream opens the stream and the program", async () => {
    const user = userEvent.setup();
    renderWithProviders(<Plan />);
    await user.click(await screen.findByRole("button", { name: "Work stream Legacy" }));
    expect(screen.queryByRole("button", { name: "Program Archive" })).not.toBeInTheDocument();
    const dialog = await moveTo(user, "Invoices", "Move Invoices to another program", "New program", "arch", "Archive");
    // What the server holds after the move, answered to the reload that follows it.
    const [moved] = plan.workStreams[0].programs[0].projects.splice(0, 1);
    plan.workStreams[1].programs[0].projects.push({ ...moved, programId: 20, workStreamId: 2 });
    await user.click(within(dialog).getByRole("button", { name: "Move" }));
    expect(await screen.findByRole("link", { name: "Open project Invoices" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Work stream Legacy" })).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByRole("button", { name: "Program Archive" })).toHaveAttribute("aria-expanded", "true");
  });

  test("a project moved into a FOLDED program opens that program", async () => {
    const user = userEvent.setup();
    renderWithProviders(<Plan />);
    await user.click(await screen.findByRole("button", { name: "Program Identity" }));
    expect(screen.queryByRole("link", { name: "Open project Login" })).not.toBeInTheDocument();
    const dialog = await moveTo(user, "Invoices", "Move Invoices to another program", "New program", "ident", "Identity");
    const [moved] = plan.workStreams[0].programs[0].projects.splice(0, 1);
    plan.workStreams[0].programs[1].projects.push({ ...moved, programId: 11 });
    await user.click(within(dialog).getByRole("button", { name: "Move" }));
    expect(await screen.findByRole("link", { name: "Open project Invoices" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Program Identity" })).toHaveAttribute("aria-expanded", "true");
  });

  test("a program moved into a folded work stream opens it", async () => {
    const user = userEvent.setup();
    renderWithProviders(<Plan />);
    await user.click(await screen.findByRole("button", { name: "Work stream Legacy" }));
    const dialog = await moveTo(user, "Billing", "Move Billing to another work stream", "New work stream", "leg", "Legacy");
    const [moved] = plan.workStreams[0].programs.splice(0, 1);
    plan.workStreams[1].programs.push({ ...moved, workStreamId: 2 });
    await user.click(within(dialog).getByRole("button", { name: "Move" }));
    expect(await screen.findByRole("button", { name: "Program Billing" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Work stream Legacy" })).toHaveAttribute("aria-expanded", "true");
  });
});
