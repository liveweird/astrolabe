import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import userEvent from "@testing-library/user-event";
import { screen, waitFor, within } from "@testing-library/react";
import Programs from "./Programs";
import type { ProgramsProgram, ProgramsView } from "../api/programs";
import type { RoadmapProject } from "../api/roadmap";
import { jsonResponse } from "../test/http";
import { renderWithProviders } from "../test/render";

// Above 80 rows the Timeline virtualises. Crossing that threshold swaps the render path and remounts EVERY row, which used to drop the focus of
// the chevron that was pressed (it fell to `body`): it must stay on, or return to, that node's chevron. The programs tree is the one page whose
// row count a keyboard user changes from inside the grid. happy-dom lays nothing out, so the scroller is given a size (as Timeline.test.tsx does).

const project = (id: number, programId: number): RoadmapProject => ({
  jira: null,
  id,
  name: `P${programId}-${id}`,
  programId,
  programName: `Prog ${programId}`,
  workStreamId: 1,
  workStreamName: "Platform",
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

const programOf = (id: number, count: number): ProgramsProgram => ({
  id,
  name: `Prog ${id}`,
  ownerName: "Pat",
  span: { start: "2026-03-02", end: "2026-04-10" },
  flags: { warnings: 0, infos: 0 },
  projects: Array.from({ length: count }, (_, i) => project(1000 * id + i, id)),
});

// One work stream, three programs of 1, 40 and 41 projects, so the chevrons sit at the top of the window: opened, 4 rows; with the 41-project one 45; with the 40-project one as well 85 (> 80).
const VIEW: ProgramsView = {
  jiraSites: [],
  revision: 1,
  teams: [],
  links: [],
  workStreams: [
    {
      id: 1,
      name: "Platform",
      ownerName: "Sam Stream",
      startDate: "2026-01-05",
      endDate: null,
      span: { start: "2026-03-02", end: "2026-04-10" },
      flags: { warnings: 0, infos: 0 },
      programs: [programOf(1, 1), programOf(2, 40), programOf(3, 41)],
    },
  ],
};

const VIEWPORT_PROPS = ["clientWidth", "clientHeight"] as const;
const originals = VIEWPORT_PROPS.map((name) => [name, Object.getOwnPropertyDescriptor(HTMLElement.prototype, name)] as const);

beforeEach(() => {
  for (const [name, value] of [["clientWidth", 1200], ["clientHeight", 600]] as const) Object.defineProperty(HTMLElement.prototype, name, { configurable: true, get: () => value });
  vi.stubGlobal("fetch", vi.fn((url: string) => Promise.resolve(url === "/api/v1/views/programs" ? jsonResponse(200, VIEW) : jsonResponse(404, { title: "x", status: 404 }))));
  localStorage.setItem("astrolabe.auth.token", "fake-token");
});

afterEach(() => {
  for (const [name, descriptor] of originals) {
    if (descriptor === undefined) delete (HTMLElement.prototype as unknown as Record<string, unknown>)[name];
    else Object.defineProperty(HTMLElement.prototype, name, descriptor);
  }
  vi.unstubAllGlobals();
  localStorage.clear();
});

const grid = () => screen.getByRole("grid", { name: "Programs timeline" });
const chevron = (name: string) => within(grid()).getByRole("button", { name });
const mountedRows = () => within(grid()).getAllByRole("row").length - 1;
const rowCount = (rows: number) => waitFor(() => expect(grid()).toHaveAttribute("aria-rowcount", String(rows + 1)));

describe("Programs page: the virtual path (more than 80 rows)", () => {
  test("Expand all takes the virtual path: a window of the 86 rows is mounted, and the button that was pressed keeps the focus", async () => {
    const user = userEvent.setup();
    renderWithProviders(<Programs />);
    await screen.findByRole("grid", { name: "Programs timeline" });
    expect(mountedRows()).toBe(4);
    const expandAll = screen.getByRole("button", { name: "Expand all" });
    await user.click(expandAll);
    await rowCount(86);
    await waitFor(() => expect(mountedRows()).toBeLessThan(86));
    expect(mountedRows()).toBeGreaterThan(0);
    expect(expandAll).toHaveFocus();
  });

  test("a collapse through the chevron with Enter keeps the focus on that chevron, whether the rows stay over 80 or fall under it", async () => {
    const user = userEvent.setup();
    renderWithProviders(<Programs />);
    await screen.findByRole("grid", { name: "Programs timeline" });
    await user.click(screen.getByRole("button", { name: "Expand all" }));
    await rowCount(86);
    // 86 - 1 = 85: still virtual, so the pressed button is not remounted.
    chevron("Program Prog 1").focus();
    await user.keyboard("{Enter}");
    await rowCount(85);
    await waitFor(() => expect(chevron("Program Prog 1")).toHaveFocus());
    expect(chevron("Program Prog 1")).toHaveAttribute("aria-expanded", "false");
    // 85 - 40 = 45: back under 80, every row remounts as a plain row.
    chevron("Program Prog 2").focus();
    await user.keyboard("{Enter}");
    await rowCount(45);
    await waitFor(() => expect(chevron("Program Prog 2")).toHaveFocus());
    expect(chevron("Program Prog 2")).toHaveAttribute("aria-expanded", "false");
  });

  test("a single toggle that takes the rows from under 80 to over it keeps the focus on the pressed chevron, and so does the way back", async () => {
    const user = userEvent.setup();
    renderWithProviders(<Programs />);
    await screen.findByRole("grid", { name: "Programs timeline" });
    await user.click(chevron("Program Prog 3"));
    await rowCount(45);
    chevron("Program Prog 2").focus();
    await user.keyboard("{Enter}");
    await rowCount(85);
    await waitFor(() => expect(chevron("Program Prog 2")).toHaveFocus());
    expect(chevron("Program Prog 2")).toHaveAttribute("aria-expanded", "true");
    await user.keyboard("{Enter}");
    await rowCount(45);
    await waitFor(() => expect(chevron("Program Prog 2")).toHaveFocus());
  });
});
