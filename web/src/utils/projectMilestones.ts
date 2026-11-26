import type { ProjectMilestone, ProjectView } from "../api/milestones";
import { foldDiacritics } from "./text";

/** The Schedule control's three choices: every milestone, the ones without dates, the ones with dates. */
export type MilestoneSchedule = "all" | "unscheduled" | "scheduled";

export const MILESTONE_SCHEDULES: readonly MilestoneSchedule[] = ["all", "unscheduled", "scheduled"];

/** The columns the Milestones table of the project page sorts by. */
export type MilestoneSortField = "name" | "team" | "start";

export type MilestoneSortDir = "asc" | "desc";

/** What narrows the table: the Schedule choice, one team of the project, a name search. Unset / blank = off. */
export type MilestoneNarrowing = { schedule: MilestoneSchedule; teamId: number | undefined; name: string };

/** The `milestones` parameter of the address as a Schedule choice: only the exact words count, anything else is no choice (a stale link never breaks the page). */
export function parseScheduleParam(value: string | null): MilestoneSchedule | undefined {
  return MILESTONE_SCHEDULES.find((choice) => choice === value);
}

/** Every milestone the view holds, scheduled ones first (the view's own order), then the tray's: nothing is fetched or recomputed. */
export function projectMilestones(view: Pick<ProjectView, "scheduled" | "unscheduled">): ProjectMilestone[] {
  return [...view.scheduled, ...view.unscheduled];
}

/** A milestone has both dates or neither (the server's invariant); one missing date is "not scheduled". */
export const isScheduled = (milestone: ProjectMilestone): milestone is ProjectMilestone & { startDate: string; endDate: string } =>
  milestone.startDate !== null && milestone.endDate !== null;

/** The teams the milestones belong to, one entry per team, by name (accents and case ignored), then id. */
export function milestoneTeams(milestones: readonly ProjectMilestone[]): { id: number; name: string }[] {
  const byId = new Map<number, string>();
  for (const milestone of milestones) byId.set(milestone.teamId, milestone.teamName);
  return [...byId].map(([id, name]) => ({ id, name })).sort((a, b) => compareText(a.name, b.name) || a.id - b.id);
}

/** How many of the three controls narrow the table. */
export function narrowingCount({ schedule, teamId, name }: MilestoneNarrowing): number {
  return (schedule === "all" ? 0 : 1) + (teamId === undefined ? 0 : 1) + (name.trim() === "" ? 0 : 1);
}

/** The milestones the three controls keep, in the order given. The name is a case- and accent-insensitive substring match on the milestone's name. */
export function filterMilestones(milestones: readonly ProjectMilestone[], { schedule, teamId, name }: MilestoneNarrowing): ProjectMilestone[] {
  const needle = foldDiacritics(name.trim());
  return milestones.filter(
    (milestone) =>
      (schedule === "all" || isScheduled(milestone) === (schedule === "scheduled")) &&
      (teamId === undefined || milestone.teamId === teamId) &&
      (needle === "" || foldDiacritics(milestone.name).includes(needle)),
  );
}

const COLLATOR = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });
const compareText = (a: string, b: string): number => COLLATOR.compare(a, b);

/**
 * The milestones sorted by a column. Text compares by the collator (numbers inside names in numeric order, case and accents ignored), the start by its
 * ISO date; a milestone without dates comes last in BOTH directions (as the server's start sort does). Ties fall back to the name, then the id, so the
 * order is total and a re-render never shuffles rows.
 */
export function sortMilestones(milestones: readonly ProjectMilestone[], field: MilestoneSortField, dir: MilestoneSortDir): ProjectMilestone[] {
  const sign = dir === "asc" ? 1 : -1;
  const tieBreak = (a: ProjectMilestone, b: ProjectMilestone) => compareText(a.name, b.name) || a.id - b.id;
  // "Dated" is `isScheduled`'s rule (both dates), so the Schedule filter and this sort can never disagree.
  const startOf = (milestone: ProjectMilestone): string | null => (isScheduled(milestone) ? milestone.startDate : null);
  const byStart = (a: ProjectMilestone, b: ProjectMilestone): number => {
    const from = startOf(a);
    const to = startOf(b);
    if (from === null || to === null) return from === to ? tieBreak(a, b) : from === null ? 1 : -1;
    return sign * (from < to ? -1 : from > to ? 1 : 0) || tieBreak(a, b);
  };
  const compare = (a: ProjectMilestone, b: ProjectMilestone): number => {
    if (field === "start") return byStart(a, b);
    const primary = field === "name" ? compareText(a.name, b.name) : compareText(a.teamName, b.teamName);
    return sign * primary || (field === "name" ? a.id - b.id : tieBreak(a, b));
  };
  return [...milestones].sort(compare);
}
