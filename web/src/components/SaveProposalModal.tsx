import { useEffect, useRef, useState } from "react";
import { Button, Group, Modal, Stack, Text, TextInput } from "@mantine/core";
import { useForm } from "@mantine/form";
import { useTranslation } from "react-i18next";
import { saveSavedProposal } from "../api/savedProposals";
import { isStaleRevision } from "../api/roadmap";
import type { CrossTeamProposal } from "../api/scheduleProposals";
import { isStaleScope } from "../api/teams";
import { nameRule } from "../utils/formRules";
import { saveErrorMessage } from "../utils/saveError";
import { showSuccessToast } from "../utils/toast";
import FormErrorAlert from "./FormErrorAlert";

/** The server's name limit (`MAX_SAVED_PROPOSAL_NAME_LENGTH`, trimmed 1..100). */
const MAX_NAME_LENGTH = 100;

/** The server refuses a control character in the name (a `400`): said in the form, before the request. */
const CONTROL_CHARACTER = /\p{Cc}/u;

/**
 * "Save proposal" (1.26): a name, then the server re-computes the open run itself and keeps it with the ticked moves (the body carries the
 * run's `revision` and `scopeHash`, never a document). A `409` (the plan moved since the run, nothing stored) is a conflict about the RUN,
 * not the name: the dialog says so inline and offers "Propose again" (the owner closes it and asks for the same teams, ticks kept).
 */
export default function SaveProposalModal({
  run,
  selected,
  onClose,
  onSaved,
  onProposeAgain,
}: {
  run: CrossTeamProposal;
  selected: ReadonlySet<number>;
  onClose: () => void;
  onSaved: () => Promise<void>;
  onProposeAgain: () => void;
}) {
  const { t } = useTranslation();
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [stale, setStale] = useState(false);
  const form = useForm({
    initialValues: { name: "" },
    validate: {
      name: (value) => nameRule(t, "scheduleProposals.saved.nameLength", MAX_NAME_LENGTH)(value) ?? (CONTROL_CHARACTER.test(value.trim()) ? t("scheduleProposals.saved.nameInvalid") : null),
    },
  });
  // The dialog cannot be closed while the save is on its way (a late answer would land on a closed dialog); a refused save hands the focus to the way on.
  const close = () => {
    if (!submitting) onClose();
  };
  const againRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (stale) againRef.current?.focus();
  }, [stale]);

  async function save({ name }: { name: string }) {
    setError(null);
    setSubmitting(true);
    try {
      await saveSavedProposal({
        name: name.trim(),
        asOf: run.asOf,
        teamIds: run.teams.map((team) => team.teamId),
        expectedRevision: run.revision,
        scopeHash: run.scopeHash,
        selectedMilestoneIds: [...selected].sort((a, b) => a - b),
      });
      showSuccessToast(t("scheduleProposals.saved.toast.saved"));
      await onSaved();
    } catch (err) {
      if (isStaleRevision(err) || isStaleScope(err)) setStale(true);
      else
        setError(
          saveErrorMessage(err, t, {
            tooManyRequests: "common.error.tooManyRequests",
            forbidden: "scheduleProposals.saved.saveForbidden",
            notFound: "scheduleProposals.gone",
            invalid: "scheduleProposals.saved.saveInvalid",
            failedStatus: "common.error.saveFailedStatus",
            failed: "common.error.saveFailedNetwork",
          }),
        );
      setSubmitting(false);
    }
  }

  return (
    <Modal closeButtonProps={{ "aria-label": t("common.action.close"), disabled: submitting }} opened onClose={close} title={t("scheduleProposals.saved.saveTitle")} centered>
      <form onSubmit={form.onSubmit(save)} noValidate>
        <Stack>
          <Text size="sm" c="dimmed">
            {t("scheduleProposals.saved.saveIntro")}
          </Text>
          <TextInput label={t("common.field.name")} maxLength={MAX_NAME_LENGTH} data-autofocus disabled={stale} {...form.getInputProps("name")} />
          {stale && <FormErrorAlert>{t("scheduleProposals.saved.saveStale")}</FormErrorAlert>}
          {error && <FormErrorAlert>{error}</FormErrorAlert>}
          <Group justify="flex-end" gap="sm">
            <Button type="button" variant="default" onClick={close} disabled={submitting}>
              {t("common.action.cancel")}
            </Button>
            {stale ? (
              <Button ref={againRef} type="button" onClick={onProposeAgain}>
                {t("scheduleProposals.saved.proposeAgain")}
              </Button>
            ) : (
              <Button type="submit" loading={submitting}>
                {t("scheduleProposals.saved.save")}
              </Button>
            )}
          </Group>
        </Stack>
      </form>
    </Modal>
  );
}
