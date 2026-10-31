import { useState } from "react";
import { Group, Modal, Stack } from "@mantine/core";
import { useForm } from "@mantine/form";
import { useTranslation } from "react-i18next";
import { ApiError } from "../api/http";
import { createWorkStream, updateWorkStream, type PlanWorkStream } from "../api/plan";
import PlanDateInput from "./PlanDateInput";
import PlanNodeFields from "./PlanNodeFields";
import RegistryEditorActions from "./RegistryEditorActions";
import {
  EMPTY_WORK_STREAM_FORM,
  planSaveErrorMessage,
  toWorkStreamBody,
  toWorkStreamFormValues,
  workStreamFormValidation,
  type WorkStreamFormValues,
} from "../utils/planForm";
import { showSuccessToast } from "../utils/toast";

/**
 * Create (target null) / edit (target set) a work stream: name, description, the owner and the stream's dates. An end date
 * means the stream is CLOSED (it still takes programs); clearing it reopens it. A name clash (409) marks the name field.
 */
export default function WorkStreamEditorModal({
  target,
  onClose,
  onSaved,
}: {
  target: PlanWorkStream | null;
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const { t } = useTranslation();
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const form = useForm<WorkStreamFormValues>({
    initialValues: target ? toWorkStreamFormValues(target) : EMPTY_WORK_STREAM_FORM,
    validate: workStreamFormValidation(t),
  });

  async function save(values: WorkStreamFormValues) {
    setError(null);
    setSubmitting(true);
    try {
      if (target) {
        await updateWorkStream(target.id, toWorkStreamBody(values));
        showSuccessToast(t("plan.workStream.toast.saved"));
      } else {
        await createWorkStream(toWorkStreamBody(values));
        showSuccessToast(t("plan.workStream.toast.created"));
      }
      await onSaved();
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        form.setFieldError("name", t("plan.workStream.saveConflict"));
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
      title={target ? t("plan.workStream.editTitle") : t("plan.workStream.createTitle")}
      centered
    >
      <form onSubmit={form.onSubmit(save)} noValidate>
        <Stack>
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
          <Group grow align="flex-start">
            <PlanDateInput label={t("common.field.startDate")} withAsterisk {...form.getInputProps("startDate")} />
            <PlanDateInput
              label={t("common.field.endDate")}
              description={t("plan.workStream.endDateHint")}
              clearable
              {...form.getInputProps("endDate")}
            />
          </Group>
          <RegistryEditorActions error={error} submitting={submitting} isEdit={Boolean(target)} onClose={onClose} gap="sm" />
        </Stack>
      </form>
    </Modal>
  );
}
