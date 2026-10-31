import type { Announcements } from "@dnd-kit/core";
import type { TFunction } from "i18next";
import type { RoadmapRankedProject } from "../api/roadmap";

/**
 * dnd-kit's screen-reader announcements for the ranked list, in the UI language: the live region says which project is held
 * and which position it is over, by name and rank ("Invoices, position 2 of 5"). Positions come from the list as the
 * announcement fires; the ids are the sortable ids (project ids).
 */
export function roadmapAnnouncements(t: TFunction, rows: readonly RoadmapRankedProject[]): Announcements {
  const describe = (id: string | number) => {
    const index = rows.findIndex((row) => row.project.id === id);
    return { name: rows[index]?.project.name ?? "", position: index + 1, count: rows.length };
  };
  return {
    onDragStart: ({ active }) => t("roadmap.dnd.start", describe(active.id)),
    onDragOver: ({ active, over }) => (over ? t("roadmap.dnd.over", { ...describe(active.id), target: describe(over.id).position }) : undefined),
    onDragEnd: ({ active, over }) =>
      over ? t("roadmap.dnd.end", { ...describe(active.id), target: describe(over.id).position }) : t("roadmap.dnd.endNoTarget", describe(active.id)),
    onDragCancel: ({ active }) => t("roadmap.dnd.cancel", describe(active.id)),
  };
}
