import { afterEach, describe, expect, test, vi } from "vitest";
import TimelineUnscheduledTray from "./TimelineUnscheduledTray";
import TimelineDndContext from "./TimelineDndContext";
import { makeScale, toEpochDay } from "../utils/timelineScale";
import { renderWithProviders, screen } from "../test/render";

const scale = makeScale("week", { from: toEpochDay("2026-09-14"), to: toEpochDay("2026-10-11") });

const tray = () => (
  <TimelineDndContext scale={scale} onSchedule={vi.fn(() => true)}>
    <TimelineUnscheduledTray
      label="Unscheduled milestones"
      columns={["Milestone"]}
      items={[{ id: 1, label: "Discovery", cells: ["Discovery"], canSchedule: true }]}
      emptyText="Nothing"
      onSchedule={vi.fn()}
    />
  </TimelineDndContext>
);

afterEach(() => vi.restoreAllMocks());

describe("TimelineUnscheduledTray", () => {
  test("in a box as wide as the Gantt pane's rule allows it is a plain table, not a scroll region (a held row can leave it)", () => {
    vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(900);
    renderWithProviders(tray());
    expect(screen.getByRole("table", { name: "Unscheduled milestones" })).toBeInTheDocument();
    expect(screen.queryByRole("region")).toBeNull();
  });

  test("in a box narrower than that it is a focusable, labelled region that scrolls the table sideways", () => {
    vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(358);
    renderWithProviders(tray());
    const region = screen.getByRole("region", { name: "Unscheduled milestones" });
    expect(region).toHaveAttribute("tabindex", "0");
    expect(region).toContainElement(screen.getByRole("table", { name: "Unscheduled milestones" }));
  });
});
