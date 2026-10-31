import { useState } from "react";
import { Modal, Stack, Text } from "@mantine/core";
import { useForm } from "@mantine/form";
import { useTranslation } from "react-i18next";
import { ApiError } from "../api/http";
import { createProgram, updateProgram, type PlanProgram } from "../api/plan";
import PlanNodeFields from "./PlanNodeFields";
import RegistryEditorActions from "./RegistryEditorActions";
import {
  EMPTY_PROGRAM_FORM,
  planSaveErrorMessage,
  programFormValidation,
  toNodeFormValues,
  toProgramBody,
  type PlanNodeFormValues,
} from "../utils/planForm";
import { showSuccessToast } from "../utils/toast";

/**
 * Create (target null, under [workStream]) / edit (target set) a program: name, description and the owner. The parent never
 * changes (no reparenting in 0.2), so an edit shows no work stream picker. A name clash (409, names are global) marks the name.
 */
export default function ProgramEditorModal({
  workStream,
  target,
  onClose,
  onSaved,
}: {
  workStream: { id: number; name: string };
  target: PlanProgram | null;
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const { t } = useTranslation();
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const form = useForm<PlanNodeFormValues>({
    initialValues: target ? toNodeFormValues(target) : EMPTY_PROGRAM_FORM,
    validate: programFormValidation(t),
  });

  async function save(values: PlanNodeFormValues) {
    setError(null);
    setSubmitting(true);
    try {
      if (target) {
        await updateProgram(target.id, toProgramBody(values));
        showSuccessToast(t("plan.program.toast.saved"));
      } else {
        await createProgram(workStream.id, toProgramBody(values));
        showSuccessToast(t("plan.program.toast.created"));
      }
      await onSaved();
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        form.setFieldError("name", t("plan.program.saveConflict"));
      } else {
        setError(planSaveErrorMessage(err, t));
      }
      setSubmitting(false);
    }
  }

  return (
    <Modal
      closeButtonProps={{ "aria-label": t("common.action.close") }}
      opened
      onClose={onClose}
      title={target ? t("plan.program.editTitle") : t("plan.program.createTitle")}
      centered
    >
      <form onSubmit={form.onSubmit(save)} noValidate>
        <Stack>
          <Text size="sm" c="dimmed">
            {t("plan.program.parentLine", { name: workStream.name })}
          </Text>
          <PlanNodeFields
            values={form.values}
            nameInputProps={form.getInputProps("name")}
            descriptionInputProps={form.getInputProps("description")}
            ownerError={form.errors.ownerPersonId}
            onPickOwner={(picked) => {
              form.setFieldValue("ownerPersonId", picked?.value ?? null);
              form.setFieldValue("ownerLabel", picked?.label ?? null);
              form.clearFieldError("ownerPersonId");
            }}
          />
          <RegistryEditorActions error={error} submitting={submitting} isEdit={Boolean(target)} onClose={onClose} gap="sm" />
        </Stack>
      </form>
    </Modal>
  );
}
