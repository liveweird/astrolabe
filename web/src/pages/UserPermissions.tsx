import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Link as RouterLink, Navigate, useNavigate, useParams } from "react-router-dom";
import { Button, Group, Paper, Stack, Switch, Text } from "@mantine/core";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ApiError } from "../api/http";
import { useAdmin } from "../auth";
import { getUser, PERMISSION_TEXT, PERMISSIONS, type Permission, updateUserPermissions } from "../api/users";
import EditPageLoadState from "../components/EditPageLoadState";
import { showSuccessToast } from "../utils/toast";
import { loadErrorMessage, saveErrorMessage } from "../utils/saveError";
import PageHeader from "../components/PageHeader";
import { FORM_MAX_WIDTH } from "../utils/layout";
import { usersPath } from "../utils/userLinks";
import FormErrorAlert from "../components/FormErrorAlert";

/**
 * The per-user permissions editor (the `UserFeatures` shape): one switch per permission (checked = GRANTED, the
 * opposite polarity of the feature flags' disabled set), saved as a wholesale replace via
 * PUT /users/{id}/permissions. ADMIN-only; reached from the users table's row menu.
 */
export default function UserPermissions() {
  const { t } = useTranslation();
  const admin = useAdmin();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const params = useParams<{ id: string }>();
  const id = Number(params.id);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  // The admin's unsaved toggles; the effective state derives from the loaded user + these.
  const [overrides, setOverrides] = useState<Partial<Record<Permission, boolean>>>({});

  const idIsValid = Number.isFinite(id) && id > 0;

  const { data, isLoading, isError, error: fetchError } = useQuery({
    queryKey: ["user", id],
    queryFn: () => getUser(id),
    enabled: idIsValid && admin,
    retry: false,
  });

  const granted: Record<Permission, boolean> | null =
    data == null
      ? null
      : (Object.fromEntries(
          PERMISSIONS.map((p) => [p, overrides[p] ?? data.permissions.includes(p)]),
        ) as Record<Permission, boolean>);

  if (!idIsValid) return <Navigate to={usersPath} replace />;

  async function onSave() {
    if (granted == null) return;
    setError(null);
    setSubmitting(true);
    try {
      // A wholesale PUT: grants this page has no switch for (a newer server) are carried over, never silently revoked.
      const unlisted = (data?.permissions ?? []).filter((p) => !PERMISSIONS.includes(p));
      await updateUserPermissions(id, [...PERMISSIONS.filter((p) => granted[p]), ...unlisted]);
      await queryClient.invalidateQueries({ queryKey: ["users"] });
      await queryClient.invalidateQueries({ queryKey: ["user", id] });
      showSuccessToast(t("users.toast.permissionsSaved"));
      navigate(usersPath, { replace: true });
    } catch (err) {
      setError(
        saveErrorMessage(err, t, {
          notFound: "users.userNotFound",
          failedStatus: "users.permissionsFailedStatus",
          failed: "users.permissionsFailedNetwork",
        }),
      );
    } finally {
      setSubmitting(false);
    }
  }

  const notFound = isError && fetchError instanceof ApiError && fetchError.status === 404;

  return (
    <Stack gap="md">
      <PageHeader title={t("users.permissionsTitle")} backTo={{ to: usersPath, label: t("users.title") }} />
      <Paper withBorder p="xl" maw={FORM_MAX_WIDTH}>
        <Stack>
          {isLoading || isError || granted == null ? (
            <EditPageLoadState
              isLoading={isLoading || (!isError && granted == null)}
              message={notFound ? t("users.userNotFound") : loadErrorMessage(fetchError, t)}
              backTo={usersPath}
              backLabel={t("users.backToUsers")}
            />
          ) : (
            <Stack>
              {data && (
                <Text c="dimmed" size="sm">
                  {t("users.permissionsHint", { name: data.name, email: data.email })}
                </Text>
              )}
              {PERMISSIONS.map((p) => (
                <Switch
                  key={p}
                  label={t(PERMISSION_TEXT[p].label)}
                  description={t(PERMISSION_TEXT[p].hint)}
                  checked={granted[p]}
                  onChange={(e) => {
                    const value = e.currentTarget.checked;
                    setOverrides((prev) => ({ ...prev, [p]: value }));
                  }}
                />
              ))}
              {error && <FormErrorAlert>{error}</FormErrorAlert>}
              <Group justify="flex-end" gap="sm">
                <Button component={RouterLink} to={usersPath} variant="default">
                  {t("common.action.cancel")}
                </Button>
                <Button onClick={onSave} loading={submitting}>
                  {t("common.action.save")}
                </Button>
              </Group>
            </Stack>
          )}
        </Stack>
      </Paper>
    </Stack>
  );
}
