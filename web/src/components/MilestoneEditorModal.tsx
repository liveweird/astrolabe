import { useState } from "react";
import { Modal, NumberInput, Stack, Text } from "@mantine/core";
import { useForm } from "@mantine/form";
import { useTranslation } from "react-i18next";
import { ApiError } from "../api/http";
import { createMilestone, updateMilestone, type ProjectMilestone } from "../api/milestones";
import {
  EMPTY_MILESTONE_FORM,
  MAX_MILESTONE_DESCRIPTION_LENGTH,
  MAX_MILESTONE_NAME_LENGTH,
  milestoneFormValidation,
  milestoneSaveErrorMessage,
  toMilestoneBody,
  toMilestoneFormValues,
  type MilestoneFormValues,
} from "../utils/milestoneForm";
import { showSuccessToast } from "../utils/toast";
import RegistryEditorActions from "./RegistryEditorActions";
import RegistryMetadataFields from "./RegistryMetadataFields";
import TeamSelect from "./TeamSelect";

/**
 * Create (target null, under [project]) / edit (target set) a milestone's PLAN fields: name, description, its one team and the
 * man-day estimate. There are no dates here, for anyone: a new milestone is always unscheduled, and the dates are the team's
 * manager's (the schedule dialog or a drag). Changing the team keeps the dates — the new team's manager inherits the bar.
 * A 409 is the name clash within the project and marks the name field; everything else is an inline alert.
 */
export default function MilestoneEditorModal({
  project,
  target,
  onClose,
  onSaved,
}: {
  project: { id: number; name: string };
  target: ProjectMilestone | null;
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const { t } = useTranslation();
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const form = useForm<MilestoneFormValues>({
    initialValues: target ? toMilestoneFormValues(target) : EMPTY_MILESTONE_FORM,
    validate: milestoneFormValidation(t),
  });

  async function save(values: MilestoneFormValues) {
    setError(null);
    setSubmitting(true);
    try {
      if (target) await updateMilestone(target.id, toMilestoneBody(values));
      else await createMilestone(project.id, toMilestoneBody(values));
      showSuccessToast(t(target ? "project.toast.milestoneSaved" : "project.toast.milestoneCreated"));
      await onSaved();
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        form.setFieldError("name", t("project.milestone.saveConflict"));
      } else {
        setError(milestoneSaveErrorMessage(err, t));
      }
      setSubmitting(false);
    }
  }

  return (
    <Modal
      closeButtonProps={{ "aria-label": t("common.action.close") }}
      opened
      onClose={onClose}
      title={target ? t("project.milestone.editTitle") : t("project.milestone.createTitle")}
      centered
    >
      <form onSubmit={form.onSubmit(save)} noValidate>
        <Stack>
          <Text size="sm" c="dimmed">
            {t("project.milestone.parentLine", { name: project.name })}
          </Text>
          <RegistryMetadataFields
            nameMaxLength={MAX_MILESTONE_NAME_LENGTH}
            descriptionMaxLength={MAX_MILESTONE_DESCRIPTION_LENGTH}
            descriptionLength={form.values.description.length}
            nameInputProps={form.getInputProps("name")}
            descriptionInputProps={form.getInputProps("description")}
          />
          <TeamSelect
            picked={form.values.teamId !== null && form.values.teamLabel !== null ? { value: form.values.teamId, label: form.values.teamLabel } : null}
            onPick={(picked) => {
              form.setFieldValue("teamId", picked?.value ?? null);
              form.setFieldValue("teamLabel", picked?.label ?? null);
              form.clearFieldError("teamId");
            }}
            error={form.errors.teamId}
          />
          <NumberInput
            label={t("common.field.estimate")}
            description={t("project.milestone.estimateHint")}
            min={0}
            max={999999.99}
            step={0.25}
            decimalScale={2}
            allowNegative={false}
            {...form.getInputProps("estimate")}
          />
          <RegistryEditorActions error={error} submitting={submitting} isEdit={Boolean(target)} onClose={onClose} gap="sm" />
        </Stack>
      </form>
    </Modal>
  );
}
