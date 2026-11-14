import { useTranslation } from "react-i18next";
import { Button, Text } from "@mantine/core";
import type { JiraImportItem } from "../api/jira";
import { hasSuggestion, isConfirmedMatch, type MatchChange } from "../utils/jiraImport";

/**
 * The match controls of one preview row (1.15), in two parts of the Action cell so the row keeps its fixed height: the `button` sits beside the
 * badge, the `line` is ONE clamped sentence under it (the full text in its `title`). A CREATE row with a `suggestion` says what it looks like and
 * offers "Link instead"; a BIND row the user confirmed (`MATCH_CONFIRMED`) offers "Create instead" (its info already says why it is linked). Either
 * click only records a pending change: the line then says what will happen "after the next preview" and the button becomes "Undo". Nothing is sent
 * from here, and a row with neither shape renders nothing. Every aria-label starts with its visible text.
 */
export default function JiraImportRowMatch({
  part,
  item,
  change,
  disabled,
  onChange,
}: {
  part: "button" | "line";
  item: JiraImportItem;
  change: MatchChange | undefined;
  disabled: boolean;
  onChange: (change: MatchChange | null) => void;
}) {
  const { t } = useTranslation();
  const key = item.issueKey ?? item.jiraId;
  const name = item.suggestion?.nodeName ?? "";
  const suggested = hasSuggestion(item);
  if (change === undefined && !suggested && !isConfirmedMatch(item)) return null;
  if (part === "line") {
    const line = change === "link" ? t("jira.import.row.matchPendingLink", { name }) : change === "create" ? t("jira.import.row.matchPendingCreate") : suggested ? t("jira.import.row.suggestion", { name }) : null;
    return line === null ? null : (
      <Text size="xs" lineClamp={1} title={line}>
        {line}
      </Text>
    );
  }
  if (change !== undefined) {
    return (
      <Button variant="subtle" size="compact-xs" flex="none" aria-label={t("jira.import.row.undoMatchAria", { key })} onClick={() => onChange(null)} disabled={disabled}>
        {t("jira.import.row.undoMatch")}
      </Button>
    );
  }
  return suggested ? (
    <Button variant="default" size="compact-xs" flex="none" aria-label={t("jira.import.row.linkInsteadAria", { key, name })} onClick={() => onChange("link")} disabled={disabled}>
      {t("jira.import.row.linkInstead")}
    </Button>
  ) : (
    <Button variant="default" size="compact-xs" flex="none" aria-label={t("jira.import.row.createInsteadAria", { key })} onClick={() => onChange("create")} disabled={disabled}>
      {t("jira.import.row.createInstead")}
    </Button>
  );
}
