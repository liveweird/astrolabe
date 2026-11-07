// Shared fixtures for the Jira import tests: a preview shaped like the stub's IMP tree plus a few rows the stub does not have.
import type { JiraImportItem, JiraImportPreview } from "../api/jira";

const NEW_PROGRAM = { kind: "NEW_ROW", nodeId: null, nodeName: "IMP Program", rowJiraId: "95001" } as const;
const NEW_ALPHA = { kind: "NEW_ROW", nodeId: null, nodeName: "IMP Initiative Alpha", rowJiraId: "95002" } as const;

const base = (jiraId: string, issueKey: string, level: JiraImportItem["level"], over: Partial<JiraImportItem>): JiraImportItem => ({
  jiraId,
  issueKey,
  summary: over.name ?? issueKey,
  typeName: level === "PROGRAM" ? "Program" : level === "PROJECT" ? "Initiative" : "Epic",
  level,
  action: "CREATE",
  name: issueKey,
  canSchedule: true,
  scheduled: false,
  infos: [],
  // The server emits every optional member as null (`explicitNulls`), never absent.
  hierarchyLevel: null,
  parentJiraId: null,
  parentIssueKey: null,
  reason: null,
  parent: null,
  target: null,
  estimateMd: null,
  startDate: null,
  endDate: null,
  team: null,
  ...over,
});

/** Program IMP-1 > projects IMP-2 (alpha), IMP-3 > milestones IMP-4 (dated, team from Jira), IMP-5 (default team), IMP-7 (long name); IMP-8 skipped; IMP-9 binds. */
export const PREVIEW_ITEMS: JiraImportItem[] = [
  base("95001", "IMP-1", "PROGRAM", { name: "IMP Program", parent: null }),
  base("95002", "IMP-2", "PROJECT", { name: "IMP Initiative Alpha", parentJiraId: "95001", parentIssueKey: "IMP-1", parent: NEW_PROGRAM }),
  base("95003", "IMP-3", "PROJECT", { name: "IMP Initiative Beta", parentJiraId: "95001", parentIssueKey: "IMP-1", parent: NEW_PROGRAM }),
  base("95004", "IMP-4", "MILESTONE", {
    name: "IMP Epic One",
    parentJiraId: "95002",
    parentIssueKey: "IMP-2",
    parent: NEW_ALPHA,
    team: { id: 5, name: "IMP Team", rule: "MATCHED" },
    startDate: "2045-01-02",
    endDate: "2045-01-06",
    estimateMd: 5,
    scheduled: true,
  }),
  base("95005", "IMP-5", "MILESTONE", {
    name: "IMP Epic Two",
    parentJiraId: "95002",
    parentIssueKey: "IMP-2",
    parent: NEW_ALPHA,
    team: { id: 6, name: "Default Team", rule: "DEFAULT" },
    startDate: "2045-01-09",
    endDate: "2045-01-13",
    estimateMd: 0,
    scheduled: true,
    canSchedule: false,
    infos: ["ESTIMATE_NOT_CONVERTED", "NAME_TRUNCATED", "DATES_NOT_COPIED"],
  }),
  base("95008", "IMP-8", "MILESTONE", { action: "SKIP", reason: "NO_PARENT", name: "IMP Epic Five", parentJiraId: "95001" }),
  base("95009", "IMP-9", "PROJECT", { action: "BIND", name: "Existing Project", parentJiraId: "95001", target: { nodeId: 77, nodeName: "Existing Project" } }),
  base("95010", "IMP-10", "MILESTONE", {
    name: "IMP Epic Six",
    parent: { kind: "EXISTING", nodeId: 40, nodeName: "Old project", rowJiraId: null },
    team: { id: 5, name: "IMP Team", rule: "MATCHED" },
    estimateMd: 3,
  }),
  // A non-admin's redacted SKIP row: no summary, the key as the name, no infos.
  base("95011", "IMP-11", "MILESTONE", { action: "SKIP", reason: "NAME_TAKEN", summary: "", name: "IMP-11" }),
];

export const previewOf = (items: JiraImportItem[], over: Partial<JiraImportPreview> = {}): JiraImportPreview => ({
  connectionId: 1,
  workStreamId: 3,
  revision: 12,
  asOf: 1_800_000_000_000,
  totals: {
    items: items.length,
    create: items.filter((i) => i.action === "CREATE").length,
    bind: items.filter((i) => i.action === "BIND").length,
    skip: items.filter((i) => i.action === "SKIP").length,
    truncated: false,
  },
  unmatchedTeams: [],
  items,
  ...over,
});
