import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router-dom";
import { Button, Group, Paper, PasswordInput, Stack } from "@mantine/core";
import { useForm } from "@mantine/form";
import { changeUserPassword } from "../api/users";
import { clearSession, getUserId } from "../api/session";
import { flagSignedOut } from "../auth";
import { saveErrorMessage } from "../utils/saveError";
import { showSuccessToast } from "../utils/toast";
import { newPasswordValidation } from "../utils/userForm";
import PageHeader from "../components/PageHeader";
import { FORM_MAX_WIDTH } from "../utils/layout";
import FormErrorAlert from "../components/FormErrorAlert";

type Values = { currentPassword: string; password: string; confirm: string };

/** Every user's self-service password change (the current password is always required). */
export default function ChangePassword() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const form = useForm<Values>({
    initialValues: { currentPassword: "", password: "", confirm: "" },
    validate: {
      currentPassword: (v) => (v ? null : t("users.validation.currentPasswordRequired")),
      ...newPasswordValidation(t),
    },
  });

  async function onSubmit(values: Values) {
    const userId = getUserId();
    if (userId === null) return;
    setError(null);
    setSubmitting(true);
    try {
      await changeUserPassword(userId, {
        password: values.password,
        currentPassword: values.currentPassword,
      });
      showSuccessToast(t("users.toast.passwordChanged"));
      // The change bumped the credential revision on the server, which ends EVERY outstanding access and refresh token
      // of this account, this device's included: sign out locally and explicitly (no /logout call - nothing is left to
      // revoke, and the stale access token would only 401). Like UserMenu's sign-out, the explicit navigation commits the
      // cleared session and /login together, so no broadcast and no saved return destination.
      clearSession();
      flagSignedOut("passwordChanged");
      navigate("/login", { replace: true });
    } catch (err) {
      setError(
        saveErrorMessage(err, t, {
          forbidden: "users.wrongCurrentPassword",
          failedStatus: "users.changeFailedStatus",
          failed: "users.changeFailedNetwork",
        }),
      );
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Stack gap="md">
      <PageHeader title={t("users.changePasswordTitle")} />
      <Paper withBorder p="xl" maw={FORM_MAX_WIDTH}>
        <form onSubmit={form.onSubmit(onSubmit)} noValidate>
          <Stack>
            <PasswordInput
              label={t("users.currentPassword")}
              autoComplete="current-password"
              required
              {...form.getInputProps("currentPassword")}
            />
            <PasswordInput
              label={t("users.newPassword")}
              autoComplete="new-password"
              required
              {...form.getInputProps("password")}
            />
            <PasswordInput
              label={t("users.confirmPassword")}
              autoComplete="new-password"
              required
              {...form.getInputProps("confirm")}
            />
            {error && (
              <FormErrorAlert>
                {error}
              </FormErrorAlert>
            )}
            <Group justify="flex-end">
              <Button type="submit" loading={submitting}>
                {t("common.action.save")}
              </Button>
            </Group>
          </Stack>
        </form>
      </Paper>
    </Stack>
  );
}
