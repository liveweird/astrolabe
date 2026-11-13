// Shared fixtures for the links view (`GET /views/jira-links`, 1.15): a document, a node link and the connection the links go through.
import type { JiraLinksView, JiraNodeLink } from "../api/jira";

/** The connection of the links view: the same facts as the deviations fixture's `DEV_CONNECTION`, without the run and status the links view does not carry. */
export const LINK_CONNECTION: JiraLinksView["connections"][number] = {
  id: 1,
  name: "Acme Jira",
  siteUrl: "https://acme.atlassian.net",
  enabled: true,
  projectKeys: ["E2E"],
  mappingOk: true,
};

/** A link of a program or project, through connection 1 unless told otherwise; the binding id follows the node's. */
export const nodeLink = (level: JiraNodeLink["level"], nodeId: number, issueKey: string, over: Partial<JiraNodeLink> = {}): JiraNodeLink => ({
  level,
  nodeId,
  bindingId: 70 + nodeId,
  connectionId: 1,
  issueKey,
  gone: false,
  ...over,
});

export const linksView = (over: Partial<JiraLinksView> = {}): JiraLinksView => ({ connections: [LINK_CONNECTION], links: [], truncated: false, ...over });
