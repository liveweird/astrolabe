import { useTranslation } from "react-i18next";
import { Group, Text } from "@mantine/core";
import JiraKeyLink from "./JiraKeyLink";

/**
 * A binding's CURRENT Jira key as the link, plus a small muted "was OLD-1" when the key the issue was last read under differs from it (a
 * moved issue: the binding follows the key a probe answered, `jira-sync.md`). The pair is one group named "NEW-1, was OLD-1"; with no
 * previous key, or the same one, it is just the link. The caller passes `previousKey` (a deviation row's `jira.previousKey`, or a binding's
 * `observation.issueKey`).
 */
export default function JiraKeyWithPrevious({
  issueKey,
  previousKey,
  siteUrl,
  underline = "hover",
}: {
  issueKey: string;
  previousKey: string | null | undefined;
  siteUrl: string | null | undefined;
  underline?: "hover" | "always";
}) {
  const { t } = useTranslation();
  const link = (
    <Text size="sm" fw={500}>
      <JiraKeyLink issueKey={issueKey} siteUrl={siteUrl} underline={underline} />
    </Text>
  );
  if (!previousKey || previousKey === issueKey) return link;
  return (
    <Group gap={6} wrap="wrap" role="group" aria-label={t("jira.link.keyWas", { key: issueKey, previous: previousKey })}>
      {link}
      <Text size="xs" c="dimmed">
        {t("jira.link.was", { key: previousKey })}
      </Text>
    </Group>
  );
}
