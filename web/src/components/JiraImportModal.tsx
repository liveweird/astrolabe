import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Button, Group, Loader, Modal, Stack, Text } from "@mantine/core";
import { useJiraImport } from "../hooks/useJiraImport";
import type { JiraImportMatch } from "../api/jira";
import { emptyScope, type PreviewCarry, toApplyRequest, toScope, type ImportConnection, type ImportRoot, type ImportSource, type ScopeForm, withMatches } from "../utils/jiraImport";
import JiraImportOutcomeStep from "./JiraImportOutcomeStep";
import JiraImportPreviewStep from "./JiraImportPreviewStep";
import JiraImportScopeStep from "./JiraImportScopeStep";

const PHASE_NUMBER = { scope: 1, preview: 2, outcome: 3 } as const;

/**
 * Import from Jira (1.2): the connection page's modal, in three phases - scope, preview, outcome - on one wide `Modal` (not a Stepper). Nothing
 * is written before the third. Reading Jira can take minutes, so that wait is visible and stoppable (a preview only: an apply is never
 * cancelled, so the dialog cannot be closed while one runs). Every failure is inline; the caller refreshes the plan after an apply
 * (`useJiraImport`). The owner opens it with `opened` already true and calls `useDialogFocus(open)`, so the focus returns to its button.
 * Six entry points: the connection page's button (ADMIN; `source` is its one connection, the stream is a free pick), the Plan page's work-stream menu
 * (a stream's owner; `source` is the usable connections of the deviations view, `initialWorkStreamId` presets the stream, read-only) and the four
 * ROOTED ones (1.14, 1.15): with a `root` (a linked program from the Plan page's program menu, a linked project from the Plan page's project row
 * menu or the project page's header, or a program or project row of the connection page's links list) it imports only what Jira lists under that node's item: the stream is the root's own, the connection is the one the link goes through (the only
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

  // The work of a match-driven "Preview again" (1.15), handed to the NEXT preview step only; any other preview starts afresh.
  const [carry, setCarry] = useState<PreviewCarry | null>(null);

  function previewScope() {
    const scope = connection === null ? null : toScope(form, connection.projectKeys, root);
    if (scope === null) return;
    setCarry(null);
    void run.runPreview(scope);
  }

  // Reads again under the scope the rows were read under; `matches` (the preview step's pending changes applied) replaces its confirmed matches (1.15).
  const previewAgain = (matches?: readonly JiraImportMatch[], keep?: PreviewCarry) => {
    if (preview === null) return;
    setCarry(keep ?? null);
    void run.runPreview(matches === undefined ? preview.scope : withMatches(preview.scope, matches));
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
            key={run.previewSeq}
            connection={connection}
            root={root}
            owner={form.owner?.value === String(preview.scope.ownerPersonId) ? form.owner : null}
            preview={preview}
            carry={carry}
            busy={run.busy}
            failure={run.failure}
            onApply={(ticks, teams, owners) => void run.runApply(toApplyRequest(preview.scope, preview.data.items, ticks, teams, owners))}
            onBack={run.back}
            onPreviewAgain={previewAgain}
          />
        )}
        {phase === "outcome" && run.result !== null && connection !== null && (
          <JiraImportOutcomeStep connection={connection} result={run.result} busy={run.busy !== null} failure={run.failure} onPreviewAgain={() => previewAgain()} onClose={onClose} />
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
