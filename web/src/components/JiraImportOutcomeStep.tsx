import { useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { Alert, Badge, Button, Group, Stack, Table, Text, Title } from "@mantine/core";
import type { JiraImportResult } from "../api/jira";
import type { ImportConnection } from "../utils/jiraImport";
import { reasonText, type ImportFailure } from "../utils/jiraImportText";
import JiraImportFailureAlert from "./JiraImportFailureAlert";
import JiraImportVirtualTable from "./JiraImportVirtualTable";
import JiraKeyLink from "./JiraKeyLink";

const SKIPPED_ROW_HEIGHT = 48;

/**
 * The third phase: what the apply did, honestly. The counts (created, linked, scheduled, skipped), every skipped row with its reason in
 * words (the list is virtualised: a re-import skips every row), and a way back to a fresh preview when rows changed since the one the user
 * ticked. The heading takes the focus when the phase opens, so a screen reader starts at the result rather than on a vanished button.
 */
export default function JiraImportOutcomeStep({
  connection,
  result,
  busy,
  failure,
  onPreviewAgain,
  onClose,
}: {
  connection: ImportConnection;
  result: JiraImportResult;
  busy: boolean;
  failure: ImportFailure | null;
  onPreviewAgain: () => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const headingRef = useRef<HTMLHeadingElement>(null);
  useEffect(() => headingRef.current?.focus(), []);
  const { created, bound, skipped } = result;
  const scheduled = created.filter((row) => row.scheduled).length;
  const changed = skipped.filter((row) => row.reason === "CHANGED").length;
  const notable = skipped.some((row) => row.reason !== "ALREADY_BOUND");
  const wrote = created.length + bound.length > 0;

  return (
    <Stack gap="sm">
      <Title order={3} size="h4" ref={headingRef} tabIndex={-1}>
        {t("jira.import.outcome.title")}
      </Title>
      <Group gap="xs" role="status">
        <Badge color="green" variant="light" tt="none">
          {t("jira.import.outcome.created", { n: created.length })}
        </Badge>
        <Badge color="green" variant="light" tt="none">
          {t("jira.import.outcome.bound", { n: bound.length })}
        </Badge>
        <Badge color="gray" variant="light" tt="none">
          {t("jira.import.outcome.scheduled", { n: scheduled })}
        </Badge>
        <Badge color={notable ? "orange" : "gray"} variant="light" tt="none">
          {t("jira.import.outcome.skipped", { n: skipped.length })}
        </Badge>
      </Group>
      <Text size="sm">{wrote ? t("jira.import.outcome.wrote") : t("jira.import.outcome.nothing")}</Text>
      {changed > 0 && (
        <Alert color="orange" variant="light" role="note">
          <Text size="sm">{t("jira.import.outcome.changed", { count: changed })}</Text>
          <Button mt="xs" variant="default" size="compact-sm" onClick={onPreviewAgain} disabled={busy}>
            {t("jira.import.previewAgain")}
          </Button>
        </Alert>
      )}
      {failure && <JiraImportFailureAlert failure={failure} />}
      {skipped.length > 0 && (
        <Stack gap="xs">
          <Title order={4} size="h5">
            {t("jira.import.outcome.skippedTitle")}
          </Title>
          <JiraImportVirtualTable
            label={t("jira.import.outcome.skippedAria")}
            count={skipped.length}
            rowHeight={SKIPPED_ROW_HEIGHT}
            minWidth={560}
            maxHeight={320}
            columns={2}
            header={
              <Table.Tr aria-rowindex={1}>
                <Table.Th w={160}>{t("jira.import.preview.column.item")}</Table.Th>
                <Table.Th>{t("jira.import.outcome.column.why")}</Table.Th>
              </Table.Tr>
            }
            renderRow={(index, rowProps) => {
              const row = skipped[index];
              return (
                <Table.Tr {...rowProps}>
                  <Table.Td>
                    <Text size="sm" fw={500}>
                      {row.issueKey ? <JiraKeyLink issueKey={row.issueKey} siteUrl={connection.siteUrl} /> : t("jira.import.outcome.unknownItem", { id: row.jiraId })}
                    </Text>
                  </Table.Td>
                  <Table.Td>
                    <Text size="sm" lineClamp={2} title={reasonText(row.reason, t)}>
                      {reasonText(row.reason, t)}
                    </Text>
                  </Table.Td>
                </Table.Tr>
              );
            }}
          />
        </Stack>
      )}
      <Group justify="flex-end">
        <Button onClick={onClose}>{t("common.action.close")}</Button>
      </Group>
    </Stack>
  );
}
