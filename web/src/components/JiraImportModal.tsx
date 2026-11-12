import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Button, Group, Loader, Modal, Stack, Text } from "@mantine/core";
import { useJiraImport } from "../hooks/useJiraImport";
import { emptyScope, toApplyRequest, toScope, type ImportConnection, type ImportRoot, type ImportSource, type ScopeForm } from "../utils/jiraImport";
import JiraImportOutcomeStep from "./JiraImportOutcomeStep";
import JiraImportPreviewStep from "./JiraImportPreviewStep";
import JiraImportScopeStep from "./JiraImportScopeStep";

const PHASE_NUMBER = { scope: 1, preview: 2, outcome: 3 } as const;

/**
 * Import from Jira (1.2): the connection page's modal, in three phases - scope, preview, outcome - on one wide `Modal` (not a Stepper). Nothing
 * is written before the third. Reading Jira can take minutes, so that wait is visible and stoppable (a preview only: an apply is never
 * cancelled, so the dialog cannot be closed while one runs). Every failure is inline; the caller refreshes the plan after an apply
 * (`useJiraImport`). The owner opens it with `opened` already true and calls `useDialogFocus(open)`, so the focus returns to its button.
 * Four entry points: the connection page (ADMIN; `source` is its one connection, the stream is a free pick), the Plan page's work-stream menu
 * (a stream's owner; `source` is the usable connections of the deviations view, `initialWorkStreamId` presets the stream, read-only) and, new in
 * 1.14, the two ROOTED ones: with a `root` (a linked program from the Plan page's program menu, or a linked project from the project page's header)
 * it imports only what Jira lists under that node's item: the stream is the root's own, the connection is the one the link goes through (the only
 * one offered; not among the usable ones, the scope step says an administrator has to fix it; a root known gone says so up front), the owner opens
 * at the node's own, and the request carries `root` instead of the keys and the default program. The connection is preselected when exactly one is
 * offered (the bind dialog's rule); changing it resets the Jira projects to the new one's keys. Each mount site keys the modal by its source
 * (`stream:<id>`, `program:<id>`, `project:<id>`), so the state below starts afresh for every import.
 */
export default function JiraImportModal({
  source,
  initialWorkStreamId,
  root,
  onClose,
}: {
  source: ImportSource;
  initialWorkStreamId?: number;
  root?: ImportRoot;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const offered = (source.connections ?? []).filter((candidate) => root === undefined || candidate.id === root.connectionId);
  const scopeSource: ImportSource = root === undefined || source.connections === null ? source : { ...source, connections: offered };
  const [chosen, setChosen] = useState<string | null>(null);
  // A chosen id that left the list (a refetch dropped it) is ignored: the single remaining connection is auto-picked again, several wait for a pick.
  const chosenId = offered.some((candidate) => String(candidate.id) === chosen) ? chosen : offered.length === 1 ? String(offered[0].id) : null;
  const picked = offered.find((candidate) => String(candidate.id) === chosenId) ?? null;
  // The connection of the preview and outcome phases stays known even if a later refetch of the source drops it (only its site is read there).
  const [known, setKnown] = useState<ImportConnection | null>(picked);
  if (picked !== null && picked !== known) setKnown(picked);
  const connection = picked ?? known;
  const run = useJiraImport(connection?.id ?? null);
  const [form, setForm] = useState<ScopeForm>(() => emptyScope(connection?.projectKeys ?? [], root?.workStreamId ?? initialWorkStreamId, root?.owner));
  const [keysOf, setKeysOf] = useState<number | null>(connection?.id ?? null);
  if (picked !== null && picked.id !== keysOf) {
    setKeysOf(picked.id);
    setForm((previous) => ({ ...previous, keys: [...picked.projectKeys] }));
  }
  const applying = run.busy === "apply";
  const { phase, preview } = run;

  function previewScope() {
    const scope = connection === null ? null : toScope(form, connection.projectKeys, root);
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
            source={scopeSource}
            connection={picked}
            root={root}
            streamLocked={initialWorkStreamId !== undefined}
            form={form}
            failure={run.failure}
            reading={run.busy === "preview"}
            onChange={(patch) => setForm((previous) => ({ ...previous, ...patch }))}
            onPickConnection={setChosen}
            onPreview={previewScope}
            onClose={onClose}
          />
        )}
        {phase === "preview" && preview !== null && connection !== null && (
          <JiraImportPreviewStep
            key={preview.data.asOf}
            connection={connection}
            root={root}
            preview={preview}
            busy={run.busy}
            failure={run.failure}
            onApply={(ticks, overrides) => void run.runApply(toApplyRequest(preview.scope, preview.data.items, ticks, overrides))}
            onBack={run.back}
            onPreviewAgain={previewAgain}
          />
        )}
        {phase === "outcome" && run.result !== null && connection !== null && (
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
