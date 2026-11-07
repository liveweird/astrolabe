import { useTranslation } from "react-i18next";
import { Button, Text } from "@mantine/core";
import type { ImportFailure } from "../utils/jiraImportText";
import FormErrorAlert from "./FormErrorAlert";

/** An inline failure of either import call: the fixed lead, the server's own sentence under it, and "Preview again" when a new read is the way on. Never a toast. */
export default function JiraImportFailureAlert({ failure, onPreviewAgain, disabled }: { failure: ImportFailure; onPreviewAgain?: () => void; disabled?: boolean }) {
  const { t } = useTranslation();
  return (
    <FormErrorAlert>
      <Text size="sm">{failure.message}</Text>
      {failure.detail && (
        <Text size="sm" mt={4}>
          {failure.detail}
        </Text>
      )}
      {failure.repreview && onPreviewAgain && (
        <Button mt="xs" variant="default" size="compact-sm" onClick={onPreviewAgain} disabled={disabled}>
          {t("jira.import.previewAgain")}
        </Button>
      )}
    </FormErrorAlert>
  );
}
