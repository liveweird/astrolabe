import { useState } from "react";
import { Fieldset, Group, Modal, Stack, Text } from "@mantine/core";
import { useForm } from "@mantine/form";
import { useTranslation } from "react-i18next";
import { ApiError } from "../api/http";
import { createProject, setProjectTargetWindow, updateProject, type PlanProject } from "../api/plan";
import PlanDateInput from "./PlanDateInput";
import PlanNodeFields from "./PlanNodeFields";
import RegistryEditorActions from "./RegistryEditorActions";
import {
  EMPTY_PROJECT_FORM,
  planSaveErrorMessage,
  projectFormValidation,
  toProjectCreateBody,
  toProjectFormValues,
  toProjectUpdateBody,
  toTargetWindowBody,
  type ProjectFormValues,
} from "../utils/planForm";
import { showSuccessToast } from "../utils/toast";

/**
 * Create (target null, under [program]) / edit (target set) a project. The modal has two independently permitted parts, because
 * the server guards them differently: the FIELDS (name, description, owner — `can.edit`, the owner chain) and the TARGET WINDOW
 * (`can.editTargetWindow` — an administrator, an owner ABOVE the project or a roadmap editor, never the project's own owner).
 * Each part is enabled by its own flag and saved by its own PUT, only when changed, fields first. A creator is always a window
 * editor, so a new project carries its window in the create body.
 */
export default function ProjectEditorModal({
  program,
  target,
  onClose,
  onSaved,
}: {
  program: { id: number; name: string };
  target: PlanProject | null;
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const { t } = useTranslation();
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const canEditFields = target?.can.edit ?? true;
  const canEditWindow = target?.can.editTargetWindow ?? true;

  const form = useForm<ProjectFormValues>({
    initialValues: target ? toProjectFormValues(target) : EMPTY_PROJECT_FORM,
    validate: projectFormValidation(t),
  });
  // What the server last accepted for each part: a retry after the second PUT failed never repeats the first.
  const [accepted, setAccepted] = useState(() => ({
    fields: JSON.stringify(toProjectUpdateBody(form.values)),
    window: JSON.stringify(toTargetWindowBody(form.values)),
  }));

  async function saveExisting(project: PlanProject, values: ProjectFormValues): Promise<boolean> {
    let wrote = false;
    const fields = JSON.stringify(toProjectUpdateBody(values));
    if (canEditFields && fields !== accepted.fields) {
      await updateProject(project.id, toProjectUpdateBody(values));
      setAccepted((prev) => ({ ...prev, fields }));
      wrote = true;
    }
    const windowKey = JSON.stringify(toTargetWindowBody(values));
    if (canEditWindow && windowKey !== accepted.window) {
      await setProjectTargetWindow(project.id, toTargetWindowBody(values));
      setAccepted((prev) => ({ ...prev, window: windowKey }));
      wrote = true;
    }
    return wrote;
  }

  async function save(values: ProjectFormValues) {
    setError(null);
    setSubmitting(true);
    try {
      let wrote = true;
      if (target) {
        wrote = await saveExisting(target, values);
      } else {
        await createProject(program.id, toProjectCreateBody(values));
      }
      if (wrote) {
        showSuccessToast(t(target ? "plan.project.toast.saved" : "plan.project.toast.created"));
        await onSaved();
      } else {
        onClose();
      }
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        form.setFieldError("name", t("plan.project.saveConflict"));
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
      title={target ? t("plan.project.editTitle") : t("plan.project.createTitle")}
      centered
    >
      <form onSubmit={form.onSubmit(save)} noValidate>
        <Stack>
          <Text size="sm" c="dimmed">
            {t("plan.project.parentLine", { name: program.name })}
          </Text>
          {!canEditFields && (
            <Text size="sm" c="dimmed">
              {t("plan.project.fieldsReadOnly")}
            </Text>
          )}
          <PlanNodeFields
            values={form.values}
            nameInputProps={form.getInputProps("name")}
            descriptionInputProps={form.getInputProps("description")}
            ownerError={form.errors.ownerPersonId}
            disabled={!canEditFields}
            onPickOwner={(picked) => {
              form.setFieldValue("ownerPersonId", picked?.value ?? null);
              form.setFieldValue("ownerLabel", picked?.label ?? null);
              form.clearFieldError("ownerPersonId");
            }}
          />
          <Fieldset legend={t("common.field.targetWindow")} disabled={!canEditWindow}>
            <Stack gap="xs">
              <Text size="xs" c="dimmed">
                {canEditWindow ? t("plan.project.windowHint") : t("plan.project.windowReadOnly")}
              </Text>
              <Group grow align="flex-start">
                <PlanDateInput label={t("plan.targetStart")} clearable disabled={!canEditWindow} {...form.getInputProps("targetStart")} />
                <PlanDateInput label={t("plan.targetEnd")} clearable disabled={!canEditWindow} {...form.getInputProps("targetEnd")} />
              </Group>
            </Stack>
          </Fieldset>
          <RegistryEditorActions error={error} submitting={submitting} isEdit={Boolean(target)} onClose={onClose} gap="sm" />
        </Stack>
      </form>
    </Modal>
  );
}
