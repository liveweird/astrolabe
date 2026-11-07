import type { ReactNode } from "react";
import { Group, Text, VisuallyHidden } from "@mantine/core";
import { useTranslation } from "react-i18next";
import type { JiraLink, PlanFlag } from "../api/roadmap";
import { milestoneFlagLabel } from "../utils/flagSentences";
import { countFlags } from "../utils/roadmapRows";
import JiraKeyLink from "./JiraKeyLink";
import { FlagCountsCell } from "./PlanProjectCells";

// A milestone row's Jira link and open flags on the project and team pages (1.3): the key as an external link (out of the grid's tab order - the
// Deviations page has the same link) and the roadmap's icons (an orange triangle for warnings, a gray info circle for infos) whose accessible label is
// the flags' own sentences - colour and icon are never the only carrier. A linked row with no open flag (clean, acknowledged, or on a disabled
// connection) still shows its key, with "Linked to Jira: KEY" for assistive technology, so it is told apart from an unlinked one.

/**
 * The Flags column's cell and the tray's addition to the name: nothing for an unlinked row. `sites` is the view's `jiraSites` by connection id
 * (`siteUrls`): the key links to `{site}/browse/{KEY}` through `JiraKeyLink` (https only, plain text otherwise).
 */
export function MilestoneFlags({ flags, link, sites }: { flags: readonly PlanFlag[]; link: JiraLink | null; sites: ReadonlyMap<number, string> }) {
  const { t } = useTranslation();
  if (link === null && flags.length === 0) return null;
  return (
    <Group gap={6} wrap="nowrap">
      {link !== null && (
        <Text size="sm" component="span">
          {flags.length === 0 && <VisuallyHidden component="span">{t("deviations.link.linked", { key: link.issueKey })}</VisuallyHidden>}
          <JiraKeyLink issueKey={link.issueKey} siteUrl={sites.get(link.connectionId)} skipTab underline="always" />
        </Text>
      )}
      <FlagCountsCell counts={countFlags(flags)} label={milestoneFlagLabel(t, flags, link?.issueKey ?? null)} />
    </Group>
  );
}

/** A tray row's name cell with the row's Jira key and flag icon beside it (the tray has no Flags column); an unlinked row's name is exactly as it was. */
export function NameWithFlags({
  flags,
  link,
  sites,
  children,
}: {
  flags: readonly PlanFlag[];
  link: JiraLink | null;
  sites: ReadonlyMap<number, string>;
  children: ReactNode;
}) {
  if (link === null && flags.length === 0) return <>{children}</>;
  return (
    <Group gap={6} wrap="nowrap" style={{ minWidth: 0 }}>
      {children}
      <MilestoneFlags flags={flags} link={link} sites={sites} />
    </Group>
  );
}
