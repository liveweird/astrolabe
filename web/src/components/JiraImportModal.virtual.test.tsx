import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import userEvent from "@testing-library/user-event";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import JiraImportModal from "./JiraImportModal";
import { IMPORT_ROW_HEIGHT } from "./JiraImportRow";
import type { JiraImportItem } from "../api/jira";
import { jsonResponse } from "../test/http";
import { CONNECTION } from "../test/jira";
import { installImportApi, previewScope } from "../test/jiraImportHarness";
import { previewOf } from "../test/jiraImport";
import { renderWithProviders } from "../test/render";
import { allSelectable, indexItems, tickRow } from "../utils/jiraImport";

// The 2,000-row cap (MAX_IMPORT_ITEMS): above 80 rows the preview table mounts a window of rows only. happy-dom lays nothing out, so the
// scroller is given a size (as Timeline.test.tsx does); the figures below are about the DOM and the model, not paint.

const item = (n: number, over: Partial<JiraImportItem>): JiraImportItem => ({
  jiraId: String(n),
  issueKey: `BIG-${n}`,
  summary: `Item ${n}`,
  level: "MILESTONE",
  action: "CREATE",
  name: `Item ${n}`,
  canSchedule: true,
  scheduled: false,
  infos: [],
  reason: null,
  parent: null,
  target: null,
  team: null,
  ...over,
});

/** One program, 19 projects under it, then 1,980 milestones spread over the projects: 2,000 CREATE rows, each child naming its parent row. */
const BIG: JiraImportItem[] = [
  item(1, { level: "PROGRAM" }),
  ...Array.from({ length: 19 }, (_, i) =>
    item(2 + i, { level: "PROJECT", parentJiraId: "1", parent: { kind: "NEW_ROW", nodeId: null, nodeName: "Item 1", rowJiraId: "1" } }),
  ),
  ...Array.from({ length: 1980 }, (_, i) => {
    const parent = 2 + (i % 19);
    return item(21 + i, {
      parentJiraId: String(parent),
      parent: { kind: "NEW_ROW", nodeId: null, nodeName: `Item ${parent}`, rowJiraId: String(parent) },
      team: { id: 5, name: "IMP Team", rule: "MATCHED" },
    });
  }),
];

const VIEWPORT_PROPS = ["clientWidth", "clientHeight"] as const;
const originals = VIEWPORT_PROPS.map((name) => [name, Object.getOwnPropertyDescriptor(HTMLElement.prototype, name)] as const);

beforeEach(() => {
  for (const [name, value] of [["clientWidth", 1000], ["clientHeight", 460]] as const) Object.defineProperty(HTMLElement.prototype, name, { configurable: true, get: () => value });
  installImportApi({ preview: () => jsonResponse(200, previewOf(BIG)) });
});

afterEach(() => {
  for (const [name, descriptor] of originals) {
    if (descriptor === undefined) delete (HTMLElement.prototype as unknown as Record<string, unknown>)[name];
    else Object.defineProperty(HTMLElement.prototype, name, descriptor);
  }
  vi.unstubAllGlobals();
  localStorage.clear();
});

const mountedRows = () => within(screen.getByRole("table", { name: "Import preview" })).getAllByRole("row").length - 1;

describe("the preview at the 2,000-row cap", () => {
  test("mounts a window of the rows, keeps the true count for assistive technology, and follows the scroll", async () => {
    const user = userEvent.setup();
    renderWithProviders(<JiraImportModal connection={CONNECTION} onClose={vi.fn()} />);
    await previewScope(user);
    const table = screen.getByRole("table", { name: "Import preview" });
    expect(table).toHaveAttribute("aria-rowcount", "2001");
    expect(mountedRows()).toBeGreaterThan(0);
    expect(mountedRows()).toBeLessThan(60);
    expect(screen.getByText("2000 of 2000 selected")).toBeInTheDocument();
    expect(screen.queryByRole("checkbox", { name: "Import BIG-1000" })).not.toBeInTheDocument();
    const scroller = screen.getByRole("region", { name: "Import preview" });
    scroller.scrollTop = IMPORT_ROW_HEIGHT * 1000;
    fireEvent.scroll(scroller);
    await waitFor(() => expect(screen.getByRole("checkbox", { name: "Import BIG-1000" })).toBeInTheDocument());
    expect(screen.queryByRole("checkbox", { name: "Import BIG-1" })).not.toBeInTheDocument();
    expect(mountedRows()).toBeLessThan(60);
  });

  test("select none, select all and an untick of the root answer with the new counts", async () => {
    const user = userEvent.setup();
    renderWithProviders(<JiraImportModal connection={CONNECTION} onClose={vi.fn()} />);
    await previewScope(user);
    await user.click(screen.getByRole("button", { name: "Select none" }));
    expect(screen.getByText("0 of 2000 selected")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Select all" }));
    expect(screen.getByText("2000 of 2000 selected")).toBeInTheDocument();
    await user.click(screen.getByRole("checkbox", { name: "Import BIG-1" }));
    expect(screen.getByText("0 of 2000 selected")).toBeInTheDocument();
    expect(screen.getByText("Unticked BIG-1 and the 1999 items created under it: they would be skipped.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^Import \(0\)$/ })).toBeDisabled();
  });

  test("the model itself: a cascade over the whole tree", () => {
    const index = indexItems(BIG);
    const all = allSelectable(BIG);
    const none = tickRow(index, all, "1", false);
    const back = tickRow(index, none.ticks, "2000", true);
    expect(none.alsoChanged).toBe(1999);
    expect(back.ticks.size).toBe(3);
  });
});
