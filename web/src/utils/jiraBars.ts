import type { TFunction } from "i18next";
import type { Deviation } from "../api/deviations";
import type { JiraLink } from "../api/roadmap";
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

/** The bar's id: `jira:<node id>`. */
const jiraBarId = (key: number | string) => `jira:${key}`;

/** The deviation kinds that are about DATES: the bar's name appends their sentences. */
const DATE_KINDS: ReadonlySet<string> = new Set(["START_DIFFERS", "END_DIFFERS", "TARGET_DIFFERS"]);

/** What of a flag the sentences need: its kind and, for a `JIRA_DEVIATION`, the evidence. */
type FlagLike = { kind: string; deviation: Deviation | null };

/** The sentences of the row's open DATE deviations, in the flags' order. */
function dateSentences(flags: readonly FlagLike[], t: TFunction): string[] {
  return flags.flatMap((flag) =>
    flag.kind === "JIRA_DEVIATION" && flag.deviation !== null && DATE_KINDS.has(flag.deviation.kind) ? [deviationSentence(flag.deviation, { jira: { estimateUnit: null } }, t)] : [],
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

/** `{connectionId → siteUrl}` of a document's `jiraSites` (the browse URL is built from it, never carried per row). */
export function siteUrls(sites: readonly { connectionId: number; siteUrl: string }[]): ReadonlyMap<number, string> {
  return new Map(sites.map((site) => [site.connectionId, site.siteUrl]));
}
