import { useTranslation } from "react-i18next";
import { Button, Group, Stack, Switch, Text } from "@mantine/core";

/**
 * The preview step's match notes (1.15): the count of suggestions with the "Possible matches only" switch, the extra sentence under an active
 * filter, and, while changes to the matches wait, the `role="note"` banner whose "Preview again" re-reads Jira with the new `matches`. The banner
 * is a plain note (never an `Alert`, whose implicit `role="alert"` would interrupt) and the only "Preview again" button on screen while it shows.
 * Nothing renders when the preview offers no match choice and no change waits.
 */
export default function JiraImportMatchNote({
  suggestions,
  hasChoices,
  filtered,
  onlyMatches,
  onOnlyMatches,
  pendingCount,
  onPreviewAgain,
  locked,
}: {
  /** Rows carrying a suggestion. */
  suggestions: number;
  /** Rows that offer a match choice at all (a suggestion or a confirmed link): the switch narrows to them. */
  hasChoices: boolean;
  /** The preview was read under an import filter, which hides items from the matcher. */
  filtered: boolean;
  onlyMatches: boolean;
  onOnlyMatches: (on: boolean) => void;
  pendingCount: number;
  onPreviewAgain: () => void;
  locked: boolean;
}) {
  const { t } = useTranslation();
  if (!hasChoices && pendingCount === 0) return null;
  return (
    <Stack gap="xs">
      {hasChoices && (
        <Group gap="md" align="center">
          {suggestions > 0 && (
            <Text size="sm" role="note">
              {t("jira.import.preview.matches", { count: suggestions })}
              {filtered ? ` ${t("jira.import.preview.matchesFilter")}` : ""}
            </Text>
          )}
          <Switch label={t("jira.import.preview.matchesOnly")} checked={onlyMatches} onChange={(event) => onOnlyMatches(event.currentTarget.checked)} />
        </Group>
      )}
      {pendingCount > 0 && (
        <Group gap="sm" align="center" role="note">
          <Text size="sm">{t("jira.import.preview.matchesPending", { count: pendingCount })}</Text>
          <Button variant="default" size="compact-sm" onClick={onPreviewAgain} disabled={locked}>
            {t("jira.import.previewAgain")}
          </Button>
        </Group>
      )}
    </Stack>
  );
}
