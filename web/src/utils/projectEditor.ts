import type { EndpointRef, ProjectDependency } from "../api/dependencies";
import type { ProjectMilestone } from "../api/milestones";
import type { BindTarget } from "../components/JiraBindDialog";

/**
 * Which editor dialog the project page has open. `dependency` is the Add dependency dialog; `successor` prefills it (the row menu's
 * shortcut), null = the project itself. `editDependency` is the same dialog on an existing link (type and lag only).
 */
export type Editor =
  | { kind: "create" }
  | { kind: "edit"; milestone: ProjectMilestone }
  | { kind: "project" }
  | { kind: "dependency"; successor: EndpointRef | null }
  | { kind: "editDependency"; dependency: ProjectDependency }
  | { kind: "jira"; target: BindTarget };

/** The bind dialog is open (the connections it offers are asked for only then). */
export const isJiraEditor = (editor: Editor | null): editor is Extract<Editor, { kind: "jira" }> => editor?.kind === "jira";
