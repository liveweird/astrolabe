import { useTranslation } from "react-i18next";
import { Anchor, VisuallyHidden } from "@mantine/core";
import { IconExternalLink } from "@tabler/icons-react";
import { jiraBrowseUrl } from "../utils/jiraLinks";

/**
 * A Jira issue key as a link to the issue (`{siteUrl}/browse/{KEY}`) in a new tab: `rel="noopener noreferrer"`, an external-link icon and
 * a visually hidden "(opens in Jira)". The caller passes the connection's site (the connection page, a binding's connection); with no
 * usable `https://` site the key is plain text. Inherits the surrounding font size and weight. Flow's `JiraKeyLink`, which resolved the
 * site from a cache of connections; here the caller always knows it.
 */
export default function JiraKeyLink({
  issueKey,
  siteUrl,
  iconOnly = false,
  skipTab = false,
  underline = "hover",
}: {
  issueKey: string;
  siteUrl: string | null | undefined;
  /** An icon-only link (no key text) for a key that is already printed. */
  iconOnly?: boolean;
  /** Takes the link out of the tab order (a roving-tab-stop grid, where the keyboard has the same link elsewhere). */
  skipTab?: boolean;
  /** `always` where the key sits inline with other text ("KEY summary"), so the link is told apart without colour (axe `link-in-text-block`). */
  underline?: "hover" | "always";
}) {
  const { t } = useTranslation();
  const href = jiraBrowseUrl(siteUrl, issueKey);
  if (href === undefined) return iconOnly ? null : <>{issueKey}</>;
  return (
    <Anchor href={href} target="_blank" rel="noopener noreferrer" inherit underline={underline} tabIndex={skipTab ? -1 : undefined}>
      {!iconOnly && issueKey}
      <IconExternalLink size="0.85em" aria-hidden style={{ marginInlineStart: "0.25em", verticalAlign: "-0.1em" }} />
      <VisuallyHidden component="span">
        {iconOnly ? t("jira.link.openKeyInJira", { key: issueKey }) : ` ${t("jira.link.opensInJira")}`}
      </VisuallyHidden>
    </Anchor>
  );
}
