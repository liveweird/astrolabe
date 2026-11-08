import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Alert, Button, Checkbox, Group, Modal, Stack, Switch, Table, Text, Title } from "@mantine/core";
import { useMutation, useQuery } from "@tanstack/react-query";
import { applyCapacityImport, previewCapacityImport, type CapacityApplyResponse, type CapacityPreview, type CapacityPreviewItem } from "../api/flow";
import { applyRequest, defaultTicks, importFailure, infoSentence, isClosed, isImportable, outcomeSentence } from "../utils/capacityImport";
import FormErrorAlert from "./FormErrorAlert";
import LoadingBlock from "./LoadingBlock";
import ScrollRegion from "./ScrollRegion";

/** A refused preview or apply: the fixed lead for the status and, for a 400, the server's own sentence under it. */
function FailureAlert({ failure, title }: { failure: { message: string; detail?: string }; title?: string }) {
  return (
    <FormErrorAlert title={title}>
      <Text size="sm">{failure.message}</Text>
      {failure.detail && (
        <Text size="sm" mt={4}>
          {failure.detail}
        </Text>
      )}
    </FormErrorAlert>
  );
}

const STATES = new Set(["closed", "active", "future"]);

/** The note column of one row: why it is left alone, then the infos (a hand-entered period inside the sprint, a zero figure, a window over Flow's 60-day cap) and the closed hint. */
function RowNotes({ item, from }: { item: CapacityPreviewItem; from: string }) {
  const { t } = useTranslation();
  const notes: string[] = [];
  if (item.action === "SKIP" && item.reason !== null) notes.push(t(`flow.import.reason.${item.reason}`));
  if (item.action === "MANUAL_PERIOD") notes.push(t("flow.import.reason.MANUAL_PERIOD"));
  if (item.action === "UNCHANGED") notes.push(t("flow.import.reason.UNCHANGED"));
  for (const info of item.infos) notes.push(infoSentence(info, item, t));
  if (isImportable(item) && isClosed(item, from)) notes.push(t("flow.import.closedNote", { from }));
  return (
    <Stack gap={2}>
      {notes.map((note) => (
        <Text key={note} size="xs">
          {note}
        </Text>
      ))}
    </Stack>
  );
}

function ItemRow({ item, from, checked, disabled, onToggle }: { item: CapacityPreviewItem; from: string; checked: boolean; disabled: boolean; onToggle: () => void }) {
  const { t } = useTranslation();
  const importable = isImportable(item);
  const doing = item.action === "CREATE" || item.action === "UPDATE";
  return (
    <Table.Tr>
      <Table.Td>
        {importable && <Checkbox checked={checked} disabled={disabled} onChange={onToggle} aria-label={t("flow.import.selectRow", { name: item.name })} />}
      </Table.Td>
      <Table.Td>
        <Text size="sm" fw={500}>
          {item.name}
        </Text>
        <Text size="xs" c="dimmed">
          {STATES.has(item.state) ? t(`flow.import.state.${item.state as "closed" | "active" | "future"}`) : item.state}
        </Text>
      </Table.Td>
      <Table.Td>
        {item.start === null || item.end === null ? "—" : `${item.start} – ${item.end}`}
        {item.effectiveFrom !== null && item.effectiveFrom !== item.start && (
          <Text size="xs" c="dimmed">
            {t("flow.import.effectiveFromNote", { date: item.effectiveFrom })}
          </Text>
        )}
      </Table.Td>
      <Table.Td ta="right">{item.workingDays ?? "—"}</Table.Td>
      <Table.Td ta="right">{item.flowMd ?? "—"}</Table.Td>
      <Table.Td ta="right">
        {item.mdPerWeek === null ? "—" : item.mdPerWeek.toFixed(2)}
        {item.action === "UPDATE" && item.existing !== null && (
          <Text size="xs" c="dimmed">
            {t("flow.import.was", { md: item.existing.mdPerWeek.toFixed(2) })}
          </Text>
        )}
      </Table.Td>
      <Table.Td>
        <Text size="sm" fw={doing ? 600 : 400}>
          {t(`flow.import.action.${item.action}`)}
        </Text>
      </Table.Td>
      <Table.Td>
        <RowNotes item={item} from={from} />
      </Table.Td>
    </Table.Tr>
  );
}

/** The plan with the person's ticks. Remounted per fresh preview (the parent keys it), so the ticks always start from the server's `ticked` and no removals. */
function PreviewBody({ preview, busy, onImport }: { preview: CapacityPreview; busy: boolean; onImport: (ticked: ReadonlySet<number>, removals: ReadonlySet<number>) => void }) {
  const { t } = useTranslation();
  const [ticked, setTicked] = useState<ReadonlySet<number>>(() => defaultTicks(preview));
  const [removals, setRemovals] = useState<ReadonlySet<number>>(() => new Set());
  const flip = (set: ReadonlySet<number>, id: number) => {
    const next = new Set(set);
    if (!next.delete(id)) next.add(id);
    return next;
  };
  const selected = applyRequest(preview, ticked, removals);
  const creating = selected.items.filter((item) => item.expected.action === "CREATE").length;
  const total = selected.items.length + selected.removals.length;
  const label = t("flow.import.previewAria");
  const removalsLabel = t("flow.import.removalsAria");
  return (
    <Stack gap="md">
      {preview.items.length === 0 ? (
        <Text size="sm" c="dimmed">
          {t("flow.import.empty")}
        </Text>
      ) : (
        <ScrollRegion label={label} minWidth={860} maxHeight="45vh">
          <Table aria-label={label} stickyHeader>
            <Table.Thead>
              <Table.Tr>
                <Table.Th>{t("flow.import.column.select")}</Table.Th>
                <Table.Th>{t("flow.import.column.sprint")}</Table.Th>
                <Table.Th>{t("flow.import.column.dates")}</Table.Th>
                <Table.Th ta="right">{t("flow.import.column.workingDays")}</Table.Th>
                <Table.Th ta="right">{t("flow.import.column.flowMd")}</Table.Th>
                <Table.Th ta="right">{t("flow.import.column.mdPerWeek")}</Table.Th>
                <Table.Th>{t("flow.import.column.action")}</Table.Th>
                <Table.Th>{t("flow.import.column.note")}</Table.Th>
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {preview.items.map((item) => (
                <ItemRow key={item.sprintId} item={item} from={preview.from} checked={ticked.has(item.sprintId)} disabled={busy} onToggle={() => setTicked(flip(ticked, item.sprintId))} />
              ))}
            </Table.Tbody>
          </Table>
        </ScrollRegion>
      )}
      {preview.removals.length > 0 && (
        <Stack gap="xs">
          <Title order={3} size="h5">
            {t("flow.import.removalsTitle")}
          </Title>
          <Text size="sm" c="dimmed">
            {t("flow.import.removalsIntro")}
          </Text>
          <ScrollRegion label={removalsLabel} minWidth={480}>
            <Table aria-label={removalsLabel}>
              <Table.Thead>
                <Table.Tr>
                  <Table.Th>{t("flow.import.column.select")}</Table.Th>
                  <Table.Th>{t("flow.import.column.effectiveFrom")}</Table.Th>
                  <Table.Th ta="right">{t("flow.import.column.mdPerWeek")}</Table.Th>
                  <Table.Th>{t("flow.import.column.flowSprint")}</Table.Th>
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {preview.removals.map((removal) => (
                  <Table.Tr key={removal.periodId}>
                    <Table.Td>
                      <Checkbox
                        checked={removals.has(removal.periodId)}
                        disabled={busy}
                        onChange={() => setRemovals(flip(removals, removal.periodId))}
                        aria-label={t("flow.import.selectRemoval", { date: removal.effectiveFrom })}
                      />
                    </Table.Td>
                    <Table.Td>{removal.effectiveFrom}</Table.Td>
                    <Table.Td ta="right">{removal.mdPerWeek.toFixed(2)}</Table.Td>
                    <Table.Td>{removal.flowSprintName ?? "—"}</Table.Td>
                  </Table.Tr>
                ))}
              </Table.Tbody>
            </Table>
          </ScrollRegion>
        </Stack>
      )}
      <Text size="xs" c="dimmed">
        {t("flow.import.footer")}
      </Text>
      <Group justify="space-between" align="center" wrap="wrap" gap="sm">
        <Text size="sm" role="status">
          {t("flow.import.summary", { total, create: creating, update: selected.items.length - creating, remove: selected.removals.length })}
        </Text>
        <Button loading={busy} disabled={total === 0} onClick={() => onImport(ticked, removals)}>
          {t("flow.import.submit")}
        </Button>
      </Group>
    </Stack>
  );
}

/**
 * The capacity import for a linked Flow team: "Include closed sprints", the PREVIEW (`POST …/capacity-preview`, nothing stored) as a table with a
 * tick per CREATE / UPDATE row - the server's `ticked` is the default (closed, zero-capacity and long-window sprints start unticked), UNCHANGED, MANUAL_PERIOD and
 * SKIP rows have no tick - and the REMOVALS list (Flow periods no sprint reuses), never preselected. Import (`POST …/capacity-import`) sends exactly the
 * ticked rows with their `expected` and the `from` / `includeClosed` the preview echoed; the server re-runs the plan under the team lock, so a row
 * that moved meanwhile comes back skipped (`CHANGED`, data in a 200). The outcome (a polite status region that stays mounted; the focus moves to it once the fresh plan is read, because the plan replaces the table the Import button sat in) stays above a fresh preview. Team data: `onImported` refreshes the
 * capacity and the weekly load (`["plan"]`) and the capacity deviations (`["flow","deviations"]`), nothing else.
 */
export default function CapacityImportModal({ binding, onClose, onImported }: { binding: { id: number; flowTeamName: string }; onClose: () => void; onImported: () => Promise<void> }) {
  const { t } = useTranslation();
  const [includeClosed, setIncludeClosed] = useState(false);
  const [outcome, setOutcome] = useState<CapacityApplyResponse | null>(null);
  // The fresh plan replaces the table the Import button sat in, so the focus would fall to the body: it goes to the outcome note once the plan is read.
  const outcomeRef = useRef<HTMLDivElement>(null);
  const [outcomeFocus, setOutcomeFocus] = useState(0);
  useEffect(() => {
    if (outcomeFocus > 0) outcomeRef.current?.focus({ preventScroll: true });
  }, [outcomeFocus]);

  // A plan is read once per opening: it is the person's snapshot to tick, so no refocus or interval refetch may reset the ticks (and gcTime 0
  // makes a reopened modal read a fresh one).
  const preview = useQuery({
    queryKey: ["flow", "capacity-preview", binding.id, includeClosed],
    queryFn: () => previewCapacityImport(binding.id, { includeClosed }),
    gcTime: 0,
    staleTime: Infinity,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });
  const apply = useMutation({
    mutationFn: (body: ReturnType<typeof applyRequest>) => applyCapacityImport(binding.id, body),
    onSuccess: async (result) => {
      setOutcome(result);
      try {
        await onImported();
      } catch {
        // The import landed; a failed refresh of the page behind the modal must not hide its outcome (the page catches up on its next read).
      }
      await preview.refetch();
      setOutcomeFocus((n) => n + 1);
    },
  });
  const busy = apply.isPending || preview.isFetching;
  const failure = apply.isError ? importFailure(apply.error, t) : null;
  const loadFailure = preview.isError ? importFailure(preview.error, t) : null;

  return (
    <Modal
      closeButtonProps={{ "aria-label": t("common.action.close") }}
      // The apply writes in one transaction: closing mid-request would hide whether it landed.
      withCloseButton={!apply.isPending}
      closeOnEscape={!apply.isPending}
      closeOnClickOutside={!apply.isPending}
      opened
      onClose={onClose}
      title={t("flow.import.title")}
      size="xl"
      centered
    >
      <Stack gap="md">
        <Text size="sm" c="dimmed">
          {t("flow.import.intro")}
        </Text>
        <Switch
          label={t("flow.import.includeClosed")}
          checked={includeClosed}
          disabled={busy}
          onChange={(event) => {
            setIncludeClosed(event.currentTarget.checked);
            setOutcome(null);
            apply.reset();
          }}
          data-autofocus
        />
        {/* Always mounted, so a screen reader announces the text that appears in it. */}
        <div role="status" aria-live="polite">
          {outcome !== null && (
            <Alert ref={outcomeRef} tabIndex={-1} color={outcome.skipped.length > 0 ? "orange" : "green"} variant="light" role="note">
              {outcomeSentence(outcome, t)}
            </Alert>
          )}
        </div>
        {failure && <FailureAlert failure={failure} />}
        {loadFailure ? (
          <FailureAlert failure={loadFailure} title={t("flow.import.loadFailed")} />
        ) : preview.data === undefined ? (
          <LoadingBlock />
        ) : (
          <PreviewBody key={preview.dataUpdatedAt} preview={preview.data} busy={busy} onImport={(ticked, removals) => apply.mutate(applyRequest(preview.data, ticked, removals))} />
        )}
      </Stack>
    </Modal>
  );
}
