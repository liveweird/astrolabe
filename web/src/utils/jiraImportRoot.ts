import type { JiraBinding } from "../api/jira";
import type { PlanView } from "../api/plan";
import type { ImportRoot } from "./jiraImport";
import { findProgram, findProject } from "./planMove";

/** A plan node the rooted import can start from: the program or project of a plan view or a project view (the owner is an ACTIVE person: one who owns a node cannot be deleted). */
type RootNode = { id: number; name: string; workStreamId: number; ownerPersonId: number; ownerName: string };

/** The Jira link the import goes through; `gone` = the read already says the Jira item is gone (absent = not known). */
type RootLink = { issueKey: string; connectionId: number; gone?: boolean };

/** The rooted import's root (1.14/1.15) for a linked program or project: the ONE builder behind the Plan page and the project page. The owner opens as the node's own. */
export function rootOf(level: ImportRoot["level"], node: RootNode, link: RootLink): ImportRoot {
  return {
    level,
    nodeId: node.id,
    name: node.name,
    issueKey: link.issueKey,
    connectionId: link.connectionId,
    workStreamId: node.workStreamId,
    owner: { value: String(node.ownerPersonId), label: node.ownerName },
    ...(link.gone === undefined ? {} : { gone: link.gone }),
  };
}

/**
 * The root of a connection-page row (1.15): the row's program or project looked up in the plan view (the binding's node has no work stream id and
 * no owner), through the connection the page is about. Null for a milestone row, while the plan view is not read yet (or failed), and when the plan
 * no longer holds the node (a stale list: the server hides a deleted node's bindings, so only a race lands here).
 */
export function rootOfBinding(plan: PlanView | undefined, row: JiraBinding, connectionId: number): ImportRoot | null {
  if (plan === undefined) return null;
  const gone = row.observation?.gone;
  const link = { issueKey: row.issueKey, connectionId, ...(gone === undefined ? {} : { gone }) };
  if (row.node.kind === "PROGRAM") {
    const found = findProgram(plan, row.node.id);
    return found === null ? null : rootOf("PROGRAM", found.program, link);
  }
  if (row.node.kind === "PROJECT") {
    const found = findProject(plan, row.node.id);
    return found === null ? null : rootOf("PROJECT", found.project, link);
  }
  return null;
}
