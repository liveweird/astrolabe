import { useState } from "react";
import { Modal, Stack, TextInput } from "@mantine/core";
import { useForm } from "@mantine/form";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { ApiError } from "../api/http";
import { createPerson, updatePerson, type PersonResponse } from "../api/people";
import { getUser } from "../api/users";
import LoadingBlock from "./LoadingBlock";
import RegistryEditorActions from "./RegistryEditorActions";
import UserSelect from "./UserSelect";
import {
  EMPTY_PERSON_FORM,
  MAX_PERSON_EMAIL_LENGTH,
  MAX_PERSON_NAME_LENGTH,
  personFormValidation,
  personSaveErrorMessage,
  toPersonBody,
  toPersonFormValues,
  type PersonFormValues,
} from "../utils/personForm";
import { showSuccessToast } from "../utils/toast";

/**
 * Create (target null) / edit (target set) — one modal: the name, the optional email and the optional login (an Astrolabe
 * account the person signs in with). ADMIN-only; a person without a login is a valid owner (an external one).
 */
type EditorProps = {
  target: PersonResponse | null;
  onClose: () => void;
  onSaved: (saved: PersonResponse | null) => Promise<void>;
};

export default function PersonEditorModal(props: EditorProps) {
  const { t } = useTranslation();
  // The Login pick is labelled in the picker's own `name (email)` format, but a person carries only the login's email: resolve
  // the linked user first (one request) so the prefill and the options read the same. A failed lookup falls back to the email.
  const linkedUserId = props.target?.userId ?? null;
  const login = useQuery({
    queryKey: ["user", linkedUserId],
    queryFn: () => getUser(linkedUserId as number),
    enabled: linkedUserId !== null,
  });
  if (linkedUserId !== null && login.isLoading) {
    return (
      <Modal closeButtonProps={{ "aria-label": t("common.action.close") }} opened onClose={props.onClose} title={t("people.editTitle")} centered>
        <LoadingBlock />
      </Modal>
    );
  }
  return <PersonEditorForm {...props} loginLabel={login.data ? `${login.data.name} (${login.data.email})` : null} />;
}

function PersonEditorForm({ target, onClose, onSaved, loginLabel }: EditorProps & { loginLabel: string | null }) {
  const { t } = useTranslation();
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const form = useForm<PersonFormValues>({
    initialValues: target ? toPersonFormValues(target, loginLabel) : EMPTY_PERSON_FORM,
    validate: personFormValidation(t),
  });

  async function save(values: PersonFormValues) {
    setError(null);
    setSubmitting(true);
    try {
      let saved: PersonResponse | null = null;
      if (target) {
        await updatePerson(target.id, toPersonBody(values));
        showSuccessToast(t("people.toast.saved"));
      } else {
        saved = await createPerson(toPersonBody(values));
        showSuccessToast(t("people.toast.created"));
      }
      await onSaved(saved);
    } catch (err) {
      // The 409 is about the email or the login (each unique among active people) — the server's fixed detail says which;
      // mark that control.
      if (err instanceof ApiError && err.status === 409) {
        if (err.detail?.includes("linked")) form.setFieldError("userId", t("people.saveLoginConflict"));
        else form.setFieldError("email", t("people.saveEmailConflict"));
      } else {
        setError(personSaveErrorMessage(err, t));
      }
      setSubmitting(false);
    }
  }

  return (
    <Modal closeButtonProps={{ "aria-label": t("common.action.close") }} opened onClose={onClose} title={target ? t("people.editTitle") : t("people.createTitle")} centered>
      <form onSubmit={form.onSubmit(save)} noValidate>
        <Stack>
          <TextInput label={t("common.field.name")} maxLength={MAX_PERSON_NAME_LENGTH} data-autofocus {...form.getInputProps("name")} />
          <TextInput label={t("common.field.email")} maxLength={MAX_PERSON_EMAIL_LENGTH} description={t("people.emailHint")} {...form.getInputProps("email")} />
          <UserSelect
            picked={form.values.userId !== null && form.values.userLabel !== null ? { value: form.values.userId, label: form.values.userLabel } : null}
            onPick={(picked) => {
              form.setFieldValue("userId", picked?.value ?? null);
              form.setFieldValue("userLabel", picked?.label ?? null);
              form.clearFieldError("userId");
            }}
            error={form.errors.userId}
          />
          <RegistryEditorActions error={error} submitting={submitting} isEdit={Boolean(target)} onClose={onClose} gap="sm" />
        </Stack>
      </form>
    </Modal>
  );
}
