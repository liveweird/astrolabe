import { useState } from "react";
import { Modal, Stack, Text } from "@mantine/core";
import { useForm } from "@mantine/form";
import { useTranslation } from "react-i18next";
import { BASELINE_CAP, createBaseline, isBaselineLimit, updateBaseline, type Baseline } from "../api/baselines";
import { ApiError } from "../api/http";
import {
  baselineFormValidation,
  baselineSaveErrorMessage,
  EMPTY_BASELINE_FORM,
  MAX_BASELINE_DESCRIPTION_LENGTH,
  MAX_BASELINE_NAME_LENGTH,
  toBaselineBody,
  toBaselineFormValues,
  type BaselineFormValues,
} from "../utils/baselineForm";
import { showSuccessToast } from "../utils/toast";
import RegistryEditorActions from "./RegistryEditorActions";
import RegistryMetadataFields from "./RegistryMetadataFields";

/**
 * Take a baseline (target null: name + description, then the server copies the plan as it is) / rename one (target set: a full replace of
 * the name and description — the copy itself is immutable). The two 409s differ: the cap reads as a modal-level message (delete one first),
 * a name clash marks the name field.
 */
export default function BaselineEditorModal({
  target,
  onClose,
  onSaved,
  onGone,
}: {
  target: Baseline | null;
  onClose: () => void;
  onSaved: () => Promise<void>;
  /** A rename answered 404 (the baseline was deleted elsewhere): the page reloads its list; the dialog stays open with the message. */
  onGone: () => Promise<void>;
}) {
  const { t } = useTranslation();
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const form = useForm<BaselineFormValues>({
    initialValues: target ? toBaselineFormValues(target) : EMPTY_BASELINE_FORM,
    validate: baselineFormValidation(t),
  });

  async function save(values: BaselineFormValues) {
    const body = toBaselineBody(values);
    // A rename that changes nothing is not a write (it would bump the plan revision for nothing).
    if (target && body.name === target.name && body.description === target.description) {
      onClose();
      return;
    }
    setError(null);
    setSubmitting(true);
    try {
      if (target) {
        await updateBaseline(target.id, body);
        showSuccessToast(t("baselines.toast.saved"));
      } else {
        await createBaseline(body);
        showSuccessToast(t("baselines.toast.taken"));
      }
      await onSaved();
    } catch (err) {
      if (isBaselineLimit(err)) {
        setError(t("baselines.capReached", { max: BASELINE_CAP }));
      } else if (err instanceof ApiError && err.status === 409) {
        // The other 409 is about THIS control (the case-insensitive name clash) — mark the field.
        form.setFieldError("name", t("baselines.saveConflict"));
      } else {
        if (target && err instanceof ApiError && err.status === 404) await onGone();
        setError(baselineSaveErrorMessage(err, t));
      }
      setSubmitting(false);
    }
  }

  return (
    <Modal
      closeButtonProps={{ "aria-label": t("common.action.close") }}
      opened
      onClose={onClose}
      title={target ? t("baselines.renameTitle") : t("baselines.takeTitle")}
      centered
    >
      <form onSubmit={form.onSubmit(save)} noValidate>
        <Stack>
          {!target && (
            <Text size="sm" c="dimmed">
              {t("baselines.takeIntro")}
            </Text>
          )}
          <RegistryMetadataFields
            nameMaxLength={MAX_BASELINE_NAME_LENGTH}
            descriptionMaxLength={MAX_BASELINE_DESCRIPTION_LENGTH}
            descriptionLength={form.values.description.length}
            nameInputProps={form.getInputProps("name")}
            descriptionInputProps={form.getInputProps("description")}
          />
          <RegistryEditorActions
            error={error}
            submitting={submitting}
            isEdit={Boolean(target)}
            onClose={onClose}
            gap="sm"
            submitLabel={target ? undefined : t("baselines.takeBaseline")}
          />
        </Stack>
      </form>
    </Modal>
  );
}
