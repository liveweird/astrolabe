import { isoWeekOf, toEpochDay } from "./timelineScale";

/** "W05 · 2027-02-01": the ISO week number and its Monday (the date sorts and is what the strip positions). */
export const weekLabel = (weekStart: string) => `W${String(isoWeekOf(toEpochDay(weekStart)).week).padStart(2, "0")} · ${weekStart}`;

/** Man-days with their two decimals, the figure the server flags on ("4.80", never "4.8"). */
export const mdText = (value: number) => value.toFixed(2);
