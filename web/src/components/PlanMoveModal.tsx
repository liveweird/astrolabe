import { useState } from "react";
import { Button, Group, Modal, Select, Stack, Text, type ComboboxItem, type ComboboxItemGroup } from "@mantine/core";
import { useTranslation } from "react-i18next";
import { ApiError } from "../api/http";
import { moveProgram, moveProject } from "../api/plan";
import { hasTarget } from "../utils/planMove";
import { saveErrorMessage } from "../utils/saveError";
import { showSuccessToast } from "../utils/toast";
import FormErrorAlert from "./FormErrorAlert";

/**
 * "Move to…": reparent a project under another program, or a program under another work stream (the server's `POST …/move`).
 * The page computes the eligible targets from the plan view's `can` flags (`utils/planMove.ts`) and hands them in; the server re-checks
 * both halves of the rule. Failures stay in the dialog, in words, never a toast:
 *  - 409 (a project of that name exists in the target program): the dialog stays open to pick another program;
 *  - 400 (the target is gone) and 403 (rights changed): the message shows and the plan is reloaded — the options follow it, and a
 *    pick the reload took away is dropped; Move stays disabled until the reload is done, and stays so when the reloaded node no
 *    longer has `can.move` (`forbidden`: the 403's message is kept, no retry loop);
 *  - 404 (the node itself is gone): the dialog closes and the plan reloads.
 * `node`, `parentName`, `data` and `forbidden` are the page's reading of the CURRENT view (the page keeps only the node's id).
 */
export default function PlanMoveModal({
  kind,
  node,
  parentName,
  data,
  forbidden,
  onDone,
  onRefresh,
  onClose,
}: {
  kind: "project" | "program";
  node: { id: number; name: string };
  /** The node's current parent, named in the dialog ("Currently in program …"). */
  parentName: string;
  /** The eligible targets: programs grouped by work stream (a project), or work streams (a program). */
  data: ComboboxItem[] | ComboboxItemGroup<ComboboxItem>[];
  /** The node's live `can.move` is false: the caller may no longer move it. */
  forbidden: boolean;
  /** The move happened (or the node is gone): close the dialog and reload the plan. */
  onDone: () => Promise<void>;
  /** The plan changed under the dialog: reload it, keep the dialog. */
  onRefresh: () => Promise<void>;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const [value, setValue] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldError, setFieldError] = useState<string | null>(null);
  const isProject = kind === "project";
  const picked = hasTarget(data, value) ? value : null;
  const noTargets = data.length === 0;
  // A failure's message wins; without one, a node that lost `can.move` says so (the same words as a 403).
  const shownError = error ?? (forbidden ? t("plan.move.forbidden") : null);

  async function submit() {
    if (picked === null) {
      setFieldError(t("plan.move.targetRequired"));
      return;
    }
    setError(null);
    setSubmitting(true);
    try {
      await (isProject ? moveProject(node.id, Number(picked)) : moveProgram(node.id, Number(picked)));
    } catch (err) {
      try {
        await fail(err);
      } finally {
        // Only after the reload: Move must not be pressable on the old plan while it is still being replaced.
        setSubmitting(false);
      }
      return;
    }
    showSuccessToast(t(isProject ? "plan.toast.projectMoved" : "plan.toast.programMoved"));
    await onDone();
  }

  /** Say what went wrong in the dialog and, where the plan changed under it, reload the plan. */
  async function fail(err: unknown) {
    const status = err instanceof ApiError ? err.status : null;
    if (status === 404) {
      await onDone();
    } else if (status === 409 && isProject) {
      setError(t("plan.move.projectConflict"));
    } else if (status === 400 || status === 403) {
      setError(t(status === 400 ? "plan.move.targetGone" : "plan.move.forbidden"));
      await onRefresh();
    } else {
      setError(saveErrorMessage(err, t, { failedStatus: "plan.move.failedStatus", failed: "plan.move.failed" }));
    }
  }

  return (
    <Modal
      closeButtonProps={{ "aria-label": t("common.action.close") }}
      opened
      onClose={onClose}
      title={t(isProject ? "plan.move.projectTitle" : "plan.move.programTitle")}
      centered
    >
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
        noValidate
      >
        <Stack>
          <Text size="sm" c="dimmed">
            {t(isProject ? "plan.move.projectLine" : "plan.move.programLine", { name: node.name, parent: parentName })}
          </Text>
          {noTargets ? (
            <Text size="sm">{t(isProject ? "plan.move.noProgramTargets" : "plan.move.noStreamTargets")}</Text>
          ) : (
            <Select
              label={t(isProject ? "plan.move.programLabel" : "plan.move.streamLabel")}
              placeholder={t(isProject ? "plan.move.pickProgram" : "plan.move.pickStream")}
              nothingFoundMessage={t("plan.move.nothingFound")}
              data={data}
              value={picked}
              onChange={(next) => {
                setValue(next);
                setFieldError(null);
                setError(null);
              }}
              error={fieldError}
              searchable
              allowDeselect={false}
              data-autofocus
            />
          )}
          {shownError && <FormErrorAlert>{shownError}</FormErrorAlert>}
          <Group justify="flex-end" gap="sm">
            <Button type="button" variant="default" onClick={onClose} disabled={submitting}>
              {t("common.action.cancel")}
            </Button>
            <Button type="submit" loading={submitting} disabled={noTargets || forbidden}>
              {t("plan.move.submit")}
            </Button>
          </Group>
        </Stack>
      </form>
    </Modal>
  );
}
