import { useState, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { Button, Modal, PasswordInput, Select, Stack, Switch, TagsInput, Text, TextInput } from "@mantine/core";
import { useForm } from "@mantine/form";
import { ApiError } from "../api/http";
import {
  createJiraConnection,
  testJiraConnection,
  testJiraConnectionAdHoc,
  updateJiraConnection,
  type JiraAuthScheme,
  type JiraConnection,
  type JiraTestResult,
} from "../api/jira";
import {
  EMPTY_JIRA_FORM,
  fromJiraConnection,
  jiraFormValidation,
  jiraSaveErrorMessage,
  jiraTestErrorMessage,
  MAX_API_TOKEN_LENGTH,
  MAX_JIRA_CONNECTION_NAME_LENGTH,
  MAX_PROJECT_KEYS,
  probeSettingsDiffer,
  toJiraConnectionRequest,
  type JiraFormValues,
} from "../utils/jiraForm";
import { showSuccessToast } from "../utils/toast";
import ConnectionTestResults from "./ConnectionTestResults";
import ConnectionTestStatus from "./ConnectionTestStatus";
import FormErrorAlert from "./FormErrorAlert";
import PollingFields from "./PollingFields";
import RegistryEditorActions from "./RegistryEditorActions";

/** The fields the server requires of a probe's body (`validateJiraConnection` checks the name too); the rest of the form may be incomplete. */
const PROBE_FIELDS = ["name", "siteUrl", "email", "apiToken", "projectKeys"] as const;

/**
 * Create (target null) / edit (target set) a Jira connection, in one modal (the registry shape). The site is the connection's identity:
 * read-only once it exists (a PUT with another one is a 409). The API token is WRITE-ONLY - never pre-filled, shown or logged; on edit a
 * blank field keeps the stored token (`hasApiToken` says one is there). The Test-connection button probes with the form's values (an
 * ad-hoc call, the token in the body) unless editing with a blank token, which probes the STORED connection with its stored token.
 */
export default function JiraConnectionEditorModal({
  target,
  onClose,
  onSaved,
}: {
  target: JiraConnection | null;
  onClose: () => void;
  onSaved: (saved: JiraConnection | null) => Promise<void>;
}) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<ReactNode>(null);
  const [testing, setTesting] = useState(false);
  const [testError, setTestError] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<JiraTestResult | null>(null);

  const isEdit = target !== null;
  // `hasApiToken` is all the server ever says about the token: "leave blank to keep" only when one is stored.
  const tokenHint = !isEdit ? t("jira.field.apiTokenHint") : target.hasApiToken ? t("jira.field.apiTokenKeep") : t("jira.field.apiTokenMissing");
  const form = useForm<JiraFormValues>({
    initialValues: target ? fromJiraConnection(target) : EMPTY_JIRA_FORM,
    validate: jiraFormValidation(t, isEdit),
  });

  async function save(values: JiraFormValues) {
    setError(null);
    setSubmitting(true);
    try {
      let saved: JiraConnection | null = null;
      if (target) {
        await updateJiraConnection(target.id, toJiraConnectionRequest(values));
        // A new token, account, scheme or key set clears the last verdict (the server's rule): say it is time to test again.
        showSuccessToast(t(values.apiToken.trim() !== "" || probeSettingsDiffer(values, target) ? "jira.toast.savedRetest" : "jira.toast.saved"));
      } else {
        saved = await createJiraConnection(toJiraConnectionRequest(values));
        showSuccessToast(t("jira.toast.created"));
      }
      await onSaved(saved);
    } catch (err) {
      // The 409 is about THIS control (the case-insensitive name clash) - mark the field.
      if (err instanceof ApiError && err.status === 409) {
        form.setFieldError("name", t("jira.saveConflict"));
      } else if (err instanceof ApiError && err.status === 400 && err.detail) {
        // The server's own sentence says which rule (it never quotes the token): shown under the fixed lead, as the mapping form does.
        setError(
          <>
            <Text size="sm">{jiraSaveErrorMessage(err, t)}</Text>
            <Text size="sm" mt={4}>
              {err.detail}
            </Text>
          </>,
        );
      } else {
        setError(jiraSaveErrorMessage(err, t));
      }
      setSubmitting(false);
    }
  }

  /** Validates only the fields the probe needs - the rest of the form may be incomplete. */
  function probeFieldsValid(): boolean {
    const rules = jiraFormValidation(t, isEdit);
    const messages = PROBE_FIELDS.map((field) => {
      const rule = rules[field] as (value: unknown) => string | null;
      const message = rule(form.values[field]);
      form.setFieldError(field, message ?? undefined);
      return message;
    });
    return messages.every((message) => !message);
  }

  async function runTest() {
    // A stale result must never sit under a new attempt (or a new error).
    setTestError(null);
    setTestResult(null);
    if (!probeFieldsValid()) return;
    setTesting(true);
    try {
      // Editing with the token left blank probes the STORED connection with its stored (decrypted) token.
      const stored = target !== null && form.values.apiToken.trim() === "";
      const result = stored ? await testJiraConnection(target.id) : await testJiraConnectionAdHoc(toJiraConnectionRequest(form.values));
      setTestResult(result);
      // A stored test records the verdict and the discovery on the connection: the pages that show them follow.
      if (stored) void queryClient.invalidateQueries({ queryKey: ["jira"] });
    } catch (err) {
      setTestError(jiraTestErrorMessage(err, t));
    } finally {
      setTesting(false);
    }
  }

  // A stored probe (edit, token field empty) tests the SAVED settings: say so while the form holds other ones.
  const storedProbeDiffers = target !== null && form.values.apiToken.trim() === "" && probeSettingsDiffer(form.values, target);

  return (
    <Modal
      closeButtonProps={{ "aria-label": t("common.action.close") }}
      opened
      onClose={onClose}
      title={isEdit ? t("jira.editTitle") : t("jira.createTitle")}
      size="lg"
      centered
    >
      <form onSubmit={form.onSubmit(save)} noValidate>
        <Stack>
          <TextInput label={t("common.field.name")} maxLength={MAX_JIRA_CONNECTION_NAME_LENGTH} data-autofocus {...form.getInputProps("name")} />
          <TextInput
            label={t("jira.field.siteUrl")}
            description={isEdit ? t("jira.field.siteUrlFixed") : t("jira.field.siteUrlHint")}
            placeholder="https://your-tenant.atlassian.net"
            readOnly={isEdit}
            {...form.getInputProps("siteUrl")}
          />
          <TextInput label={t("jira.field.email")} autoComplete="off" {...form.getInputProps("email")} />
          <PasswordInput
            label={t("jira.field.apiToken")}
            description={tokenHint}
            maxLength={MAX_API_TOKEN_LENGTH}
            autoComplete="new-password"
            {...form.getInputProps("apiToken")}
          />
          <TagsInput
            label={t("jira.field.projectKeys")}
            description={t("jira.field.projectKeysHint")}
            maxTags={MAX_PROJECT_KEYS}
            splitChars={[",", " "]}
            {...form.getInputProps("projectKeys")}
            onChange={(values) => form.setFieldValue("projectKeys", values.map((value) => value.toUpperCase()))}
          />
          <Select
            label={t("jira.field.authScheme")}
            data={(["BASIC", "BEARER"] as const satisfies readonly JiraAuthScheme[]).map((scheme) => ({
              value: scheme,
              label: t(`jira.authScheme.${scheme}`),
            }))}
            allowDeselect={false}
            {...form.getInputProps("authScheme")}
          />
          <Switch label={t("jira.field.enabled")} {...form.getInputProps("enabled", { type: "checkbox" })} />
          <PollingFields form={form} hint={t("jira.field.pollIntervalHint")} />

          <Button type="button" variant="default" loading={testing} onClick={() => void runTest()}>
            {t("jira.testConnection")}
          </Button>
          {storedProbeDiffers && (
            <Text size="sm" c="dimmed" role="note">
              {t("sync.test.savedSettingsNote")}
            </Text>
          )}
          <ConnectionTestStatus result={testResult} />
          {testError && <FormErrorAlert>{testError}</FormErrorAlert>}
          {testResult && <ConnectionTestResults result={testResult} />}

          <RegistryEditorActions error={error} submitting={submitting} isEdit={isEdit} onClose={onClose} gap="sm" />
        </Stack>
      </form>
    </Modal>
  );
}
