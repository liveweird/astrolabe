/** The ONE place the Jira route family is spelled out — never hand-assemble a connection URL. */
export const jiraConnectionsPath = "/integrations/jira";
export const jiraConnectionPath = (id: number) => `${jiraConnectionsPath}/${id}`;

/** `https://x.atlassian.net/` → `https://x.atlassian.net`; blank or not `https://` (defence in depth: never a `javascript:` or `http:` href) → undefined. */
export function jiraSiteUrl(siteUrl: string | null | undefined): string | undefined {
  let origin = siteUrl?.trim() ?? "";
  while (origin.endsWith("/")) origin = origin.slice(0, -1);
  return origin.toLowerCase().startsWith("https://") ? origin : undefined;
}

/** `{siteUrl}/browse/{KEY}` for an issue key, or undefined when the site is unknown (Flow's `jiraBrowseUrl`). */
export function jiraBrowseUrl(siteUrl: string | null | undefined, issueKey: string): string | undefined {
  const origin = jiraSiteUrl(siteUrl);
  return origin === undefined ? undefined : `${origin}/browse/${encodeURIComponent(issueKey)}`;
}
