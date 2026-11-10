import { useTranslation } from "react-i18next";
import { Button, Select, Stack, Text } from "@mantine/core";
import type { ImportConnection, ImportSource } from "../utils/jiraImport";
import FormErrorAlert from "./FormErrorAlert";

/**
 * The scope step's connection block, `JiraBindDialog`'s source-driven pick: loading text, a failed alert with Retry, a "none usable" note, or the
 * Select of the offered connections (read-only when there is exactly one, which the modal preselects). The source lists usable connections
 * only (enabled, mapping fitting), so a name needs no mark.
 */
export default function JiraImportConnectionField({
  source,
  selected,
  disabled,
  onPick,
}: {
  source: ImportSource;
  selected: ImportConnection | null;
  disabled: boolean;
  onPick: (id: string | null) => void;
}) {
  const { t } = useTranslation();
  const { connections } = source;
  if (connections === null) {
    return source.failed ? (
      <Stack gap="xs" align="flex-start">
        <FormErrorAlert>{t("jira.bind.loadFailed")}</FormErrorAlert>
        <Button variant="default" size="xs" onClick={source.retry}>
          {t("jira.bind.retry")}
        </Button>
      </Stack>
    ) : (
      <Text size="sm">{t("jira.bind.loading")}</Text>
    );
  }
  if (connections.length === 0) {
    return (
      <Text size="sm" role="note">
        {t("jira.import.scope.noConnection")}
      </Text>
    );
  }
  return (
    <Stack gap={4}>
      <Select
        label={t("jira.bind.connection")}
        data={connections.map((connection) => ({ value: String(connection.id), label: connection.name }))}
        value={selected === null ? null : String(selected.id)}
        onChange={onPick}
        allowDeselect={false}
        readOnly={connections.length === 1 && selected !== null}
        withAsterisk
        disabled={disabled}
      />
      {selected === null && (
        <Text size="xs" role="note">
          {t("jira.bind.pickConnection")}
        </Text>
      )}
    </Stack>
  );
}
