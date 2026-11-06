// The static part of the stub's Jira site: ids, issue types, statuses, the ~60 fields and the projects' non-issue endpoints.
// Everything here is a literal or a pure function of the world; nothing random. Adjusting a field id or a type id is a one-line change
// here plus a regenerate (sample-data/jira/README.md).

export const CLOUD_ID = "b3f1a2c4-5d6e-4f7a-8b9c-0d1e2f3a4b5c";
export const BASE = `/ex/jira/${CLOUD_ID}/rest/api/3`;

/** The token the stub refuses with a 401 (any scheme, any email): what the e2e "wrong token" scenario sends. */
export const REJECTED_TOKEN = "wrong-token";

/** The scheme every authenticated mapping demands; a missing or malformed header falls to the 401 catch-all. */
export const AUTH_HEADER_PATTERN = "^(Basic|Bearer) .+$";

// Issue types (the numeric ids are the stub's; the hierarchy levels are Jira's: Sub-task -1, Story/Task/Bug 0, Epic 1, Initiative 2, and
// a site-defined level 3 here named Program).
export const TYPE = {
  subtask: { id: "10000", name: "Sub-task", subtask: true, hierarchyLevel: -1 },
  story: { id: "10001", name: "Story", subtask: false, hierarchyLevel: 0 },
  task: { id: "10002", name: "Task", subtask: false, hierarchyLevel: 0 },
  bug: { id: "10003", name: "Bug", subtask: false, hierarchyLevel: 0 },
  epic: { id: "10004", name: "Epic", subtask: false, hierarchyLevel: 1 },
  initiative: { id: "10005", name: "Initiative", subtask: false, hierarchyLevel: 2 },
  program: { id: "10006", name: "Program", subtask: false, hierarchyLevel: 3 },
};
export const ISSUE_TYPES = Object.values(TYPE);

/** The plan level each Jira type carries: program -> Program, project -> Initiative, milestone -> Epic. */
export const TYPE_OF_LEVEL = { program: TYPE.program, project: TYPE.initiative, milestone: TYPE.epic };

export const STATUS = {
  todo: { id: "10000", name: "To Do", category: { id: 2, key: "new", name: "To Do", colorName: "blue-gray" } },
  doing: { id: "10001", name: "In Progress", category: { id: 4, key: "indeterminate", name: "In Progress", colorName: "yellow" } },
  done: { id: "10002", name: "Done", category: { id: 3, key: "done", name: "Done", colorName: "green" } },
};

// The custom fields the sync cares about, by their real-site names. The ids follow a typical Cloud site (Team 10001, Start date 10015,
// Story point estimate 10016, Rank 10019, Sprint 10020); the Plans "Target start/end" ids are the stub's.
export const F = {
  team: "customfield_10001",
  epicLink: "customfield_10014",
  startDate: "customfield_10015",
  storyPointEstimate: "customfield_10016",
  parentLink: "customfield_10018",
  rank: "customfield_10019",
  sprint: "customfield_10020",
  targetStart: "customfield_10022",
  targetEnd: "customfield_10023",
  storyPoints: "customfield_10026",
};

const system = (id, name, type) => ({ id, key: id, name, custom: false, orderable: true, navigable: true, searchable: true, schema: { type, system: id } });
const custom = (id, name, type, customMarker) => ({
  id: `customfield_${id}`,
  key: `customfield_${id}`,
  name,
  custom: true,
  orderable: true,
  navigable: true,
  searchable: true,
  schema: { type, custom: customMarker, customId: id },
});
const DT = "com.atlassian.jira.plugin.system.customfieldtypes";

/**
 * GET /field, ~60 rows in a deliberately awkward order: "Story Points" (the classic-project field the default picks, the first number field
 * named "story point") precedes "Story point estimate"; "Start date" and `duedate` exist beside Plans' "Target start"/"Target end", so the
 * default rule must prefer the Plans pair; "Parent Link" (jpo-custom-field-parent) exists so the legacy-parent line of the discovery report
 * fires; datetime and number decoys sit among the dates.
 */
export function fieldCatalog() {
  const fields = [
    system("summary", "Summary", "string"),
    system("status", "Status", "status"),
    system("issuetype", "Issue Type", "issuetype"),
    system("project", "Project", "project"),
    system("parent", "Parent", "issuelink"),
    system("assignee", "Assignee", "user"),
    system("reporter", "Reporter", "user"),
    system("priority", "Priority", "priority"),
    system("labels", "Labels", "array"),
    system("components", "Components", "array"),
    system("fixVersions", "Fix versions", "array"),
    system("resolution", "Resolution", "resolution"),
    system("created", "Created", "datetime"),
    system("updated", "Updated", "datetime"),
    system("resolutiondate", "Resolved", "datetime"),
    system("duedate", "Due date", "date"),
    system("timeoriginalestimate", "Original estimate", "number"),
    system("timeestimate", "Remaining estimate", "number"),
    system("timespent", "Time Spent", "number"),
    system("description", "Description", "string"),
    custom(10001, "Team", "team", `${DT}:atlassian-team`),
    custom(10014, "Epic Link", "any", "com.pyxis.greenhopper.jira:gh-epic-link"),
    custom(10015, "Start date", "date", `${DT}:datepicker`),
    custom(10026, "Story Points", "number", `${DT}:float`),
    custom(10016, "Story point estimate", "number", `${DT}:float`),
    custom(10018, "Parent Link", "any", "com.atlassian.jpo:jpo-custom-field-parent"),
    custom(10019, "Rank", "any", "com.pyxis.greenhopper.jira:gh-lexo-rank"),
    custom(10020, "Sprint", "array", "com.pyxis.greenhopper.jira:gh-sprint"),
    custom(10022, "Target start", "date", "com.atlassian.jpo:jpo-custom-field-baseline-start"),
    custom(10023, "Target end", "date", "com.atlassian.jpo:jpo-custom-field-baseline-end"),
  ];
  // Filler up to ~60 rows: a deterministic mix of types, including datetime and number decoys the mapping validator must refuse or ignore.
  const filler = [
    ["Actual start", "datetime", `${DT}:datetime`],
    ["Actual end", "datetime", `${DT}:datetime`],
    ["Go-live date", "date", `${DT}:datepicker`],
    ["Release date", "date", `${DT}:datepicker`],
    ["Review date", "date", `${DT}:datepicker`],
    ["Business value", "number", `${DT}:float`],
    ["Risk score", "number", `${DT}:float`],
    ["Effort (hours)", "number", `${DT}:float`],
    ["Customer impact", "option", `${DT}:select`],
    ["Region", "option", `${DT}:select`],
    ["Budget code", "string", `${DT}:textfield`],
    ["Cost centre", "string", `${DT}:textfield`],
    ["Approver", "user", `${DT}:userpicker`],
    ["Stakeholders", "array", `${DT}:multiuserpicker`],
    ["Flagged", "array", `${DT}:multicheckboxes`],
    ["Impediment", "option", `${DT}:select`],
    ["Change reason", "string", `${DT}:textarea`],
    ["Delivery notes", "string", `${DT}:textarea`],
    ["Roadmap link", "string", `${DT}:url`],
    ["Vendor", "option", `${DT}:select`],
    ["Compliance tag", "array", `${DT}:labels`],
    ["Confidence", "number", `${DT}:float`],
    ["Satisfaction", "option", `${DT}:radiobuttons`],
    ["Rollout wave", "option", `${DT}:select`],
    ["Sizing", "option", `${DT}:select`],
    ["Cost estimate", "number", `${DT}:float`],
    ["Planned capacity", "number", `${DT}:float`],
    ["Legal review date", "date", `${DT}:datepicker`],
    ["Sign-off date", "date", `${DT}:datepicker`],
    ["Last updated by", "user", `${DT}:userpicker`],
  ];
  filler.forEach(([name, type, marker], i) => fields.push(custom(10030 + i, name, type, marker)));
  return fields;
}

/** GET /issuetype. */
export const issueTypeCatalog = () => ISSUE_TYPES.map((t) => ({ ...t, description: `${t.name} (stub)` }));

/** The projects: one per work stream (key derived by the world), `E2E`, and `OUT` (where day 2 moves five epics; no scope lists it). */
export const projectRow = (id, key, name) => ({ id, key, name, projectTypeKey: "software", simplified: false, style: "classic" });

export const ACCOUNT = {
  accountId: "5f8a1b2c3d4e5f6a7b8c9d01",
  displayName: "Astrolabe Sample Service Account",
  emailAddress: "astrolabe-sample-bot@astrolabe.example",
  active: true,
};
