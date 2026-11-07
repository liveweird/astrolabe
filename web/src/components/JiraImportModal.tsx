import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Button, Group, Loader, Modal, Stack, Text } from "@mantine/core";
import type { JiraConnection } from "../api/jira";
import { useJiraImport } from "../hooks/useJiraImport";
import { emptyScope, toApplyRequest, toScope, type ScopeForm } from "../utils/jiraImport";
import JiraImportOutcomeStep from "./JiraImportOutcomeStep";
import JiraImportPreviewStep from "./JiraImportPreviewStep";
import JiraImportScopeStep from "./JiraImportScopeStep";

const PHASE_NUMBER = { scope: 1, preview: 2, outcome: 3 } as const;

/**
 * Import from Jira (1.2): the connection page's modal, in three phases - scope, preview, outcome - on one wide `Modal` (not a Stepper). Nothing
 * is written before the third. Reading Jira can take minutes, so that wait is visible and stoppable (a preview only: an apply is never
 * cancelled, so the dialog cannot be closed while one runs). Every failure is inline; the caller refreshes the plan after an apply
 * (`useJiraImport`). The owner opens it with `opened` already true and calls `useDialogFocus(open)`, so the focus returns to its button.
 */
export default function JiraImportModal({ connection, onClose }: { connection: JiraConnection; onClose: () => void }) {
  const { t } = useTranslation();
  const run = useJiraImport(connection.id);
  const [form, setForm] = useState<ScopeForm>(() => emptyScope(connection.projectKeys));
  const applying = run.busy === "apply";
  const { phase, preview } = run;

  function previewScope() {
    const scope = toScope(form, connection.projectKeys);
    if (scope !== null) void run.runPreview(scope);
  }

  const previewAgain = () => {
    if (preview !== null) void run.runPreview(preview.scope);
  };

  return (
    <Modal
      opened
      onClose={onClose}
      title={t("jira.import.title")}
      size={1000}
      centered
      closeButtonProps={{ "aria-label": t("common.action.close") }}
      // An apply in flight cannot be cancelled and may still land: the dialog stays until its outcome is on screen.
      withCloseButton={!applying}
      closeOnEscape={!applying}
      closeOnClickOutside={false}
    >
      <Stack gap="sm">
        <Text size="xs" c="dimmed">
          {t("jira.import.step", { n: PHASE_NUMBER[phase], name: t(`jira.import.stepName.${phase}`) })}
        </Text>
        {phase === "scope" && (
          <JiraImportScopeStep
            connection={connection}
            form={form}
            failure={run.failure}
            reading={run.busy === "preview"}
            onChange={(patch) => setForm((previous) => ({ ...previous, ...patch }))}
            onPreview={previewScope}
            onClose={onClose}
          />
        )}
        {phase === "preview" && preview !== null && (
          <JiraImportPreviewStep
            key={preview.data.asOf}
            connection={connection}
            preview={preview}
            busy={run.busy}
            failure={run.failure}
            onApply={(ticks, overrides) => void run.runApply(toApplyRequest(preview.scope, preview.data.items, ticks, overrides))}
            onBack={run.back}
            onPreviewAgain={previewAgain}
          />
        )}
        {phase === "outcome" && run.result !== null && (
          <JiraImportOutcomeStep connection={connection} result={run.result} busy={run.busy !== null} failure={run.failure} onPreviewAgain={previewAgain} onClose={onClose} />
        )}
        {run.busy === "preview" && (
          <Group gap="xs" role="status">
            <Loader size="xs" />
            <Text size="sm">{t("jira.import.reading")}</Text>
            <Button variant="default" size="compact-sm" onClick={run.cancelPreview}>
              {t("jira.import.stopReading")}
            </Button>
          </Group>
        )}
      </Stack>
    </Modal>
  );
}
