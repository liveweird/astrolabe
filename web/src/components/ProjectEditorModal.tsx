import { useState } from "react";
import { Fieldset, Group, Modal, Stack, Text } from "@mantine/core";
import { useForm } from "@mantine/form";
import { useTranslation } from "react-i18next";
import { ApiError } from "../api/http";
import { createProject, setProjectTargetWindow, updateProject, updateProjectDetails } from "../api/plan";
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
  type ProjectEditTarget,
  type ProjectFormValues,
} from "../utils/planForm";
import { showSuccessToast } from "../utils/toast";

/**
 * Create (target null, under [program]) / edit (target set) a project. The modal has two independently permitted parts, because
 * the server guards them differently: the FIELDS (name, description, owner — `can.edit`, the owner chain) and the TARGET WINDOW
 * (`can.editTargetWindow` — an administrator, an owner ABOVE the project or a roadmap editor, never the project's own owner).
 * Each part is enabled by its own flag. A combined edit saves both parts in one request. A creator is always a window editor.
 */
export default function ProjectEditorModal({
  program,
  target,
  onClose,
  onSaved,
}: {
  program: { id: number; name: string };
  target: ProjectEditTarget | null;
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
  const [initial] = useState(() => ({
    fields: JSON.stringify(toProjectUpdateBody(form.values)),
    window: JSON.stringify(toTargetWindowBody(form.values)),
  }));

  async function saveExisting(project: ProjectEditTarget, values: ProjectFormValues): Promise<boolean> {
    const fields = toProjectUpdateBody(values);
    const window = toTargetWindowBody(values);
    const fieldsChanged = canEditFields && JSON.stringify(fields) !== initial.fields;
    const windowChanged = canEditWindow && JSON.stringify(window) !== initial.window;
    if (fieldsChanged && windowChanged) {
      await updateProjectDetails(project.id, { ...fields, ...window });
    } else if (fieldsChanged) {
      await updateProject(project.id, fields);
    } else if (windowChanged) {
      await setProjectTargetWindow(project.id, window);
    }
    return fieldsChanged || windowChanged;
  }

  async function save(values: ProjectFormValues) {
    if (submitting) return;
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
      withCloseButton={!submitting}
      closeOnEscape={!submitting}
      closeOnClickOutside={!submitting}
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
