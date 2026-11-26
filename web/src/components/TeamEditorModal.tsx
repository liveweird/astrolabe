import { useState } from "react";
import { Modal, Stack } from "@mantine/core";
import { useForm } from "@mantine/form";
import { useTranslation } from "react-i18next";
import { ApiError } from "../api/http";
import { createTeam, updateTeam, type TeamResponse } from "../api/teams";
import { useTeamOptions } from "../hooks/useTeamOptions";
import PersonSelect from "./PersonSelect";
import RegistryEditorActions from "./RegistryEditorActions";
import RegistryMetadataFields from "./RegistryMetadataFields";
import TeamColourField from "./TeamColourField";
import {
  EMPTY_TEAM_FORM,
  MAX_TEAM_DESCRIPTION_LENGTH,
  MAX_TEAM_NAME_LENGTH,
  teamFormValidation,
  teamSaveErrorMessage,
  toTeamBody,
  toTeamFormValues,
  type TeamFormValues,
} from "../utils/teamForm";
import { leastUsedColour } from "../utils/teamColours";
import { showSuccessToast } from "../utils/toast";

/**
 * Create (target null) / edit (target set) — one modal, the same field block (the shared
 * registry shape) plus the optional Manager (a person of the people directory; the manager's team-scoped rights arrive with the planning
 * increments).
 */
export default function TeamEditorModal({
  target,
  onClose,
  onSaved,
}: {
  target: TeamResponse | null;
  onClose: () => void;
  onSaved: (saved: TeamResponse | null) => Promise<void>;
}) {
  const { t } = useTranslation();
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const form = useForm<TeamFormValues>({
    initialValues: target ? toTeamFormValues(target) : EMPTY_TEAM_FORM,
    validate: teamFormValidation(t),
  });
  // A NEW team shows (and sends) the least-used colour until a pick; before the teams are read nothing is preselected and the server's own rule applies.
  const { teams, settled } = useTeamOptions();
  const colour = form.values.colour ?? (target === null && settled ? leastUsedColour(teams.map((team) => team.colour)) : null);

  // An EDIT sends the colour only when the user changed it: the prefill comes from a cached read, and an untouched colour must not overwrite one
  // another administrator set meanwhile (a PUT that omits it keeps the stored one). A NEW team sends what the field shows.
  const sentColour = target === null ? colour : colour !== target.colour ? colour : null;

  async function save(values: TeamFormValues) {
    setError(null);
    setSubmitting(true);
    try {
      let saved: TeamResponse | null = null;
      if (target) {
        await updateTeam(target.id, toTeamBody({ ...values, colour: sentColour }));
        showSuccessToast(t("teams.toast.saved"));
      } else {
        saved = await createTeam(toTeamBody({ ...values, colour: sentColour }));
        showSuccessToast(t("teams.toast.created"));
      }
      await onSaved(saved);
    } catch (err) {
      // The 409 is about THIS control (the case-insensitive name clash) — mark the field.
      if (err instanceof ApiError && err.status === 409) {
        form.setFieldError("name", t("teams.saveConflict"));
      } else {
        setError(teamSaveErrorMessage(err, t));
      }
      setSubmitting(false);
    }
  }

  return (
    <Modal closeButtonProps={{ "aria-label": t("common.action.close") }} opened onClose={onClose} title={target ? t("teams.editTitle") : t("teams.createTitle")} centered>
      <form onSubmit={form.onSubmit(save)} noValidate>
        <Stack>
          <RegistryMetadataFields
            nameMaxLength={MAX_TEAM_NAME_LENGTH}
            descriptionMaxLength={MAX_TEAM_DESCRIPTION_LENGTH}
            descriptionLength={form.values.description.length}
            nameInputProps={form.getInputProps("name")}
            descriptionInputProps={form.getInputProps("description")}
          />
          <PersonSelect
            label={t("teams.manager")}
            description={t("teams.managerHint")}
            placeholder={t("teams.pickManager")}
            clearLabel={t("teams.clearManager")}
            picked={form.values.managerPersonId !== null && form.values.managerLabel !== null ? { value: form.values.managerPersonId, label: form.values.managerLabel } : null}
            onPick={(picked) => {
              form.setFieldValue("managerPersonId", picked?.value ?? null);
              form.setFieldValue("managerLabel", picked?.label ?? null);
            }}
          />
          <TeamColourField value={colour} onChange={(picked) => form.setFieldValue("colour", picked)} teams={teams} selfId={target?.id ?? null} />
          <RegistryEditorActions error={error} submitting={submitting} isEdit={Boolean(target)} onClose={onClose} gap="sm" />
        </Stack>
      </form>
    </Modal>
  );
}
