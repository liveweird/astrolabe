import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import userEvent from "@testing-library/user-event";
import { screen, within } from "@testing-library/react";
import Programs from "./Programs";
import type { ProgramsProgram, ProgramsView, ProgramsWorkStream } from "../api/programs";
import { jsonResponse } from "../test/http";
import { roadmapProject } from "../test/roadmapView";
import { renderWithProviders } from "../test/render";

// The overview's names as links (1.31): a work stream's and a program's name lead to the overview narrowed to it, an owner to the person, a project to its page. The chevron
// button holds a node row's one roving stop, so these links are the pointer's (tabindex -1) and the row menu says "Open ..." for the keyboard; a node with no
// chevron has its name as the stop; the node the page is narrowed to is plain text on its own row.

const none = { warnings: 0, infos: 0 };
const span = { start: "2026-03-02", end: "2026-04-10" };
const BILLING: ProgramsProgram = {
  id: 10,
  name: "Billing",
  ownerPersonId: 11,
  ownerName: "Pat Program",
  span,
  flags: none,
  projects: [roadmapProject({ id: 1, name: "Invoices", programId: 10, programName: "Billing", workStreamId: 1, workStreamName: "Platform", ownerPersonId: 12, ownerName: "Ola Owner", span })],
};
const REPORTS: ProgramsProgram = { id: 11, name: "Reports", ownerPersonId: 13, ownerName: "Rita Reports", span: null, flags: none, projects: [] };
const PLATFORM: ProgramsWorkStream = { id: 1, name: "Platform", ownerPersonId: 14, ownerName: "Sam Stream", startDate: "2026-01-05", endDate: null, span, flags: none, programs: [BILLING, REPORTS] };
const FRESH: ProgramsWorkStream = { id: 3, name: "Fresh", ownerPersonId: 15, ownerName: "Fay Fresh", startDate: "2026-01-05", endDate: null, span: null, flags: none, programs: [] };

beforeEach(() => {
  const view: ProgramsView = { jiraSites: [], revision: 9, teams: [], links: [], workStreams: [PLATFORM, FRESH] };
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

const grid = () => screen.findByRole("grid", { name: "Programs timeline" });
/** The row whose name cell starts with `name` (the work stream, program or project). */
const rowOf = (name: string) => within(screen.getByRole("grid", { name: "Programs timeline" })).getAllByRole("row").find((row) => row.querySelector("[role='rowheader']")?.textContent?.startsWith(name))!;

describe("the overview's names as links", () => {
  test("a node with a chevron: the name link is the pointer's (out of the tab order), the owner's too, and the chevron holds the cell's stop", async () => {
    renderWithProviders(<Programs />, { route: "/roadmap?mode=overview" });
    await grid();
    const stream = rowOf("Platform");
    const name = within(stream).getByRole("link", { name: "Open work stream Platform" });
    expect(name).toHaveAttribute("href", "/roadmap?mode=overview&workStreamId=1");
    expect(name).toHaveAttribute("tabindex", "-1");
    expect(name).not.toHaveAttribute("data-grid-pos");
    expect(within(stream).getByRole("link", { name: "Open person Sam Stream" })).toHaveAttribute("href", "/people/14");
    expect(within(stream).getByRole("button", { name: "Work stream Platform" })).toHaveAttribute("data-grid-pos");
    const program = rowOf("Billing");
    expect(within(program).getByRole("link", { name: "Open program Billing" })).toHaveAttribute("href", "/roadmap?mode=overview&programId=10");
    expect(within(program).getByRole("link", { name: "Open person Pat Program" })).toHaveAttribute("href", "/people/11");
  });

  test("a node with no chevron has its name as the stop; a project's name is its stop and its owner the pointer's link", async () => {
    const user = userEvent.setup();
    renderWithProviders(<Programs />, { route: "/roadmap?mode=overview" });
    await grid();
    expect(within(rowOf("Fresh")).getByRole("link", { name: "Open work stream Fresh" })).toHaveAttribute("data-grid-pos");
    expect(within(rowOf("Reports")).getByRole("link", { name: "Open program Reports" })).toHaveAttribute("data-grid-pos");
    await user.click(within(screen.getByRole("grid", { name: "Programs timeline" })).getByRole("button", { name: "Program Billing" }));
    const project = within(screen.getByRole("grid", { name: "Programs timeline" })).getByRole("link", { name: "Open project Invoices" }).closest<HTMLElement>('[role="row"]')!;
    expect(within(project).getByRole("link", { name: "Open project Invoices" })).toHaveAttribute("data-grid-pos");
    expect(within(project).getByRole("link", { name: "Open person Ola Owner" })).toHaveAttribute("href", "/people/12");
    expect(within(project).getByRole("link", { name: "Open person Ola Owner" })).toHaveAttribute("tabindex", "-1");
  });

  test("the row menus are the keyboard's way to the links out of the tab order", async () => {
    const user = userEvent.setup();
    renderWithProviders(<Programs />, { route: "/roadmap?mode=overview" });
    await grid();
    await user.click(screen.getByRole("button", { name: "Operations for Platform" }));
    expect((await screen.findAllByRole("menuitem")).map((item) => item.getAttribute("aria-label"))).toEqual(["Open work stream Platform", "Open person Sam Stream"]);
    await user.keyboard("{Escape}");
    await user.click(screen.getByRole("button", { name: "Operations for Fresh" }));
    // Fresh has no chevron: its name is reachable already, so the menu holds only its owner.
    expect((await screen.findAllByRole("menuitem")).map((item) => item.getAttribute("aria-label"))).toEqual(["Open person Fay Fresh"]);
  });

  test("the work stream the address narrows to is plain text on its own row; its programs still link", async () => {
    const user = userEvent.setup();
    renderWithProviders(<Programs />, { route: "/roadmap?mode=overview&workStreamId=1" });
    await grid();
    const stream = rowOf("Platform");
    expect(within(stream).queryByRole("link", { name: "Open work stream Platform" })).toBeNull();
    expect(stream).toHaveTextContent("Platform");
    expect(within(rowOf("Billing")).getByRole("link", { name: "Open program Billing" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Operations for Platform" }));
    expect((await screen.findAllByRole("menuitem")).map((item) => item.getAttribute("aria-label"))).toEqual(["Open person Sam Stream"]);
  });

  test("a sole picked program is plain text on its own row, its work stream still a link", async () => {
    renderWithProviders(<Programs />, { route: "/roadmap?mode=overview&programId=10" });
    await grid();
    expect(within(rowOf("Billing")).queryByRole("link", { name: "Open program Billing" })).toBeNull();
    expect(within(rowOf("Platform")).getByRole("link", { name: "Open work stream Platform" })).toBeInTheDocument();
  });
});
