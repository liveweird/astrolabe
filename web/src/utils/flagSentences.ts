import type { TFunction } from "i18next";
import type { JiraLink, PlanFlag } from "../api/roadmap";
import { deviationSentence } from "./deviations";

// The words of a plan flag, shared by every page that shows one: the roadmap's flag panel (per project) and the project and team pages' Flags column
// and tray rows (per milestone). The server's flags are only phrased here, never recomputed.

/** The names a flag's sentence can mention: the other project of a rank inversion, the shared team. */
export type FlagNames = { project: (id: number) => string; team: (id: number) => string };

/** For rows whose flags can only be Jira ones (a milestone's): no rank inversion is ever phrased, so no name is ever asked for. */
const NO_FLAG_NAMES: FlagNames = { project: () => "", team: () => "" };

/**
 * A flag in words, by kind (never colour alone); the day counts are calendar days, the sentences name the project and team they compare. A
 * `JIRA_DEVIATION` is the deviation page's own sentence for `flag.deviation` (`utils/deviations.ts`, working days) behind the row's Jira key
 * (`jiraKey`, the row's own link).
 */
export function flagSentence(t: TFunction, flag: PlanFlag, names: FlagNames, jiraKey: string | null): string {
  const count = flag.days ?? 0;
  switch (flag.kind) {
    case "DRIFT_END_LATE":
      return t("roadmap.flag.endLate", { count });
    case "DRIFT_START_LATE":
      return t("roadmap.flag.startLate", { count });
    case "DRIFT_END_EARLY":
      return t("roadmap.flag.endEarly", { count });
    case "RANK_INVERSION": {
      const other = flag.otherProjectId === null ? "" : names.project(flag.otherProjectId);
      return flag.teamId === null ? t("roadmap.flag.inversionNoTeam", { count, other }) : t("roadmap.flag.inversion", { count, other, team: names.team(flag.teamId) });
    }
    case "JIRA_DEVIATION": {
      // Without the evidence (the contract always sends it) the sentence degrades to the bare "differs", never to an invented figure.
      const sentence = flag.deviation === null ? t("roadmap.flag.jiraDeviationBare") : deviationSentence(flag.deviation, { jira: { estimateUnit: null } }, t);
      return jiraKey === null ? sentence : t("roadmap.flag.jiraDeviation", { key: jiraKey, sentence });
    }
    // The roll-up of the project's milestones' open deviations; the detail lives on the project page's rows.
    case "JIRA_MILESTONES":
      return t("roadmap.flag.jiraMilestones", { count: flag.count ?? 0 });
    // The team page's roll-up of its open Flow capacity deviations (1.9); the rows live on the page's Flow section.
    case "FLOW_CAPACITY":
      return t("roadmap.flag.flowCapacity", { count: flag.count ?? 0 });
  }
}

/** A milestone row's flags as one accessible label: each flag's sentence behind the row's Jira key, in the server's order (warnings first), separated by semicolons. */
export function milestoneFlagLabel(t: TFunction, flags: readonly PlanFlag[], jiraKey: string | null): string {
  return flags.map((flag) => flagSentence(t, flag, NO_FLAG_NAMES, jiraKey)).join("; ");
}

/**
 * "Jira: 2027-03-01 to 2027-03-05" for an UNSCHEDULED tray row whose Jira item has dates the plan item lacks (the open `UNSCHEDULED_IN_PLAN`
 * deviation), else `undefined`. An acknowledged deviation is not among the flags, so its note goes with it; a link with only one date says nothing
 * (the same both-or-nothing rule as the shadow bar).
 */
export function jiraTrayNote(t: TFunction, link: Pick<JiraLink, "start" | "end"> | null, flags: readonly PlanFlag[]): string | undefined {
  if (link === null || link.start === null || link.end === null) return undefined;
  const open = flags.some((flag) => flag.kind === "JIRA_DEVIATION" && flag.deviation?.kind === "UNSCHEDULED_IN_PLAN");
  return open ? t("timeline.jiraTrayNote", { start: link.start, end: link.end }) : undefined;
}
