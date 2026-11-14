import type { TFunction } from "i18next";
import type { Deviation } from "../api/deviations";
import type { JiraLink } from "../api/roadmap";
import type { BaselineRow } from "./baselineOverlay";
import { deviationSentence } from "./deviations";
import { addDays } from "./isoDate";
import type { TimelineBarData } from "./timelineModel";

// The Jira shadow bar (1.3): the dates Jira was last observed to hold for a row, a thin dashed outline along the TOP of the row (`tone: "jira"`).
// The server decides which rows carry a link and which dates; this only phrases and shapes them. Shared by the roadmap, the programs tree and (C9) the
// project and team pages, which pass a milestone row's `jira` and `flags` the same way.

/**
 * The days either side of the plan's own dates that a Jira date may pull the range out to (see {@link jiraWindow}). Jira accepts any date the
 * server stores (1900 to 2999), so a typo must not give every user a track of hundreds of thousands of pixels.
 */
const WINDOW_PADDING_DAYS = 365;

/** The days a page may draw Jira dates on: the plan's own dates padded by a year, a page-wide figure (never per row). */
export type JiraWindow = { from: string; to: string };

/**
 * The window of a page's Jira bars: the earliest and latest of `planDates` (the page's own spans, windows and frozen spans, NO Jira date) padded by a
 * year each side, or today plus or minus a year when the plan has no dates. A Jira date inside it may widen the page's range; outside it is cut at
 * its edge, and a Jira range wholly outside it draws nothing and widens nothing.
 */
export function jiraWindow(planDates: readonly string[], today: string): JiraWindow {
  const min = planDates.length === 0 ? today : planDates.reduce((a, b) => (b < a ? b : a));
  const max = planDates.length === 0 ? today : planDates.reduce((a, b) => (b > a ? b : a));
  return { from: addDays(min, -WINDOW_PADDING_DAYS), to: addDays(max, WINDOW_PADDING_DAYS) };
}

/**
 * The days a link's Jira dates occupy inside the window: BOTH dates or nothing (a link with one date draws nothing and widens nothing), cut at the
 * window's edges, and `null` when the whole range lies outside it. The row's accessible name keeps the real dates; this is only what is drawn and
 * what the page's range follows.
 */
export function visibleJiraDates(link: Pick<JiraLink, "start" | "end"> | null, window: JiraWindow): { start: string; end: string } | null {
  if (link === null || link.start === null || link.end === null || link.end < window.from || link.start > window.to) return null;
  return { start: link.start < window.from ? window.from : link.start, end: link.end > window.to ? window.to : link.end };
}

/** The dates the page's range follows for these rows' Jira links: each link's `visibleJiraDates`, both ends, nothing for a link that draws no bar. */
export function jiraRangeDates(rows: readonly { jira: Pick<JiraLink, "start" | "end"> | null }[], window: JiraWindow): string[] {
  return rows.flatMap((row) => {
    const shown = visibleJiraDates(row.jira, window);
    return shown === null ? [] : [shown.start, shown.end];
  });
}

/**
 * What a page that draws the Jira bars of its milestone rows (the project and team pages) needs: the window while the "Jira dates" toggle is `shown`
 * (`null` while it is off: no bar is drawn and no Jira date joins the range), and the dates its range follows - the plan's own `planDates`, plus the
 * Jira dates of `rows` inside the window.
 */
export function jiraPageRange(
  shown: boolean,
  planDates: readonly string[],
  rows: readonly { jira: Pick<JiraLink, "start" | "end"> | null }[],
  today: string,
): { window: JiraWindow | null; dates: string[] } {
  if (!shown) return { window: null, dates: [...planDates] };
  const window = jiraWindow(planDates, today);
  return { window, dates: [...planDates, ...jiraRangeDates(rows, window)] };
}

/** The bar's id: `jira:<node id>`. */
const jiraBarId = (key: number | string) => `jira:${key}`;

/** The deviation kinds that are about DATES: the bar's name appends their sentences. */
const DATE_KINDS: ReadonlySet<string> = new Set(["START_DIFFERS", "END_DIFFERS", "TARGET_DIFFERS"]);

/** What of a flag the sentences need: its kind and, for a `JIRA_DEVIATION`, the evidence. */
type FlagLike = { kind: string; deviation?: Pick<Deviation, "kind" | "detail"> };

/** The sentences of the row's open DATE deviations, in the flags' order. */
function dateSentences(flags: readonly FlagLike[], t: TFunction): string[] {
  return flags.flatMap((flag) =>
    flag.kind === "JIRA_DEVIATION" && flag.deviation !== undefined && DATE_KINDS.has(flag.deviation.kind) ? [deviationSentence(flag.deviation, { jira: { estimateUnit: null } }, t)] : [],
  );
}

/**
 * The shadow bar of a row's Jira dates, or `undefined` when there is nothing to draw: no link, either date unknown (never observed, absent in
 * Jira, or the item is gone), or the dates wholly outside the page's `window`. Read-only. It is drawn over `visibleJiraDates` (cut at the window), but
 * its accessible name is the REAL dates: "Jira E2E-6: 2044-03-01 to 2044-03-05" and, when the row has open date deviations, their sentences
 * ("..., Ends 3 working days later than Jira").
 */
export function jiraBar(
  key: number | string,
  name: string,
  link: Pick<JiraLink, "issueKey" | "start" | "end"> | null,
  flags: readonly FlagLike[],
  window: JiraWindow,
  t: TFunction,
): TimelineBarData | undefined {
  const drawn = visibleJiraDates(link, window);
  if (link === null || drawn === null) return undefined;
  const dates = t("timeline.bar.jira", { key: link.issueKey, start: link.start, end: link.end });
  const sentences = dateSentences(flags, t);
  return { id: jiraBarId(key), start: drawn.start, end: drawn.end, label: name, describe: [dates, ...sentences].join(", "), editable: false, tone: "jira" };
}

/** The part of a tray milestone the Jira rows read (either view's unscheduled row). */
type TrayMilestone = { id: number; name: string; jira: Pick<JiraLink, "issueKey" | "start" | "end"> | null; flags: readonly FlagLike[] };

/** The id of the row a tray milestone gets for its Jira bar alone (1.16): `jira-unscheduled:<milestoneId>`, apart from the baseline's `baseline-removed:<id>`. */
export const jiraTrayRowId = (milestoneId: number) => `jira-unscheduled:${milestoneId}`;

/**
 * The dashed Jira bars of the TRAY milestones (1.16), by milestone id: the scheduled rows' rule (`jiraBar`: both dates inside the window, an
 * acknowledged deviation keeps its bar). `window` null (the "Jira dates" toggle is off) = no bar at all.
 */
export function jiraTrayBars(unscheduled: readonly TrayMilestone[], window: JiraWindow | null, t: TFunction): Map<number, TimelineBarData> {
  const bars = new Map<number, TimelineBarData>();
  if (window === null) return bars;
  for (const milestone of unscheduled) {
    const bar = jiraBar(milestone.id, milestone.name, milestone.jira, milestone.flags, window, t);
    if (bar !== undefined) bars.set(milestone.id, bar);
  }
  return bars;
}

/** The ids of the tray milestones the baseline overlay already gave an appended row ("unscheduled since the baseline"): their Jira bar goes on that row. */
export const baselineUnscheduledIds = (rows: readonly Pick<BaselineRow, "reason" | "milestoneId">[]): Set<number> =>
  new Set(rows.filter((row) => row.reason === "unscheduled").map((row) => row.milestoneId));

/**
 * The tray milestones that get a row of their own for their Jira bar (1.16): those with a bar in `bars` that no baseline row `taken`, in (drawn
 * start, drawn end, name, id) order - the baseline idiom's order.
 */
export function jiraTrayRows<T extends { id: number; name: string }>(unscheduled: readonly T[], bars: ReadonlyMap<number, TimelineBarData>, taken: ReadonlySet<number>): T[] {
  const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
  return unscheduled
    .flatMap((milestone) => {
      const bar = bars.get(milestone.id);
      return bar === undefined || taken.has(milestone.id) ? [] : [{ milestone, bar }];
    })
    .sort(
      (a, b) =>
        compare(a.bar.start, b.bar.start) ||
        compare(a.bar.end, b.bar.end) ||
        a.milestone.name.toLowerCase().localeCompare(b.milestone.name.toLowerCase()) ||
        a.milestone.id - b.milestone.id,
    )
    .map(({ milestone }) => milestone);
}

/**
 * The dates "Schedule on Jira's dates" writes (1.17): the link's REAL start and end when both are set and in order, else `null` (the item is then not
 * offered). Never the bar's dates, which may be cut at the window: the plan gets what Jira holds.
 */
export function jiraScheduleDates(link: Pick<JiraLink, "start" | "end"> | null): { start: string; end: string } | null {
  if (link === null || link.start === null || link.end === null || link.start > link.end) return null;
  return { start: link.start, end: link.end };
}

/** `{connectionId → siteUrl}` of a document's `jiraSites` (the browse URL is built from it, never carried per row). */
export function siteUrls(sites: readonly { connectionId: number; siteUrl: string }[]): ReadonlyMap<number, string> {
  return new Map(sites.map((site) => [site.connectionId, site.siteUrl]));
}
