// Shared fixtures of the Roadmap overview's schedule proposal tests (1.33): a plan of two programs and three projects on three teams, and the run over it.
import type { ProgramsProgram, ProgramsView } from "../api/programs";
import type { RoadmapProject } from "../api/roadmap";
import type { CrossTeamProposal } from "../api/scheduleProposals";
import { localIsoDate } from "../utils/isoDate";
import { block, move } from "./crossTeamRun";

const project = (id: number, name: string, programId: number, programName: string, over: Partial<RoadmapProject> = {}): RoadmapProject => ({
  jira: null,
  id,
  name,
  programId,
  programName,
  workStreamId: 1,
  workStreamName: "Platform",
  ownerPersonId: 5,
  ownerName: "Ola Owner",
  targetStart: null,
  targetEnd: null,
  rankPosition: null,
  teamIds: [],
  span: null,
  drift: null,
  flags: [],
  can: { editTargetWindow: true },
  ...over,
});

export const INVOICES = project(1, "Invoices", 10, "Billing", { targetStart: "2042-02-03", targetEnd: "2042-03-31", span: { start: "2042-03-02", end: "2042-04-10" }, teamIds: [1] });
const TAXES = project(2, "Taxes", 10, "Billing", { span: { start: "2042-05-04", end: "2042-06-05" }, teamIds: [1, 2] });
export const DASHBOARDS = project(3, "Dashboards", 11, "Reports", { span: { start: "2042-08-03", end: "2042-09-04" }, teamIds: [3] });
const none = { warnings: 0, infos: 0 };
const BILLING: ProgramsProgram = { id: 10, name: "Billing", ownerPersonId: 1, ownerName: "Pat Program", span: { start: "2042-03-02", end: "2042-06-05" }, flags: none, projects: [INVOICES, TAXES] };
export const REPORTS: ProgramsProgram = { id: 11, name: "Reports", ownerPersonId: 1, ownerName: "Rita Reports", span: { start: "2042-08-03", end: "2042-09-04" }, flags: none, projects: [DASHBOARDS] };
export const TEAMS = [
  { id: 1, name: "Alpha" },
  { id: 2, name: "Beta" },
  { id: 3, name: "Gamma" },
];

export const viewOf = (over: Partial<ProgramsView> = {}): ProgramsView => ({
  jiraSites: [],
  revision: 9,
  teams: TEAMS,
  links: [],
  workStreams: [{ id: 1, name: "Platform", ownerPersonId: 1, ownerName: "Sam Stream", startDate: "2042-01-05", endDate: null, span: { start: "2042-03-02", end: "2042-09-04" }, flags: none, programs: [BILLING, REPORTS] }],
  ...over,
});

const onProject = (projectId: number, projectName: string) => ({ projectId, projectName });
/** Alpha moves Invoices and Taxes, Beta Taxes, Gamma Dashboards; each project's span moves as `projects` says. */
export const RUN: CrossTeamProposal = {
  revision: 12,
  asOf: localIsoDate(),
  passes: 1,
  settled: true,
  scopeHash: "b".repeat(64),
  teams: [
    block(1, "Alpha", [move(11, "a1", "2042-03-09", "2042-04-17", { ...onProject(1, "Invoices"), shiftDays: 5 }), move(12, "a2", "2042-04-27", "2042-05-20", { ...onProject(2, "Taxes"), shiftDays: -5 })]),
    block(2, "Beta", [move(21, "b1", "2042-05-25", "2042-06-19", { ...onProject(2, "Taxes"), shiftDays: 10 })]),
    block(3, "Gamma", [move(31, "g1", "2042-08-10", "2042-09-11", { ...onProject(3, "Dashboards"), shiftDays: 5 })]),
  ],
  projects: [
    { projectId: 1, name: "Invoices", before: { start: "2042-03-02", end: "2042-04-10" }, after: { start: "2042-03-09", end: "2042-04-17" }, endShiftDays: 5 },
    { projectId: 2, name: "Taxes", before: { start: "2042-05-04", end: "2042-06-05" }, after: { start: "2042-04-27", end: "2042-06-19" }, endShiftDays: 10 },
    { projectId: 3, name: "Dashboards", before: { start: "2042-08-03", end: "2042-09-04" }, after: { start: "2042-08-10", end: "2042-09-11" }, endShiftDays: 5 },
  ],
};
