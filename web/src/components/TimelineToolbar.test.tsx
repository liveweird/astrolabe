import { describe, expect, test, vi } from "vitest";
import TimelineColumnsControl from "./TimelineColumnsControl";
import CriticalPathToggle from "./CriticalPathToggle";
import JiraBarsToggle from "./JiraBarsToggle";
import TimelineToolbar from "./TimelineToolbar";
import type { TimelineColumnView } from "../utils/timelineColumns";
import { MILESTONE_ZOOMS } from "../utils/timelineScale";
import { renderWithProviders, screen, within } from "../test/render";

// Every Gantt toolbar control has ONE size, the small of the Week / Month / Quarter switch (`TOOLBAR_CONTROL_SIZE`, timeline.md "The toolbar").

const COLUMNS: TimelineColumnView = {
  columns: [],
  hidden: new Set(),
  scrollRef: { current: null },
  offered: [{ id: "team", header: "Team", width: 100, hideable: true }],
  allHidden: false,
  toggleAll: vi.fn(),
  setShown: vi.fn(),
};

describe("the Timeline toolbar", () => {
  test("the zoom switch and every button after it share the small size", () => {
    renderWithProviders(
      <TimelineToolbar zoom="week" zooms={MILESTONE_ZOOMS} onZoomChange={vi.fn()} onToday={vi.fn()} todayDisabled={false}>
        <TimelineColumnsControl view={COLUMNS} />
        <CriticalPathToggle shown={false} onChange={vi.fn()} />
        <JiraBarsToggle shown onChange={vi.fn()} />
      </TimelineToolbar>,
    );
    const toolbar = screen.getByRole("group", { name: "Timeline controls" });
    const zoom = within(toolbar).getByRole("radiogroup", { name: "Zoom" }).closest("[data-size]");
    expect(zoom).toHaveAttribute("data-size", "xs");
    const buttons = within(toolbar).getAllByRole("button");
    expect(buttons.map((button) => button.textContent || button.getAttribute("aria-label"))).toEqual(["Scroll to today", "Hide columns", "Choose columns", "Critical path", "Jira dates"]);
    for (const button of buttons) expect(button).toHaveAttribute("data-size", "xs");
  });
});
