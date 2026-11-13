import type { ImportRoot } from "./jiraImport";

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
