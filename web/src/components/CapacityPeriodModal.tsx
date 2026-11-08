import { useState } from "react";
import { Alert, Modal, NumberInput, Stack } from "@mantine/core";
import { useForm } from "@mantine/form";
import { useTranslation } from "react-i18next";
import { ApiError } from "../api/http";
import { createCapacityPeriod, updateCapacityPeriod, type CapacityPeriod } from "../api/teams";
import {
  capacityFormValidation,
  capacitySaveErrorMessage,
  EMPTY_CAPACITY_FORM,
  fromCapacityPeriod,
  toCapacityBody,
  type CapacityFormValues,
} from "../utils/capacityForm";
import { showSuccessToast } from "../utils/toast";
import PlanDateInput from "./PlanDateInput";
import RegistryEditorActions from "./RegistryEditorActions";

/**
 * Add (target null) / edit (target set) one capacity period of a team: the date it takes effect (ANY calendar day — a weekend date
 * applies from the next working day), man-days per week, and an optional WIP limit (empty = no limit). The page offers it only with
 * the view's `can.editCapacity`; the server's guard is the rule. A 409 is "another period starts on this date" and marks the date
 * field; everything else is an inline alert.
 */
export default function CapacityPeriodModal({
  teamId,
  target,
  onClose,
  onSaved,
}: {
  teamId: number;
  target: CapacityPeriod | null;
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const { t } = useTranslation();
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const form = useForm<CapacityFormValues>({
    initialValues: target ? fromCapacityPeriod(target) : EMPTY_CAPACITY_FORM,
    validate: capacityFormValidation(t),
  });

  async function save(values: CapacityFormValues) {
    setError(null);
    setSubmitting(true);
    try {
      if (target) await updateCapacityPeriod(target.id, toCapacityBody(values));
      else await createCapacityPeriod(teamId, toCapacityBody(values));
      showSuccessToast(t(target ? "teams.view.toast.periodUpdated" : "teams.view.toast.periodAdded"));
      await onSaved();
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        form.setFieldError("effectiveFrom", t("teams.view.period.dateTaken"));
      } else {
        setError(capacitySaveErrorMessage(err, t));
      }
      setSubmitting(false);
    }
  }

  return (
    <Modal
      closeButtonProps={{ "aria-label": t("common.action.close") }}
      opened
      onClose={onClose}
      title={target ? t("teams.view.period.editTitle") : t("teams.view.period.createTitle")}
      centered
    >
      <form onSubmit={form.onSubmit(save)} noValidate>
        <Stack>
          {target?.source === "FLOW" && (
            <Alert color="gray" variant="light" role="note">
              {target.flowSprintName ? t("flow.capacity.manualOnEdit", { sprint: target.flowSprintName }) : t("flow.capacity.manualOnEditNoSprint")}
            </Alert>
          )}
          <PlanDateInput
            label={t("teams.view.period.effectiveFrom")}
            description={t("teams.view.period.effectiveFromHint")}
            data-autofocus
            {...form.getInputProps("effectiveFrom")}
          />
          <NumberInput
            label={t("teams.view.period.mdPerWeek")}
            description={t("teams.view.period.mdPerWeekHint")}
            min={0}
            max={999999.99}
            step={0.5}
            decimalScale={2}
            allowNegative={false}
            clampBehavior="none"
            {...form.getInputProps("mdPerWeek")}
          />
          <NumberInput
            label={t("teams.view.period.wipLimit")}
            description={t("teams.view.period.wipLimitHint")}
            min={1}
            max={99}
            step={1}
            allowDecimal={false}
            allowNegative={false}
            clampBehavior="none"
            {...form.getInputProps("wipLimit")}
          />
          <RegistryEditorActions error={error} submitting={submitting} isEdit={Boolean(target)} onClose={onClose} gap="sm" />
        </Stack>
      </form>
    </Modal>
  );
}
