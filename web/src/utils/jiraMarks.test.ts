import { describe, expect, test } from "vitest";
import type { Deviation } from "../api/deviations";
import type { ProjectMilestone } from "../api/milestones";
import type { JiraLink, JiraSite, PlanFlag } from "../api/roadmap";
import type { TeamMilestone } from "../api/teams";
import { detail, evidence } from "../test/deviations";
import { markKey, projectMarks, teamMarks } from "./jiraMarks";

const SITES = [{ connectionId: 2, siteUrl: "https://acme.atlassian.net", state: "CURRENT" as const, mappingOk: true }];
const link = (bindingId: number, key: string, connectionId = 2): JiraLink => ({ bindingId, connectionId, issueKey: key, start: "2044-01-04", end: "2044-01-08", rollup: null });
const endLater: Deviation = { kind: "END_DIFFERS", severity: "WARNING", detail: detail({ jira: "2044-01-08", plan: "2044-01-13", days: 3 }) };
const flag = (kind: PlanFlag["kind"], severity: PlanFlag["severity"], over: Partial<PlanFlag> = {}): PlanFlag => ({ kind, severity, ...over });
const deviationFlag = (severity: PlanFlag["severity"] = "WARNING") => flag("JIRA_DEVIATION", severity, { deviation: evidence(endLater) });

const milestone = (id: number, over: Partial<ProjectMilestone & TeamMilestone> = {}) => ({ id, jira: null, flags: [], ...over }) as ProjectMilestone & TeamMilestone;
const project = (over: Partial<{ jira: JiraLink | null; flags: PlanFlag[] }> = {}) => ({ id: 7, jira: null, flags: [], ...over }) as Parameters<typeof projectMarks>[0]["project"];

describe("projectMarks", () => {
  test("one mark per linked node, the project's own included: the key, the connection's site (from jiraSites), the binding and the open flags by severity", () => {
    const marks = projectMarks({
      jiraSites: SITES,
      project: project({ jira: link(5, "E2E-1") }),
      scheduled: [milestone(11, { jira: link(6, "E2E-3"), flags: [deviationFlag("WARNING"), deviationFlag("INFO")] }), milestone(12)],
      unscheduled: [milestone(13, { jira: link(7, "E2E-4") })],
    });
    expect(marks.byNode.get(markKey("PROJECT", 7))).toEqual({ bindingId: 5, key: "E2E-1", siteUrl: "https://acme.atlassian.net", warnings: 0, infos: 0 });
    expect(marks.byNode.get(markKey("MILESTONE", 11))).toEqual({ bindingId: 6, key: "E2E-3", siteUrl: "https://acme.atlassian.net", warnings: 1, infos: 1 });
    expect(marks.byNode.get(markKey("MILESTONE", 13))).toMatchObject({ bindingId: 7, warnings: 0, infos: 0 });
    expect(marks.byNode.has(markKey("MILESTONE", 12))).toBe(false);
    expect([marks.warnings, marks.infos]).toEqual([1, 1]);
  });

  test("the project's JIRA_MILESTONES roll-up is not counted (its milestone rows are): a deviation is never counted twice", () => {
    const marks = projectMarks({
      jiraSites: SITES,
      project: project({ jira: link(5, "E2E-1"), flags: [deviationFlag("INFO"), flag("JIRA_MILESTONES", "WARNING", { count: 2 })] }),
      scheduled: [milestone(11, { jira: link(6, "E2E-3"), flags: [deviationFlag()] })],
      unscheduled: [],
    });
    expect(marks.byNode.get(markKey("PROJECT", 7))).toMatchObject({ warnings: 0, infos: 1 });
    expect([marks.warnings, marks.infos]).toEqual([1, 1]);
  });

  test("a link whose connection is not in jiraSites still gets its mark, without a site (its key then reads as plain text)", () => {
    const marks = projectMarks({ jiraSites: [], project: project(), scheduled: [milestone(11, { jira: link(6, "E2E-3", 99) })], unscheduled: [] });
    expect(marks.byNode.get(markKey("MILESTONE", 11))?.siteUrl).toBeNull();
  });

  test("an unlinked document has no marks at all", () => {
    expect(projectMarks({ jiraSites: [], project: project(), scheduled: [milestone(1)], unscheduled: [] })).toEqual({ byNode: new Map(), warnings: 0, infos: 0, stale: false });
  });
});

describe("teamMarks", () => {
  test("the team's linked milestones, scheduled and in the tray, with their open flags summed", () => {
    const marks = teamMarks({
      jiraSites: SITES,
      scheduled: [milestone(1, { jira: link(1, "E2E-3"), flags: [deviationFlag()] }), milestone(2)],
      unscheduled: [milestone(3, { jira: link(3, "E2E-9"), flags: [deviationFlag("INFO")] })],
    });
    expect([...marks.byNode.keys()]).toEqual([markKey("MILESTONE", 1), markKey("MILESTONE", 3)]);
    expect([marks.warnings, marks.infos]).toEqual([1, 1]);
  });
});

describe("stale", () => {
  const site = (over: Partial<JiraSite> = {}, connectionId = 2): JiraSite => ({ ...SITES[0], connectionId, ...over });
  const staleOf = (sites: JiraSite[], links: JiraLink[]) =>
    projectMarks({ jiraSites: sites, project: project(), scheduled: links.map((l, i) => milestone(i + 1, { jira: l })), unscheduled: [] }).stale;

  test.each(["NEVER_SYNCED", "STALE", "FAILED", "DISABLED"] as const)("a linked node behind a %s site is stale", (state) => {
    expect(staleOf([site({ state })], [link(1, "E2E-3")])).toBe(true);
  });

  test("a CURRENT site whose mapping does not fit is stale", () => {
    expect(staleOf([site({ mappingOk: false })], [link(1, "E2E-3")])).toBe(true);
  });

  test("a CURRENT site with a fitting mapping is not stale", () => {
    expect(staleOf([site()], [link(1, "E2E-3")])).toBe(false);
  });

  test("a site no marked node links through does not count", () => {
    expect(staleOf([site(), site({ state: "FAILED" }, 9)], [link(1, "E2E-3")])).toBe(false);
  });

  test("a stale site counts when only a tray milestone links through it, and in the team marks", () => {
    const stale = site({ state: "STALE" });
    expect(projectMarks({ jiraSites: [stale], project: project(), scheduled: [], unscheduled: [milestone(1, { jira: link(1, "E2E-3") })] }).stale).toBe(true);
    expect(teamMarks({ jiraSites: [stale], scheduled: [milestone(1, { jira: link(1, "E2E-3") })], unscheduled: [] }).stale).toBe(true);
  });

  test("no site, or a link whose connection is not in jiraSites: not stale", () => {
    expect(staleOf([], [link(1, "E2E-3")])).toBe(false);
    expect(staleOf([site({ state: "FAILED" })], [link(1, "E2E-3", 99)])).toBe(false);
    expect(staleOf([site({ state: "FAILED" })], [])).toBe(false);
  });
});
