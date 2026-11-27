import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import userEvent from "@testing-library/user-event";
import TimelineColumnsControl from "./TimelineColumnsControl";
import { useTimelineColumns } from "../hooks/useTimelineColumns";
import type { TimelineColumnView } from "../utils/timelineColumns";
import type { TimelineColumn } from "../utils/timelineModel";
import { act, renderWithProviders, screen, waitFor, within } from "../test/render";

const COLUMNS: TimelineColumn[] = [
  { id: "name", header: "Milestone", width: 220 },
  { id: "team", header: "Team", width: 130, hideable: true },
  { id: "estimate", header: "Estimate", width: 120, hideable: true },
  { id: "ops", header: "Operations", width: 56 },
];

function Harness({ columns = COLUMNS }: { columns?: TimelineColumn[] }) {
  const view = useTimelineColumns("project", columns);
  return (
    <>
      <button>Before</button>
      <TimelineColumnsControl view={view} />
      <button>After</button>
    </>
  );
}

const toggle = () => screen.getByRole("button", { name: /^(Hide|Show) columns$/ });
const chevron = () => screen.getByRole("button", { name: "Choose columns" });

beforeEach(() => localStorage.clear());
afterEach(() => vi.useRealTimers());

describe("TimelineColumnsControl", () => {
  test("a labelled group of a disclosure button and a chevron that opens the menu", () => {
    renderWithProviders(<Harness />);
    const group = screen.getByRole("group", { name: "Columns" });
    expect(within(group).getAllByRole("button").map((button) => button.getAttribute("aria-label") ?? button.textContent)).toEqual(["Hide columns", "Choose columns"]);
    expect(chevron()).toHaveAttribute("aria-haspopup", "menu");
  });

  test("the toggle names its action and says whether the columns are drawn", async () => {
    const user = userEvent.setup();
    renderWithProviders(<Harness />);
    expect(toggle()).toHaveTextContent("Hide columns");
    expect(toggle()).toHaveAttribute("aria-expanded", "true");
    expect(toggle()).not.toHaveAttribute("aria-pressed");
    await user.click(toggle());
    expect(toggle()).toHaveTextContent("Show columns");
    expect(toggle()).toHaveAttribute("aria-expanded", "false");
    await user.click(toggle());
    expect(toggle()).toHaveTextContent("Hide columns");
    expect(toggle()).toHaveAttribute("aria-expanded", "true");
  });

  test("the menu lists the offered columns in column order, ticked while drawn", async () => {
    const user = userEvent.setup();
    renderWithProviders(<Harness />);
    await user.click(chevron());
    const menu = await screen.findByRole("menu", { name: "Choose columns" });
    const items = within(menu).getAllByRole("menuitemcheckbox");
    expect(items.map((item) => [item.textContent, item.getAttribute("aria-checked")])).toEqual([
      ["Team", "true"],
      ["Estimate", "true"],
    ]);
  });

  test("a click picks one column, keeps the menu open and the toggle follows", async () => {
    const user = userEvent.setup();
    renderWithProviders(<Harness />);
    await user.click(chevron());
    await user.click(await screen.findByRole("menuitemcheckbox", { name: "Team" }));
    expect(screen.getByRole("menuitemcheckbox", { name: "Team" })).toHaveAttribute("aria-checked", "false");
    expect(screen.getByRole("menuitemcheckbox", { name: "Estimate" })).toHaveAttribute("aria-checked", "true");
    expect(screen.getByRole("menu")).toBeInTheDocument();
    expect(toggle()).toHaveTextContent("Hide columns");
    await user.click(screen.getByRole("menuitemcheckbox", { name: "Estimate" }));
    expect(toggle()).toHaveTextContent("Show columns");
    // the pick is remembered, so a tick on Team shows Team alone
    await user.click(screen.getByRole("menuitemcheckbox", { name: "Team" }));
    expect(screen.getByRole("menuitemcheckbox", { name: "Team" })).toHaveAttribute("aria-checked", "true");
    expect(screen.getByRole("menuitemcheckbox", { name: "Estimate" })).toHaveAttribute("aria-checked", "false");
  });

  test("the menu shows what is drawn: a collapsed timeline has nothing ticked", async () => {
    const user = userEvent.setup();
    renderWithProviders(<Harness />);
    await user.click(toggle());
    await user.click(chevron());
    const items = await screen.findAllByRole("menuitemcheckbox");
    expect(items.map((item) => item.getAttribute("aria-checked"))).toEqual(["false", "false"]);
  });

  test("a click reports the ticked ids to the view", async () => {
    const user = userEvent.setup();
    const setShown = vi.fn();
    const view: TimelineColumnView = { hidden: new Set(["estimate"]), offered: COLUMNS.filter((c) => c.hideable === true), allHidden: false, toggleAll: vi.fn(), setShown };
    renderWithProviders(<TimelineColumnsControl view={view} />);
    await user.click(chevron());
    await user.click(await screen.findByRole("menuitemcheckbox", { name: "Estimate" }));
    expect(setShown).toHaveBeenCalledWith(["team", "estimate"]);
  });

  test("Tab closes the menu and the focus moves on from the chevron", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"], shouldAdvanceTime: true });
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    renderWithProviders(<Harness />);
    chevron().focus();
    await user.keyboard("{Enter}");
    await waitFor(() => expect(screen.getByRole("menuitemcheckbox", { name: "Team" })).toHaveFocus());
    await user.keyboard("{Tab}");
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
    expect(chevron()).toHaveAttribute("aria-expanded", "false");
    expect(screen.getByRole("button", { name: "After" })).toHaveFocus();
    await act(() => vi.advanceTimersByTimeAsync(40));
    expect(screen.getByRole("button", { name: "After" })).toHaveFocus();
  });

  test("nothing offered, nothing drawn", () => {
    const { container } = renderWithProviders(<Harness columns={[COLUMNS[0], COLUMNS[3]]} />);
    expect(screen.queryByRole("group", { name: "Columns" })).not.toBeInTheDocument();
    expect(container.querySelectorAll("button")).toHaveLength(2);
  });
});
