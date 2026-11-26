// Shared fixtures for the MilestoneSelect and dependency panel tests: a row and a page as GET /milestones answers them.
import type { components } from "../api/schema";

type Item = components["schemas"]["MilestoneListItem"];
type Page = components["schemas"]["MilestonePage"];

/** One scheduled milestone row; override any member (`startDate`/`endDate` null = unscheduled). */
export function milestoneItem(over: Partial<Item> = {}): Item {
  return {
    id: 1,
    projectId: 7,
    projectName: "Invoices",
    name: "Design",
    description: null,
    teamId: 3,
    teamName: "Backend",
    rankPosition: 2,
    estimateMd: 5,
    startDate: "2026-03-02",
    endDate: "2026-03-13",
    pinned: false,
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000,
    ...over,
  };
}

/** A page of rows with the envelope the server answers (`total` defaults to the rows given). */
export function milestonePage(items: Item[], over: Partial<Page> = {}): Page {
  return { items, page: 1, pageSize: 20, total: items.length, ...over };
}
