import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import userEvent from "@testing-library/user-event";
import Timeline from "./Timeline";
import TimelineColumnsControl from "./TimelineColumnsControl";
import TimelineDndContext from "./TimelineDndContext";
import { useTimelineColumns } from "../hooks/useTimelineColumns";
import type { TimelineColumn, TimelineRowData } from "../utils/timelineModel";
import { makeScale, toEpochDay } from "../utils/timelineScale";
import { renderWithProviders, screen, within } from "../test/render";

// The REAL hook, control and Timeline on a phone-width scroller: the pane is capped, the control says what is drawn, a tick draws a dropped column.
// An iconOnly header keeps its text for assistive technology and draws none.
const COLUMNS: TimelineColumn[] = [
  { id: "name", header: "Milestone", width: 220 },
  { id: "team", header: "Team", width: 130, hideable: true },
  { id: "ops", header: "Operations", width: 56, iconOnly: true },
];
const ROWS: TimelineRowData[] = [{ id: 1, cells: ["A long milestone name", "Team A", (stop) => <button {...stop}>Operations for A</button>], bars: [] }];
const scale = makeScale("week", { from: toEpochDay("2026-09-14"), to: toEpochDay("2026-10-11") });

function Page() {
  const view = useTimelineColumns("project", COLUMNS);
  return (
    <TimelineDndContext scale={scale} onSchedule={vi.fn(() => true)}>
      <Timeline
        label="Timeline"
        scale={scale}
        onZoomChange={vi.fn()}
        today="2026-09-23"
        columns={view.columns}
        hiddenColumns={view.hidden}
        scrollRef={view.scrollRef}
        rows={ROWS}
        toolbar={<TimelineColumnsControl view={view} />}
      />
    </TimelineDndContext>
  );
}

const stubScrollerWidth = (width: number) => vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(width);
const grid = () => screen.getByRole("grid", { name: "Timeline" });
const headers = () => within(grid()).getAllByRole("columnheader").map((h) => h.textContent);

beforeEach(() => localStorage.clear());
afterEach(() => vi.restoreAllMocks());

describe("the Timeline and its columns control on a narrow scroller", () => {
  test("the pane is capped, and the control describes the pane that is drawn", async () => {
    stubScrollerWidth(358);
    renderWithProviders(<Page />);
    expect(headers()).toEqual(["Milestone", "Operations"]);
    expect(grid().style.getPropertyValue("--timeline-left")).toBe("197px");
    expect(screen.getByRole("button", { name: "Show columns" })).toHaveAttribute("aria-expanded", "false");
    await userEvent.setup().click(screen.getByRole("button", { name: /^Choose columns · \d+ hidden$/ }));
    expect((await screen.findByRole("menuitemcheckbox", { name: "Team" })).getAttribute("aria-checked")).toBe("false");
    expect(localStorage).toHaveLength(0);
  });

  test("ticking the dropped column draws it, the name giving way, and writes nothing", async () => {
    stubScrollerWidth(358);
    const user = userEvent.setup();
    renderWithProviders(<Page />);
    await user.click(screen.getByRole("button", { name: /^Choose columns · \d+ hidden$/ }));
    await user.click(await screen.findByRole("menuitemcheckbox", { name: "Team" }));
    expect(headers()).toEqual(["Milestone", "Team", "Operations"]);
    expect(screen.getByRole("button", { name: "Hide columns" })).toHaveAttribute("aria-expanded", "true");
    expect(localStorage).toHaveLength(0);
  });

  test("a wide scroller keeps every column and says so", () => {
    stubScrollerWidth(900);
    renderWithProviders(<Page />);
    expect(headers()).toEqual(["Milestone", "Team", "Operations"]);
    expect(grid().style.getPropertyValue("--timeline-left")).toBe("406px");
  });

  test("an iconOnly header keeps its name for assistive technology and draws no visible text", () => {
    stubScrollerWidth(900);
    renderWithProviders(<Page />);
    expect(screen.getByRole("columnheader", { name: "Operations" }).firstElementChild).toHaveClass("mantine-VisuallyHidden-root");
  });
});
